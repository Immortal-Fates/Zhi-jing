import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import test from 'node:test';
import { inspect } from 'node:util';

import {
  createZhihuClient,
  extractAnswerContent,
  mapSearchItemToResource,
  parseAnswerJson,
  parseAnswerOutline,
  ZhihuAdapterError,
} from '../src/server/zhihu-adapter.ts';

delete process.env.ZHIHU_ACCESS_SECRET;
delete process.env.ZHIHU_API_BASE_URL;
delete process.env.ZHIJING_MOCK_MODE;
delete process.env.ZHIJING_OUTLINE_TIMEOUT_MS;
delete process.env.ZHIJING_SEARCH_TIMEOUT_MS;

type FetchCall = {
  input: RequestInfo | URL;
  init?: RequestInit;
};

async function readFixture(name: string): Promise<unknown> {
  return JSON.parse(await readFile(resolve(process.cwd(), 'fixtures', name), 'utf8'));
}

function jsonResponse(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function createFetch(
  responseFactory: (input: RequestInfo | URL, init?: RequestInit) => Response | Promise<Response>,
) {
  const calls: FetchCall[] = [];
  const fetchImpl: typeof fetch = async (input, init) => {
    calls.push({ input, init });
    return responseFactory(input, init);
  };
  return { calls, fetchImpl };
}

function assertAdapterError(error: unknown, code: string, retryable: boolean) {
  assert.ok(error instanceof ZhihuAdapterError);
  assert.equal(error.apiError.code, code);
  assert.equal(error.apiError.retryable, retryable);
  assert.ok(error.apiError.message);
  assert.equal(error.message.includes('Bearer'), false);
}

test('mock search returns mapped fixed resources without network access', async () => {
  let networkCalls = 0;
  const client = createZhihuClient({
    mockMode: true,
    fetchImpl: async () => {
      networkCalls += 1;
      throw new Error('network should not be called');
    },
  });

  const result = await client.search('微积分 极限');

  assert.equal(networkCalls, 0);
  assert.equal(result.resources.length, 3);
  assert.equal(result.resources[0].contentId, 'mock-answer-limits-1');
});

test('mock answer returns the fixed outline fixture without network access', async () => {
  let networkCalls = 0;
  const client = createZhihuClient({
    mockMode: true,
    fetchImpl: async () => {
      networkCalls += 1;
      throw new Error('network should not be called');
    },
  });

  const outline = await client.answer('生成微积分学习大纲');

  assert.equal(networkCalls, 0);
  assert.equal((outline as { topic: string }).topic, '微积分');
  assert.equal((outline as { nodes: unknown[] }).nodes.length, 6);
});

test('mock mode exposes empty and upstream error scenarios from fixtures', async () => {
  const emptyClient = createZhihuClient({ mockMode: true, mockScenario: 'empty' });
  const emptyResult = await emptyClient.search('没有资料的话题');
  assert.deepEqual(emptyResult.resources, []);
  assert.ok(emptyResult.emptyReason);

  const scenarios = [
    ['timeout', 'UPSTREAM_TIMEOUT', true],
    ['rate_limited', 'UPSTREAM_RATE_LIMITED', true],
    ['quota_exhausted', 'QUOTA_EXHAUSTED', false],
    ['unauthorized', 'UPSTREAM_AUTH', false],
  ] as const;

  for (const [scenario, code, retryable] of scenarios) {
    const { calls, fetchImpl } = createFetch(() => {
      throw new Error('network should not be called');
    });
    const client = createZhihuClient({ mockMode: true, mockScenario: scenario, fetchImpl });
    await assert.rejects(() => client.search('测试'), (error: unknown) => {
      assertAdapterError(error, code, retryable);
      return true;
    });
    await assert.rejects(() => client.answer('测试'), (error: unknown) => {
      assertAdapterError(error, code, retryable);
      return true;
    });
    assert.equal(calls.length, 0);
  }

  const invalidAnswerClient = createZhihuClient({
    mockMode: true,
    mockScenario: 'invalid_json',
  });
  await assert.rejects(() => invalidAnswerClient.answer('测试'), (error: unknown) => {
    assertAdapterError(error, 'OUTLINE_INVALID', true);
    return true;
  });
});

test('maps all required search fields to a Resource', async () => {
  const fixture = (await readFixture('resources-limits.json')) as {
    Data: { Items: unknown[] };
  };
  const resource = mapSearchItemToResource(fixture.Data.Items[0]);

  assert.deepEqual(resource, {
    title: '如何直观理解极限？',
    url: 'https://www.zhihu.com/answer/mock-answer-limits-1',
    contentId: 'mock-answer-limits-1',
    contentType: 'Answer',
    author: '知乎用户甲',
    authorBadge: '',
    authorBadgeText: '',
    authorityLevel: '2',
    rankingScore: 0.96,
    voteUpCount: 318,
    commentCount: 42,
    excerpt: '从数列和函数的趋近过程理解极限。',
    editTime: 1760000000,
    score: 0,
  });
});

test('sends structured search requests with bounded count and required headers', async () => {
  const fixture = await readFixture('resources-limits.json');
  const { calls, fetchImpl } = createFetch(() => jsonResponse(fixture));
  const client = createZhihuClient({
    mockMode: false,
    accessSecret: 'unit-test-secret',
    baseUrl: 'https://provider.example/base',
    fetchImpl,
    now: () => 1_760_000_000_123,
  });

  const result = await client.search('微积分 极限', 100);
  const request = calls[0];
  const url = new URL(String(request.input));

  assert.equal(result.resources.length, 3);
  assert.equal(url.origin, 'https://provider.example');
  assert.equal(url.pathname, '/api/v1/content/zhihu_search');
  assert.equal(url.searchParams.get('Query'), '微积分 极限');
  assert.equal(url.searchParams.get('Count'), '10');
  assert.equal(request.init?.method, 'GET');
  assert.equal(request.init?.headers instanceof Headers, false);
  const headers = request.init?.headers as Record<string, string>;
  assert.equal(headers.Authorization, 'Bearer unit-test-secret');
  assert.equal(headers['X-Request-Timestamp'], '1760000000');
  assert.equal(headers['Content-Type'], 'application/json');
  assert.equal(request.init?.redirect, 'error');
  assert.equal(request.init?.cache, 'no-store');
  assert.equal(calls.length, 1);
});

test('reads credentials and base URL from the server environment', async () => {
  const envSecret = ['env', 'only', 'test'].join('-');
  delete process.env.ZHIHU_ACCESS_SECRET;
  delete process.env.ZHIHU_API_BASE_URL;
  process.env.ZHIHU_ACCESS_SECRET = envSecret;
  process.env.ZHIHU_API_BASE_URL = 'https://env-provider.example';

  try {
    const fixture = await readFixture('resources-limits.json');
    const { calls, fetchImpl } = createFetch(() => jsonResponse(fixture));
    const client = createZhihuClient({ mockMode: false, fetchImpl });
    await client.search('微积分');
    const request = calls[0];
    const headers = request.init?.headers as Record<string, string>;
    assert.equal(new URL(String(request.input)).origin, 'https://env-provider.example');
    assert.equal(headers.Authorization, `Bearer ${envSecret}`);
  } finally {
    delete process.env.ZHIHU_ACCESS_SECRET;
    delete process.env.ZHIHU_API_BASE_URL;
  }
});

test('sends the required direct-answer request body', async () => {
  const outline = await readFixture('outline-calculus.json');
  const response = {
    choices: [
      {
        message: {
          content: JSON.stringify(outline),
        },
      },
    ],
  };
  const { calls, fetchImpl } = createFetch(() => jsonResponse(response));
  const client = createZhihuClient({
    mockMode: false,
    accessSecret: 'unit-test-secret',
    baseUrl: 'https://provider.example',
    fetchImpl,
    now: () => 1_760_000_000_123,
  });

  assert.deepEqual(await client.answer('请生成大纲'), outline);

  const request = calls[0];
  const body = JSON.parse(String(request.init?.body)) as {
    model: string;
    messages: Array<{ role: string; content: string }>;
    stream: boolean;
  };
  assert.equal(new URL(String(request.input)).pathname, '/v1/chat/completions');
  assert.equal(request.init?.method, 'POST');
  assert.equal(body.model, 'zhida-fast-1p5');
  assert.deepEqual(body.messages, [{ role: 'user', content: '请生成大纲' }]);
  assert.equal(body.stream, false);
  const headers = new Headers(request.init?.headers);
  assert.equal(headers.get('Authorization'), 'Bearer unit-test-secret');
  assert.equal(headers.get('X-Request-Timestamp'), '1760000000');
  assert.equal(headers.get('Content-Type'), 'application/json');
  assert.equal(calls.length, 1);
});

test('parses pure JSON and fenced JSON without repairing prose', () => {
  assert.deepEqual(parseAnswerJson('{"topic":"微积分"}'), { topic: '微积分' });
  assert.deepEqual(parseAnswerJson('```json\n{"topic":"微积分"}\n```'), {
    topic: '微积分',
  });
  assert.throws(
    () => parseAnswerJson('这里是结果：{"topic":"微积分"}'),
    (error: unknown) => {
      assertAdapterError(error, 'OUTLINE_INVALID', true);
      return true;
    },
  );
});

test('extracts direct-answer content and rejects missing structures', () => {
  assert.equal(
    extractAnswerContent({
      choices: [{ message: { content: '{"topic":"微积分"}' } }],
    }),
    '{"topic":"微积分"}',
  );
  assert.throws(
    () => extractAnswerContent({ choices: [] }),
    (error: unknown) => {
      assertAdapterError(error, 'UPSTREAM_ERROR', true);
      return true;
    },
  );
});

test('maps missing credentials and upstream error codes safely', async () => {
  const missingSecretClient = createZhihuClient({
    mockMode: false,
    accessSecret: '',
    fetchImpl: async () => {
      throw new Error('network should not be called');
    },
  });
  await assert.rejects(() => missingSecretClient.search('测试'), (error: unknown) => {
    assertAdapterError(error, 'UPSTREAM_AUTH', false);
    return true;
  });

  const cases = [
    [20001, 'UPSTREAM_AUTH', false],
    [30001, 'UPSTREAM_RATE_LIMITED', true],
    [30002, 'QUOTA_EXHAUSTED', false],
  ] as const;
  for (const [upstreamCode, code, retryable] of cases) {
    const { fetchImpl } = createFetch(() =>
      jsonResponse({ Code: upstreamCode, Message: 'provider message', Data: null }),
    );
    const client = createZhihuClient({
      mockMode: false,
      accessSecret: 'unit-test-secret',
      fetchImpl,
    });
    await assert.rejects(() => client.search('测试'), (error: unknown) => {
      assertAdapterError(error, code, retryable);
      return true;
    });
  }
});

test('maps network errors and invalid upstream JSON', async () => {
  const networkClient = createZhihuClient({
    mockMode: false,
    accessSecret: 'unit-test-secret',
    fetchImpl: async () => {
      throw new Error('socket details must not escape');
    },
  });
  await assert.rejects(() => networkClient.search('测试'), (error: unknown) => {
    assertAdapterError(error, 'UPSTREAM_ERROR', true);
    assert.equal(error instanceof Error && error.message.includes('socket'), false);
    return true;
  });

  const { fetchImpl } = createFetch(() => new Response('not json', { status: 200 }));
  const invalidJsonClient = createZhihuClient({
    mockMode: false,
    accessSecret: 'unit-test-secret',
    fetchImpl,
  });
  await assert.rejects(() => invalidJsonClient.search('测试'), (error: unknown) => {
    assertAdapterError(error, 'UPSTREAM_ERROR', true);
    return true;
  });

  const { fetchImpl: unauthorizedFetch } = createFetch(
    () => new Response('not json', { status: 401 }),
  );
  const unauthorizedClient = createZhihuClient({
    mockMode: false,
    accessSecret: 'unit-test-secret',
    fetchImpl: unauthorizedFetch,
  });
  await assert.rejects(() => unauthorizedClient.search('测试'), (error: unknown) => {
    assertAdapterError(error, 'UPSTREAM_AUTH', false);
    return true;
  });
});

test('maps timeout and missing upstream structures', async () => {
  const timeoutFetch: typeof fetch = (_input, init) =>
    new Promise((_, reject) => {
      init?.signal?.addEventListener(
        'abort',
        () => reject(new DOMException('aborted', 'AbortError')),
        { once: true },
      );
    });
  const timeoutClient = createZhihuClient({
    mockMode: false,
    accessSecret: 'unit-test-secret',
    searchTimeoutMs: 5,
    fetchImpl: timeoutFetch,
  });
  await assert.rejects(() => timeoutClient.search('测试'), (error: unknown) => {
    assertAdapterError(error, 'UPSTREAM_TIMEOUT', true);
    return true;
  });

  const { fetchImpl } = createFetch(() =>
    jsonResponse({ Code: 0, Data: { HasMore: false } }),
  );
  const malformedClient = createZhihuClient({
    mockMode: false,
    accessSecret: 'unit-test-secret',
    fetchImpl,
  });
  await assert.rejects(() => malformedClient.search('测试'), (error: unknown) => {
    assertAdapterError(error, 'UPSTREAM_ERROR', true);
    return true;
  });
});

test('environment mock mode cannot be disabled by client options', async () => {
  process.env.ZHIJING_MOCK_MODE = 'true';
  const { calls, fetchImpl } = createFetch(() => {
    throw new Error('network should not be called');
  });
  try {
    const client = createZhihuClient({
      mockMode: false,
      baseUrl: 'invalid base URL',
      fetchImpl,
    });
    assert.equal((await client.search('test')).resources.length, 3);
    assert.equal((await client.answer('test')).topic, '微积分');
    assert.equal(calls.length, 0);
  } finally {
    delete process.env.ZHIJING_MOCK_MODE;
  }
});

test('default mode uses fixtures without credentials or external requests', async () => {
  const { calls, fetchImpl } = createFetch(() => {
    throw new Error('network should not be called');
  });
  const client = createZhihuClient({ fetchImpl });
  assert.equal((await client.search('test', 1)).resources.length, 1);
  assert.equal((await client.answer('test')).nodes.length, 6);
  assert.equal(calls.length, 0);
});

test('search counts use provider defaults and preserve smaller requests', async () => {
  const fixture = await readFixture('resources-limits.json');
  for (const [count, expected] of [
    [undefined, 10], [1, 1], [3, 3], [100, 10], [0, 10], [-1, 10],
    [Number.NaN, 10], [Number.POSITIVE_INFINITY, 10], [0.5, 10], [2.9, 2],
  ]) {
    const { calls, fetchImpl } = createFetch(() => jsonResponse(fixture));
    const client = createZhihuClient({
      mockMode: false, accessSecret: 'unit-test-secret', fetchImpl,
    });
    await client.search('C++ & Python? #入门', count);
    const url = new URL(String(calls[0].input));
    assert.equal(url.origin, 'https://developer.zhihu.com');
    assert.equal(url.searchParams.get('Query'), 'C++ & Python? #入门');
    assert.equal(url.searchParams.get('Count'), String(expected));
    assert.equal(calls.length, 1);
  }
});

test('mapping tolerates absent badge images but never forwards unknown fields', async () => {
  const fixture = await readFixture('resources-limits.json') as {
    Data: { Items: Array<Record<string, unknown>> };
  };
  const item: Record<string, unknown> = { ...fixture.Data.Items[0], extra: { internal: true } };
  delete item.AuthorBadge;
  const before = structuredClone(item);
  const resource = mapSearchItemToResource(item);
  assert.equal(resource.authorBadge, undefined);
  assert.equal('extra' in resource, false);
  assert.equal('AuthorAvatar' in resource, false);
  assert.equal('CommentInfoList' in resource, false);
  assert.deepEqual(item, before);
  assert.equal(resource.score, 0);
});

test('invalid search resource fields and missing payloads are not empty results', async () => {
  const fixture = await readFixture('resources-limits.json') as {
    Data: { Items: Array<Record<string, unknown>> };
  };
  for (const field of ['Title', 'Url', 'ContentID', 'ContentType', 'ContentText',
    'AuthorName', 'AuthorBadgeText', 'AuthorityLevel', 'RankingScore',
    'VoteUpCount', 'CommentCount', 'EditTime']) {
    const item = { ...fixture.Data.Items[0] };
    delete item[field];
    assert.throws(() => mapSearchItemToResource(item), (error) => {
      assertAdapterError(error, 'UPSTREAM_ERROR', true);
      return true;
    });
  }
  for (const payload of [null, [], {}, { Code: 0 }, { Code: 0, Data: null },
    { Code: 0, Data: { Items: null } }, { Code: 0, Data: { Items: [null] } }]) {
    const { calls, fetchImpl } = createFetch(() => jsonResponse(payload));
    const client = createZhihuClient({
      mockMode: false, accessSecret: 'unit-test-secret', fetchImpl,
    });
    await assert.rejects(() => client.search('test'), (error) => {
      assertAdapterError(error, 'UPSTREAM_ERROR', true);
      return true;
    });
    assert.equal(calls.length, 1);
  }
});

test('JSON parsing and outline validation remain separate and never repair data', async () => {
  const valid = await readFixture('outline-calculus.json');
  assert.deepEqual(parseAnswerJson(`\n\`\`\`JSON\n${JSON.stringify(valid)}\n\`\`\`\n`), valid);
  assert.deepEqual(parseAnswerJson('```\n{"x":1}\n```'), { x: 1 });
  assert.deepEqual(parseAnswerJson('{"nodes":[]}'), { nodes: [] });

  for (const content of ['', 'not JSON', '```json\n{"x":1,}\n```',
    'before\n```json\n{}\n```', '```json\n{}\n```\nafter']) {
    assert.throws(() => parseAnswerJson(content), (error) => {
      assertAdapterError(error, 'OUTLINE_INVALID', true);
      return true;
    });
  }
  for (const content of ['null', '[]', '{"nodes":[]}']) {
    const payload = { choices: [{ message: { content } }] };
    assert.throws(() => parseAnswerOutline(payload), (error) => {
      assertAdapterError(error, 'OUTLINE_INVALID', true);
      return true;
    });
    assert.equal(payload.choices[0].message.content, content);
  }
});

test('answer rejects missing upstream structures and illegal JSON without retries', async () => {
  const cases = [
    [null, 'UPSTREAM_ERROR'],
    [{ choices: [] }, 'UPSTREAM_ERROR'],
    [{ choices: [null] }, 'UPSTREAM_ERROR'],
    [{ choices: [{ message: {} }] }, 'UPSTREAM_ERROR'],
    [{ choices: [{ message: { content: 123 } }] }, 'UPSTREAM_ERROR'],
    [await readFixture('outline-invalid.json'), 'OUTLINE_INVALID'],
  ] as const;
  for (const [payload, code] of cases) {
    const { calls, fetchImpl } = createFetch(() => jsonResponse(payload));
    const client = createZhihuClient({
      mockMode: false, accessSecret: 'unit-test-secret', fetchImpl,
    });
    await assert.rejects(() => client.answer('test'), (error) => {
      assertAdapterError(error, code, true);
      return true;
    });
    assert.equal(calls.length, 1);
  }
});

test('nested chat errors preserve authentication, rate and quota classifications', async () => {
  for (const [upstreamCode, code, retryable] of [
    [20001, 'UPSTREAM_AUTH', false],
    [30001, 'UPSTREAM_RATE_LIMITED', true],
    [30002, 'QUOTA_EXHAUSTED', false],
  ] as const) {
    for (const status of [200, 429, 502]) {
      const { calls, fetchImpl } = createFetch(() => jsonResponse({
        error: { code: String(upstreamCode), message: 'private upstream details' },
      }, status));
      const client = createZhihuClient({
        mockMode: false, accessSecret: 'unit-test-secret', fetchImpl,
      });
      await assert.rejects(() => client.answer('test'), (error) => {
        assertAdapterError(error, code, retryable);
        return true;
      });
      assert.equal(calls.length, 1);
    }
  }
});

test('HTTP errors are classified even without a JSON response body', async () => {
  for (const [status, code, retryable] of [
    [401, 'UPSTREAM_AUTH', false], [403, 'UPSTREAM_AUTH', false],
    [408, 'UPSTREAM_TIMEOUT', true], [504, 'UPSTREAM_TIMEOUT', true],
    [429, 'UPSTREAM_RATE_LIMITED', true], [500, 'UPSTREAM_ERROR', true],
  ] as const) {
    const { fetchImpl } = createFetch(() => new Response('private upstream details', { status }));
    const client = createZhihuClient({
      mockMode: false, accessSecret: 'unit-test-secret', fetchImpl,
    });
    await assert.rejects(() => client.answer('test'), (error) => {
      assertAdapterError(error, code, retryable);
      return true;
    });
  }
});

test('timeouts cover reading the body on both endpoints and abort exactly once', async () => {
  for (const operation of ['search', 'answer'] as const) {
    let aborts = 0;
    const { calls, fetchImpl } = createFetch((_input, init) => new Response(
      new ReadableStream({
        start(controller) {
          init?.signal?.addEventListener('abort', () => {
            aborts += 1;
            controller.error(new DOMException('internal transport detail', 'AbortError'));
          }, { once: true });
        },
      }),
    ));
    const client = createZhihuClient({
      mockMode: false, accessSecret: 'unit-test-secret', fetchImpl,
      searchTimeoutMs: 5, outlineTimeoutMs: 5,
    });
    await assert.rejects(() => client[operation]('test'), (error) => {
      assertAdapterError(error, 'UPSTREAM_TIMEOUT', true);
      return true;
    });
    assert.equal(calls.length, 1);
    assert.equal(aborts, 1);
  }
});

test('successful requests clear their timeout timers', async () => {
  let aborts = 0;
  const { fetchImpl } = createFetch((_input, init) => {
    init?.signal?.addEventListener('abort', () => { aborts += 1; });
    return jsonResponse({ Code: 0, Data: { Items: [] } });
  });
  const client = createZhihuClient({
    mockMode: false, accessSecret: 'unit-test-secret', fetchImpl, searchTimeoutMs: 5,
  });
  assert.deepEqual((await client.search('test')).resources, []);
  await new Promise((resolve) => setTimeout(resolve, 15));
  assert.equal(aborts, 0);
});

test('credentials and upstream details never enter errors or client serialization', async () => {
  const secret = ['unit', 'test', 'sensitive', 'sentinel'].join('-');
  const { fetchImpl } = createFetch(() => {
    throw new Error(`Authorization: Bearer ${secret}`);
  });
  const client = createZhihuClient({ mockMode: false, accessSecret: secret, fetchImpl });
  assert.equal(JSON.stringify(client).includes(secret), false);
  assert.equal(inspect(client).includes(secret), false);
  await assert.rejects(() => client.search('test'), (error) => {
    assertAdapterError(error, 'UPSTREAM_ERROR', true);
    assert.equal(inspect(error).includes(secret), false);
    assert.equal(JSON.stringify(error).includes(secret), false);
    assert.deepEqual(JSON.parse(JSON.stringify(error)), {
      ok: false,
      error: { code: 'UPSTREAM_ERROR', message: '知乎服务网络请求失败', retryable: true },
    });
    return true;
  });
});

test('whitespace credentials and invalid server configuration fail without requests', async () => {
  const { calls, fetchImpl } = createFetch(() => {
    throw new Error('network should not be called');
  });
  const client = createZhihuClient({ mockMode: false, accessSecret: '  ', fetchImpl });
  await assert.rejects(() => client.answer('test'), (error) => {
    assertAdapterError(error, 'UPSTREAM_AUTH', false);
    return true;
  });
  for (const baseUrl of ['invalid URL', 'file:///tmp', 'https://user:pass@example.com']) {
    assert.throws(() => createZhihuClient({ mockMode: false, baseUrl, fetchImpl }),
      (error) => {
        assertAdapterError(error, 'UPSTREAM_ERROR', true);
        return true;
      });
  }
  for (const searchTimeoutMs of [0, -1, NaN, Infinity, 2_147_483_648]) {
    assert.throws(() => createZhihuClient({ mockMode: false, searchTimeoutMs, fetchImpl }),
      (error) => {
        assertAdapterError(error, 'UPSTREAM_ERROR', true);
        return true;
      });
  }
  assert.equal(calls.length, 0);
});
