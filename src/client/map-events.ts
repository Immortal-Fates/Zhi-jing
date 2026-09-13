import type { ApiError, ResourceResponse, SseEvent } from '../../types/api.ts';
import { validateOutline } from '../lib/outline-validator.ts';
import type { KnowledgeMap } from '../../types/domain.ts';

const record = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);
const text = (value: unknown): value is string => typeof value === 'string';
const number = (value: unknown): value is number =>
  typeof value === 'number' && Number.isFinite(value) && value >= 0;

export function isApiError(value: unknown): value is ApiError {
  return record(value) && text(value.code) && text(value.message) && typeof value.retryable === 'boolean';
}

function validResources(value: unknown): boolean {
  return Array.isArray(value) && value.length <= 3 && value.every((r) =>
    record(r) && ['title', 'url', 'contentId', 'contentType', 'author', 'excerpt'].every((k) => text(r[k])) &&
    ['voteUpCount', 'commentCount', 'editTime', 'score'].every((k) => number(r[k])) && Number(r.score) <= 1);
}

export function isResourceResponse(value: unknown): value is ResourceResponse {
  return record(value) && value.ok === true && typeof value.mockMode === 'boolean' &&
    text(value.nodeId) && (value.state === 'ready' || value.state === 'empty') &&
    number(value.weight) && value.weight <= 3 && validResources(value.resources) &&
    (value.state === 'empty' ? (value.resources as unknown[]).length === 0 : (value.resources as unknown[]).length > 0);
}

export function isKnowledgeMap(value: unknown): value is KnowledgeMap {
  if (!record(value) || !validateOutline(value).ok || !text(value.mapId) || !value.mapId ||
    !text(value.progressScope) || !value.progressScope || typeof value.mockMode !== 'boolean' ||
    !number(value.generatedAt) || !number(value.completedNodeCount) || !number(value.failedNodeCount) ||
    !['complete', 'partial'].includes(String(value.status)) || !Array.isArray(value.nodes)) return false;
  const nodesValid = value.nodes.every((node) => {
    if (!record(node)) return false;
    if (node.state === 'error') return isApiError(node.error) && validResources(node.resources) && node.weight === 0;
    return isResourceResponse({ ...node, nodeId: node.id, mockMode: value.mockMode, ok: true });
  });
  const failed = value.nodes.filter((node) => record(node) && node.state === 'error').length;
  return nodesValid && value.completedNodeCount === value.nodes.length && value.failedNodeCount === failed &&
    value.status === (failed ? 'partial' : 'complete');
}

export function decodeMapEvent(name: string, json: string): SseEvent | undefined {
  if (!['outline', 'resource_ready', 'resource_empty', 'resource_error', 'complete', 'generation_error'].includes(name)) {
    return undefined;
  }
  const data: unknown = JSON.parse(json);
  if (!record(data) || !text(data.mapId) || !data.mapId || typeof data.mockMode !== 'boolean') {
    throw new Error('地图事件格式不正确');
  }
  let valid = false;
  if (name === 'outline') {
    valid = validateOutline(data).ok && text(data.progressScope);
  } else if (name === 'generation_error') {
    valid = isApiError(data.error);
  } else if (name === 'complete') {
    valid = (data.status === 'complete' || data.status === 'partial') &&
      number(data.completedNodeCount) && number(data.failedNodeCount) && number(data.generatedAt);
  } else if (name === 'resource_error') {
    valid = text(data.nodeId) && data.state === 'error' && isApiError(data.error) &&
      text(data.errorCode) && Array.isArray(data.resources) && data.resources.length === 0 && data.weight === 0;
  } else {
    valid = isResourceResponse({ ...data, ok: true }) &&
      data.state === (name === 'resource_ready' ? 'ready' : 'empty');
  }
  if (!valid) throw new Error('地图事件格式不正确');
  return { event: name, data } as unknown as SseEvent;
}

export class MapEventDecoder {
  private readonly decoder = new TextDecoder('utf-8', { fatal: true });
  private buffer = '';
  private event = '';
  private data: string[] = [];
  private size = 0;
  private ended = false;

  constructor(private readonly receive: (event: SseEvent) => void) {}

  push(bytes: Uint8Array): void {
    if (this.ended) throw new Error('事件流已关闭');
    this.buffer += this.decoder.decode(bytes, { stream: true });
    this.drain(false);
  }

  finish(): void {
    this.buffer += this.decoder.decode();
    this.drain(true);
    this.ended = true;
    // An event without its terminating blank line is not complete SSE.
    if (this.buffer || this.data.length || this.event) throw new Error('地图连接中断，请重新加载');
  }

  private drain(final: boolean): void {
    while (true) {
      const index = this.buffer.search(/[\r\n]/u);
      if (index < 0) break;
      if (!final && this.buffer[index] === '\r' && index === this.buffer.length - 1) break;
      const line = this.buffer.slice(0, index);
      const count = this.buffer[index] === '\r' && this.buffer[index + 1] === '\n' ? 2 : 1;
      this.buffer = this.buffer.slice(index + count);
      this.line(line);
    }
    if (this.buffer.length + this.size > 1_048_576) throw new Error('地图事件过大');
  }

  private line(line: string): void {
    if (!line) {
      if (this.data.length) {
        const event = decodeMapEvent(this.event, this.data.join('\n'));
        if (event) this.receive(event);
      }
      this.data = [];
      this.event = '';
      this.size = 0;
      return;
    }
    if (line.startsWith(':')) return;
    this.size += line.length;
    if (this.size > 1_048_576) throw new Error('地图事件过大');
    const colon = line.indexOf(':');
    const field = colon < 0 ? line : line.slice(0, colon);
    const raw = colon < 0 ? '' : line.slice(colon + 1);
    const value = raw.startsWith(' ') ? raw.slice(1) : raw;
    if (field === 'event') this.event = value;
    if (field === 'data') this.data.push(value);
  }
}
