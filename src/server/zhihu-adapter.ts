import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

import type { ApiError, ApiErrorCode, ApiErrorResponse } from '../../types/api.ts';
import type { KnowledgeMapOutline, Resource } from '../../types/domain.ts';
import { validateOutline } from '../lib/outline-validator.ts';

const DEFAULT_BASE_URL = 'https://developer.zhihu.com';
const DEFAULT_SEARCH_TIMEOUT_MS = 10_000;
const DEFAULT_OUTLINE_TIMEOUT_MS = 120_000;
const DEFAULT_SEARCH_COUNT = 10;
const MAX_SEARCH_COUNT = 10;
const DEFAULT_MODEL = 'zhida-fast-1p5';

export type MockScenario =
  | 'default'
  | 'empty'
  | 'invalid_json'
  | 'timeout'
  | 'rate_limited'
  | 'quota_exhausted'
  | 'unauthorized';

export interface ZhihuClientOptions {
  baseUrl?: string;
  accessSecret?: string;
  mockMode?: boolean;
  mockScenario?: MockScenario;
  searchTimeoutMs?: number;
  outlineTimeoutMs?: number;
  fetchImpl?: typeof fetch;
  now?: () => number;
}

export interface ZhihuSearchResult {
  resources: Resource[];
  emptyReason?: string;
}

export class ZhihuAdapterError extends Error {
  readonly apiError: ApiError;

  constructor(apiError: ApiError) {
    super(apiError.message);
    this.name = 'ZhihuAdapterError';
    this.apiError = apiError;
  }

  toJSON(): ApiErrorResponse {
    return { ok: false, error: { ...this.apiError } };
  }
}

interface RecordValue {
  [key: string]: unknown;
}

interface ZhihuSearchPayload {
  Code: number;
  Message?: string;
  Data?: {
    Items?: unknown;
    EmptyReason?: unknown;
  } | null;
}

interface ZhihuChatPayload {
  choices?: unknown;
}

function isRecord(value: unknown): value is RecordValue {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function apiError(code: ApiErrorCode, message: string, retryable: boolean): ApiError {
  return { code, message, retryable };
}

function throwAdapterError(code: ApiErrorCode, message: string, retryable: boolean): never {
  throw new ZhihuAdapterError(apiError(code, message, retryable));
}

function getEnvNumber(name: string, fallback: number): number {
  const value = Number(process.env[name]);
  return Number.isInteger(value) && value > 0 && value <= 2_147_483_647 ? value : fallback;
}

function validateTimeout(value: number): number {
  if (!Number.isInteger(value) || value <= 0 || value > 2_147_483_647) {
    throwAdapterError('UPSTREAM_ERROR', '知乎请求超时配置无效', true);
  }
  return value;
}

function resolveBaseUrl(value: string | undefined): URL {
  const baseUrl = value || process.env.ZHIHU_API_BASE_URL || DEFAULT_BASE_URL;
  try {
    const parsed = new URL(baseUrl);
    if (
      (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') ||
      parsed.username ||
      parsed.password
    ) {
      throw new Error('unsupported protocol');
    }
    return parsed;
  } catch {
    throwAdapterError('UPSTREAM_ERROR', '知乎服务地址配置无效', true);
  }
}

function normalizeSearchCount(count: number | undefined): number {
  if (!Number.isFinite(count) || !count || count <= 0) {
    return DEFAULT_SEARCH_COUNT;
  }
  const normalized = Math.floor(count);
  return normalized <= 0 ? DEFAULT_SEARCH_COUNT : Math.min(normalized, MAX_SEARCH_COUNT);
}

function requiredString(item: RecordValue, key: string, path: string): string {
  if (typeof item[key] !== 'string') {
    throwAdapterError('UPSTREAM_ERROR', `知乎搜索响应缺少字段：${path}`, true);
  }
  return item[key] as string;
}

function requiredNumber(item: RecordValue, key: string, path: string): number {
  if (!isFiniteNumber(item[key])) {
    throwAdapterError('UPSTREAM_ERROR', `知乎搜索响应缺少字段：${path}`, true);
  }
  return item[key] as number;
}

export function mapSearchItemToResource(item: unknown, index = 0): Resource {
  if (!isRecord(item)) {
    throwAdapterError('UPSTREAM_ERROR', `知乎搜索响应资源结构无效：Data.Items[${index}]`, true);
  }

  const authorBadge = item.AuthorBadge === undefined
    ? undefined
    : requiredString(item, 'AuthorBadge', `Data.Items[${index}].AuthorBadge`);
  const authorBadgeText = requiredString(
    item,
    'AuthorBadgeText',
    `Data.Items[${index}].AuthorBadgeText`,
  );
  const rankingScore = requiredNumber(
    item,
    'RankingScore',
    `Data.Items[${index}].RankingScore`,
  );

  return {
    title: requiredString(item, 'Title', `Data.Items[${index}].Title`),
    url: requiredString(item, 'Url', `Data.Items[${index}].Url`),
    contentId: requiredString(item, 'ContentID', `Data.Items[${index}].ContentID`),
    contentType: requiredString(item, 'ContentType', `Data.Items[${index}].ContentType`),
    author: requiredString(item, 'AuthorName', `Data.Items[${index}].AuthorName`),
    authorBadge,
    authorBadgeText,
    authorityLevel: requiredString(
      item,
      'AuthorityLevel',
      `Data.Items[${index}].AuthorityLevel`,
    ),
    rankingScore,
    voteUpCount: requiredNumber(
      item,
      'VoteUpCount',
      `Data.Items[${index}].VoteUpCount`,
    ),
    commentCount: requiredNumber(
      item,
      'CommentCount',
      `Data.Items[${index}].CommentCount`,
    ),
    excerpt: requiredString(item, 'ContentText', `Data.Items[${index}].ContentText`),
    editTime: requiredNumber(item, 'EditTime', `Data.Items[${index}].EditTime`),
    score: 0,
  };
}

function mapSearchPayload(payload: unknown): ZhihuSearchResult {
  if (!isRecord(payload) || payload.Code !== 0 || !isRecord(payload.Data)) {
    throwAdapterError('UPSTREAM_ERROR', '知乎搜索响应结构无效', true);
  }

  if (!Array.isArray(payload.Data.Items)) {
    throwAdapterError('UPSTREAM_ERROR', '知乎搜索响应缺少 Data.Items', true);
  }

  return {
    resources: payload.Data.Items.map((item, index) => mapSearchItemToResource(item, index)),
    emptyReason:
      typeof payload.Data.EmptyReason === 'string' ? payload.Data.EmptyReason : undefined,
  };
}

function unwrapCodeBlock(content: string): string {
  const trimmed = content.trim();
  const match = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/iu);
  return match ? match[1].trim() : trimmed;
}

export function extractAnswerContent(payload: unknown): string {
  if (!isRecord(payload) || !Array.isArray(payload.choices)) {
    throwAdapterError('UPSTREAM_ERROR', '知乎直答响应缺少 choices', true);
  }

  const firstChoice = payload.choices[0];
  if (!isRecord(firstChoice) || !isRecord(firstChoice.message)) {
    throwAdapterError('UPSTREAM_ERROR', '知乎直答响应缺少 message', true);
  }

  if (typeof firstChoice.message.content !== 'string') {
    throwAdapterError('UPSTREAM_ERROR', '知乎直答响应缺少 content', true);
  }

  return firstChoice.message.content;
}

export function parseAnswerJson(content: string): unknown {
  const jsonText = unwrapCodeBlock(content);
  if (!jsonText) {
    throwAdapterError('OUTLINE_INVALID', '知乎直答未返回有效 JSON', true);
  }

  try {
    return JSON.parse(jsonText) as unknown;
  } catch {
    throwAdapterError('OUTLINE_INVALID', '知乎直答返回的内容不是有效 JSON', true);
  }
}

export function parseAnswerOutline(payload: unknown): KnowledgeMapOutline {
  const result = validateOutline(parseAnswerJson(extractAnswerContent(payload)));
  if (!result.ok) {
    throwAdapterError('OUTLINE_INVALID', '知乎直答大纲校验失败', true);
  }
  return result.value;
}

function errorFromUpstreamCode(code: unknown): ApiError | undefined {
  if (typeof code !== 'number' && typeof code !== 'string') {
    return undefined;
  }
  switch (Number(code)) {
    case 20001:
      return apiError('UPSTREAM_AUTH', '知乎服务鉴权失败', false);
    case 30001:
      return apiError('UPSTREAM_RATE_LIMITED', '知乎服务请求频率受限', true);
    case 30002:
      return apiError('QUOTA_EXHAUSTED', '知乎服务额度已耗尽', false);
    default:
      return undefined;
  }
}

function errorFromStatus(status: number): ApiError {
  if (status === 401 || status === 403) {
    return apiError('UPSTREAM_AUTH', '知乎服务鉴权失败', false);
  }
  if (status === 408 || status === 504) {
    return apiError('UPSTREAM_TIMEOUT', '知乎服务请求超时', true);
  }
  if (status === 429) {
    return apiError('UPSTREAM_RATE_LIMITED', '知乎服务请求频率受限', true);
  }
  return apiError('UPSTREAM_ERROR', '知乎服务暂时不可用', true);
}

function upstreamError(payload: unknown, status: number): ZhihuAdapterError {
  if (isRecord(payload)) {
    const codeError = errorFromUpstreamCode(payload.Code);
    if (codeError) {
      return new ZhihuAdapterError(codeError);
    }

    if (isRecord(payload.error)) {
      const nestedCodeError = errorFromUpstreamCode(payload.error.code);
      if (nestedCodeError) {
        return new ZhihuAdapterError(nestedCodeError);
      }
    }
  }
  return new ZhihuAdapterError(errorFromStatus(status));
}

async function requestJson(
  fetchImpl: typeof fetch,
  url: URL,
  init: RequestInit,
  timeoutMs: number,
): Promise<unknown> {
  const controller = new AbortController();
  let didTimeout = false;
  const timer = setTimeout(() => {
    didTimeout = true;
    controller.abort();
  }, timeoutMs);

  try {
    const response = await fetchImpl(url, {
      ...init,
      signal: controller.signal,
      cache: 'no-store',
      redirect: 'error',
    });
    let payload: unknown;
    try {
      payload = await response.json();
    } catch (error) {
      if (didTimeout || (error instanceof Error && error.name === 'AbortError')) {
        throw error;
      }
      if (!response.ok) {
        throw upstreamError(undefined, response.status);
      }
      if (!(error instanceof SyntaxError)) {
        throw error;
      }
      throwAdapterError('UPSTREAM_ERROR', '知乎服务返回了无效 JSON', true);
    }

    if (isRecord(payload)) {
      if (
        ('Code' in payload && payload.Code !== 0) ||
        'error' in payload
      ) {
        throw upstreamError(payload, response.status);
      }
    }

    if (!response.ok) {
      throw upstreamError(payload, response.status);
    }

    return payload;
  } catch (error) {
    if (didTimeout || (error instanceof Error && error.name === 'AbortError')) {
      throwAdapterError('UPSTREAM_TIMEOUT', '知乎服务请求超时', true);
    }
    if (error instanceof ZhihuAdapterError) {
      throw error;
    }
    throwAdapterError('UPSTREAM_ERROR', '知乎服务网络请求失败', true);
  } finally {
    clearTimeout(timer);
  }
}

async function readMockFixture<T>(name: string): Promise<T> {
  try {
    const contents = await readFile(resolve(process.cwd(), 'fixtures', name), 'utf8');
    return JSON.parse(contents) as T;
  } catch {
    throwAdapterError('UPSTREAM_ERROR', '知乎 mock 数据无法读取', true);
  }
}

async function mockError(scenario: MockScenario): Promise<never> {
  if (scenario === 'timeout') {
    const fixture = await readMockFixture<{ error: ApiError }>('upstream-timeout.json');
    if (fixture.error?.code !== 'UPSTREAM_TIMEOUT') {
      throwAdapterError('UPSTREAM_ERROR', '知乎 mock 错误 fixture 无效', true);
    }
    throwAdapterError('UPSTREAM_TIMEOUT', '知乎服务请求超时', true);
  }

  const fixtureName =
    scenario === 'rate_limited' ? 'upstream-rate-limited.json' :
    scenario === 'quota_exhausted' ? 'upstream-quota-exhausted.json' :
    'upstream-auth.json';
  const fixture = await readMockFixture<ZhihuSearchPayload>(fixtureName);
  const mappedError = errorFromUpstreamCode(fixture.Code);
  if (!mappedError) {
    throwAdapterError('UPSTREAM_ERROR', '知乎 mock 错误 fixture 无效', true);
  }
  throw new ZhihuAdapterError(mappedError);
}

async function mockSearch(scenario: MockScenario): Promise<ZhihuSearchResult> {
  if (scenario === 'empty') {
    return mapSearchPayload(await readMockFixture<ZhihuSearchPayload>('resources-empty.json'));
  }
  if (
    scenario === 'timeout' ||
    scenario === 'rate_limited' ||
    scenario === 'quota_exhausted' ||
    scenario === 'unauthorized'
  ) {
    return mockError(scenario);
  }
  if (scenario === 'invalid_json') {
    throwAdapterError('UPSTREAM_ERROR', '知乎服务返回了无效 JSON', true);
  }
  return mapSearchPayload(await readMockFixture<ZhihuSearchPayload>('resources-limits.json'));
}

async function mockAnswer(scenario: MockScenario): Promise<KnowledgeMapOutline> {
  if (scenario === 'invalid_json') {
    return parseAnswerOutline(await readMockFixture<ZhihuChatPayload>('outline-invalid.json'));
  }
  if (
    scenario === 'timeout' ||
    scenario === 'rate_limited' ||
    scenario === 'quota_exhausted' ||
    scenario === 'unauthorized'
  ) {
    return mockError(scenario);
  }
  const outline = await readMockFixture<unknown>('outline-calculus.json');
  return parseAnswerOutline({
    choices: [{ message: { content: JSON.stringify(outline) } }],
  });
}

export class ZhihuClient {
  private readonly baseUrl: URL;
  readonly #accessSecret: string;
  private readonly mockMode: boolean;
  private readonly mockScenario: MockScenario;
  private readonly searchTimeoutMs: number;
  private readonly outlineTimeoutMs: number;
  private readonly fetchImpl: typeof fetch;
  private readonly now: () => number;

  constructor(options: ZhihuClientOptions = {}) {
    if (typeof window !== 'undefined') {
      throwAdapterError('UPSTREAM_ERROR', '知乎客户端仅可在服务端使用', true);
    }
    this.mockMode =
      process.env.ZHIJING_MOCK_MODE === 'true' ||
      (options.mockMode ?? process.env.ZHIJING_MOCK_MODE !== 'false');
    this.baseUrl = this.mockMode ? new URL(DEFAULT_BASE_URL) : resolveBaseUrl(options.baseUrl);
    this.#accessSecret = this.mockMode
      ? ''
      : options.accessSecret ?? process.env.ZHIHU_ACCESS_SECRET ?? '';
    this.mockScenario = options.mockScenario ?? 'default';
    this.searchTimeoutMs = validateTimeout(
      options.searchTimeoutMs ?? getEnvNumber('ZHIJING_SEARCH_TIMEOUT_MS', DEFAULT_SEARCH_TIMEOUT_MS),
    );
    this.outlineTimeoutMs = validateTimeout(
      options.outlineTimeoutMs ??
      getEnvNumber('ZHIJING_OUTLINE_TIMEOUT_MS', DEFAULT_OUTLINE_TIMEOUT_MS),
    );
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.now = options.now ?? Date.now;
  }

  async search(query: string, count = DEFAULT_SEARCH_COUNT): Promise<ZhihuSearchResult> {
    if (this.mockMode) {
      const result = await mockSearch(this.mockScenario);
      return { ...result, resources: result.resources.slice(0, normalizeSearchCount(count)) };
    }
    this.requireAccessSecret();

    const url = new URL('/api/v1/content/zhihu_search', this.baseUrl);
    url.search = new URLSearchParams({
      Query: query,
      Count: String(normalizeSearchCount(count)),
    }).toString();

    const payload = await requestJson(
      this.fetchImpl,
      url,
      { method: 'GET', headers: this.headers() },
      this.searchTimeoutMs,
    );
    return mapSearchPayload(payload);
  }

  async answer(prompt: string): Promise<KnowledgeMapOutline> {
    if (this.mockMode) {
      return mockAnswer(this.mockScenario);
    }
    this.requireAccessSecret();

    const url = new URL('/v1/chat/completions', this.baseUrl);
    const payload = await requestJson(
      this.fetchImpl,
      url,
      {
        method: 'POST',
        headers: this.headers(),
        body: JSON.stringify({
          model: DEFAULT_MODEL,
          messages: [{ role: 'user', content: prompt }],
          stream: false,
        }),
      },
      this.outlineTimeoutMs,
    );
    return parseAnswerOutline(payload);
  }

  private requireAccessSecret(): void {
    if (!this.#accessSecret.trim()) {
      throwAdapterError('UPSTREAM_AUTH', '知乎服务凭证未配置', false);
    }
  }

  private headers(): HeadersInit {
    return {
      Authorization: `Bearer ${this.#accessSecret}`,
      'X-Request-Timestamp': String(Math.floor(this.now() / 1000)),
      'Content-Type': 'application/json',
    };
  }
}

export function createZhihuClient(options: ZhihuClientOptions = {}): ZhihuClient {
  return new ZhihuClient(options);
}
