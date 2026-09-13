import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import test from 'node:test';
import type { ApiErrorCode, SseEvent } from '../types/api.ts';
import type { KnowledgeMapOutline } from '../types/domain.ts';
import { fail } from '../src/server/api-errors.ts';
import {
  MapGenerationService, type GenerationClient, type GenerationContext,
} from '../src/server/map-generation.ts';
import { createMapHandlers, generationContext } from '../src/server/map-http.ts';
import { SearchScheduler } from '../src/server/search-scheduler.ts';
import {
  createZhihuClient, mapSearchItemToResource, parseAnswerOutline, ZhihuAdapterError,
} from '../src/server/zhihu-adapter.ts';
import { rankResources } from '../src/server/resource-ranking.ts';

delete process.env.ZHIHU_ACCESS_SECRET;
delete process.env.ZHIJING_MOCK_MODE;
delete process.env.ZHIJING_MOCK_SCENARIO;

const context: GenerationContext = { mockMode: true, mockScenario: 'default' };
const fixture = JSON.parse(await readFile(resolve('fixtures/outline-calculus.json'), 'utf8')) as KnowledgeMapOutline;
const resourceFixture = JSON.parse(await readFile(resolve('fixtures/resources-limits.json'), 'utf8'));
const resources = resourceFixture.Data.Items.map(mapSearchItemToResource);
const tick = () => new Promise<void>((done) => setImmediate(done));
const delay = (ms: number) => new Promise<void>((done) => setTimeout(done, ms));

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

function client(overrides: Partial<GenerationClient> = {}): GenerationClient {
  return {
    answer: async () => structuredClone(fixture),
    search: async () => ({ resources: structuredClone(resources) }),
    ...overrides,
  };
}

function request(body: unknown, sse = false, signal?: AbortSignal): Request {
  return new Request('http://localhost/api/generate', {
    method: 'POST', signal,
    headers: { 'Content-Type': 'application/json', Accept: sse ? 'text/event-stream' : 'application/json' },
    body: JSON.stringify(body),
  });
}

function eventsFrom(text: string): SseEvent[] {
  return text.split('\n\n').filter((chunk) => chunk.includes('event: ')).map((chunk) => {
    const lines = chunk.split('\n');
    return {
      event: lines.find((line) => line.startsWith('event: '))!.slice(7),
      data: JSON.parse(lines.find((line) => line.startsWith('data: '))!.slice(6)),
    } as SseEvent;
  });
}

test('skeleton precedes searches; complete counts generation, not learning', async () => {
  const events: SseEvent[] = [];
  const service = new MapGenerationService({ clientFactory: () => client({
    search: async () => {
      assert.equal(events[0]?.event, 'outline');
      return { resources };
    },
  }) });
  const task = service.generate('微积分', context);
  task.subscribe((event) => events.push(event));
  const result = await task.result;
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.map.completedNodeCount, 6);
  assert.equal(result.map.failedNodeCount, 0);
  assert.equal(result.map.status, 'complete');
  assert.ok(result.map.nodes.every((node) => node.resources.length <= 3 && node.weight > 0));
  assert.equal(events[0].event, 'outline');
  if (events[0].event === 'outline') {
    assert.ok(events[0].data.nodes.every((node) => node.state === 'pending' && !node.resources.length));
  }
  assert.equal(events.at(-1)?.event, 'complete');
  assert.equal(events.filter((e) => e.event === 'complete').length, 1);
  assert.ok(events.every((e) => e.data.mapId === task.mapId && e.data.mockMode));
});

test('TTL cache keeps mapId until expiry while progressScope stays stable across versions', async () => {
  let now = 1000;
  let calls = 0;
  let ids = 0;
  const service = new MapGenerationService({
    now: () => now, ttlMs: 100, idFactory: () => `generation-${++ids}`,
    clientFactory: () => client({ answer: async () => { calls++; return fixture; } }),
  });
  const a = await service.generate(' PYTHON  入门! ', context).result;
  assert.ok(a.ok);
  a.map.nodes[0].title = 'caller mutation';
  const b = await service.generate('python 入门', context).result;
  assert.ok(b.ok);
  assert.notEqual(b.map.nodes[0].title, 'caller mutation');
  assert.equal(a.map.mapId, b.map.mapId);
  now = 1099;
  assert.ok(service.getCached('python 入门', context));
  now = 1100;
  assert.equal(service.getCached('python 入门', context), undefined);
  const c = await service.generate('python 入门', context).result;
  assert.ok(c.ok);
  assert.notEqual(c.map.mapId, a.map.mapId);
  assert.equal(c.map.progressScope, a.map.progressScope);
  assert.deepEqual(c.map.nodes.map((n) => n.id), b.map.nodes.map((n) => n.id));
  assert.equal(calls, 2);
});

test('same-topic requests share one task and replay immutable events without gaps', async () => {
  const outline = deferred<KnowledgeMapOutline>();
  const search = deferred<{ resources: typeof resources }>();
  let answers = 0;
  const service = new MapGenerationService({ clientFactory: () => client({
    answer: () => { answers++; return outline.promise; },
    search: () => search.promise,
  }) });
  const first = service.generate(' test! ', context);
  const second = service.generate('TEST', context);
  assert.equal(first.mapId, second.mapId);
  const early: SseEvent[] = [];
  first.subscribe((event) => {
    early.push(event);
    if (event.event === 'outline') event.data.nodes[0].title = 'mutated subscriber';
  });
  outline.resolve(fixture);
  await tick();
  const late: SseEvent[] = [];
  second.subscribe((event) => late.push(event));
  assert.equal(late[0]?.event, 'outline');
  if (late[0].event === 'outline') assert.notEqual(late[0].data.nodes[0].title, 'mutated subscriber');
  search.resolve({ resources });
  await Promise.all([first.result, second.result]);
  assert.equal(answers, 1);
  assert.equal(early.length, late.length);
  assert.equal(late.at(-1)?.event, 'complete');
});

test('empty and error nodes do not block siblings; partial maps are never cached', async () => {
  const service = new MapGenerationService({ clientFactory: () => client({
    search: async (query) => {
      if (query === fixture.nodes[0].query) return { resources: [] };
      if (query === fixture.nodes[1].query) fail('UPSTREAM_RATE_LIMITED');
      return { resources };
    },
  }) });
  const task = service.generate('test', context);
  const events: SseEvent[] = [];
  task.subscribe((event) => events.push(event));
  const outcome = await task.result;
  assert.ok(outcome.ok);
  assert.equal(outcome.map.status, 'partial');
  assert.equal(outcome.map.completedNodeCount, 6);
  assert.equal(outcome.map.failedNodeCount, 1);
  assert.equal(outcome.map.nodes[0].state, 'empty');
  assert.equal(outcome.map.nodes[1].error?.code, 'UPSTREAM_RATE_LIMITED');
  assert.equal(service.getCached('test', context), undefined);
  const error = events.find((e) => e.event === 'resource_error');
  assert.equal(error?.data.error.code, 'UPSTREAM_RATE_LIMITED');
  const complete = events.at(-1);
  assert.ok(complete?.event === 'complete');
  assert.equal(complete.data.status, 'partial');
  const second = service.generate('test', context);
  assert.notEqual(second.mapId, task.mapId);
  await second.result;
});

test('all-empty result is complete and cache eligible', async () => {
  const service = new MapGenerationService({ clientFactory: () => client({
    search: async () => ({ resources: [] }),
  }) });
  const result = await service.generate('test', context).result;
  assert.ok(result.ok);
  assert.equal(result.map.status, 'complete');
  assert.equal(result.map.failedNodeCount, 0);
  assert.ok(service.getCached('test', context));
});

test('mock/live modes and every mock scenario isolate both cache and in-flight requests', async () => {
  const gate = deferred<KnowledgeMapOutline>();
  let answers = 0;
  const service = new MapGenerationService({ clientFactory: () => client({
    answer: () => { answers++; return gate.promise; },
  }) });
  const contexts: GenerationContext[] = [
    context, { mockMode: true, mockScenario: 'empty' }, { mockMode: false, mockScenario: 'default' },
  ];
  const tasks = contexts.map((mode) => service.generate('same topic', mode));
  assert.equal(new Set(tasks.map((task) => task.mapId)).size, 3);
  gate.resolve(fixture);
  const results = await Promise.all(tasks.map((task) => task.result));
  assert.equal(answers, 3);
  for (let i = 0; i < contexts.length; i++) {
    assert.equal(service.getCached('same topic', contexts[i])?.mapId, tasks[i].mapId);
    assert.equal(service.getCached('same topic', contexts[i])?.mockMode, contexts[i].mockMode);
  }
  assert.ok(results.every((r) => r.ok));
});

test('only received invalid outlines retry, at most once', async () => {
  for (const code of [
    'OUTLINE_INVALID', 'NOT_LEARNABLE', 'UPSTREAM_TIMEOUT', 'UPSTREAM_AUTH',
    'UPSTREAM_RATE_LIMITED', 'QUOTA_EXHAUSTED', 'UPSTREAM_ERROR',
  ] as ApiErrorCode[]) {
    let attempts = 0;
    let searches = 0;
    const service = new MapGenerationService({ clientFactory: () => client({
      answer: async () => { attempts++; fail(code); },
      search: async () => { searches++; return { resources }; },
    }) });
    const task = service.generate('test', context);
    const events: SseEvent[] = [];
    task.subscribe((event) => events.push(event));
    const result = await task.result;
    assert.equal(result.ok, false);
    assert.equal(attempts, code === 'OUTLINE_INVALID' ? 2 : 1);
    assert.equal(searches, 0);
    assert.equal(events.length, 1);
    assert.equal(events[0].event, 'generation_error');
    assert.equal(service.getCached('test', context), undefined);
  }
  let attempts = 0;
  const service = new MapGenerationService({ clientFactory: () => client({
    answer: async () => { if (++attempts === 1) fail('OUTLINE_INVALID'); return fixture; },
  }) });
  assert.ok((await service.generate('test', context).result).ok);
  assert.equal(attempts, 2);
});

test('NOT_LEARNABLE recognition in the real adapter does not become OUTLINE_INVALID', () => {
  assert.throws(() => parseAnswerOutline({
    choices: [{ message: { content: '{"error":"not_learnable"}' } }],
  }), (error: unknown) => {
    assert.equal((error as { apiError: { code: string } }).apiError.code, 'NOT_LEARNABLE');
    return true;
  });
});

test('process-shared concurrency never exceeds five across tasks and resources endpoint', async () => {
  let active = 0;
  let peak = 0;
  const releases: Array<() => void> = [];
  const sharedClient = client({
    search: () => new Promise((done) => {
      active++; peak = Math.max(peak, active);
      releases.push(() => { active--; done({ resources }); });
    }),
  });
  const a = new MapGenerationService({ clientFactory: () => sharedClient });
  const b = new MapGenerationService({ clientFactory: () => sharedClient });
  const tasks = [a.generate('one', context), b.generate('two', context)];
  const standalone = b.resources('two', 'id', 'query', context);
  await tick();
  assert.equal(active, 5);
  for (let i = 0; i < 20; i++) {
    releases.splice(0).forEach((done) => done());
    await tick();
    if (Number(active) === 0) break;
  }
  await Promise.all([...tasks.map((t) => t.result), standalone]);
  assert.equal(peak, 5);
  assert.equal(active, 0);
});

test('overall timeout cancels active work, drops queued work, and releases slots and records', async () => {
  let aborted = 0;
  let calls = 0;
  let hang = true;
  const scheduler = new SearchScheduler();
  const service = new MapGenerationService({
    scheduler, timeoutMs: 20,
    clientFactory: () => client({
      search: (_query, _count, signal) => {
        calls++;
        if (!hang) return Promise.resolve({ resources });
        return new Promise((_, reject) => {
          signal!.addEventListener('abort', () => {
            aborted++;
            reject(new DOMException('Aborted', 'AbortError'));
          }, { once: true });
        });
      },
    }),
  });
  const task = service.generate('test', context);
  const events: SseEvent[] = [];
  task.subscribe((event) => events.push(event));
  const result = await task.result;
  assert.equal(result.ok, false);
  await tick();
  assert.equal(aborted, 5);
  assert.equal(calls, 5);
  assert.equal(events.filter((e) => e.event === 'generation_error').length, 1);
  assert.equal(events.filter((e) => e.event === 'complete').length, 0);
  assert.equal(events.at(-1)?.event, 'generation_error');
  assert.equal(service.getCached('test', context), undefined);
  hang = false;
  const next = service.generate('test', context);
  assert.notEqual(next.mapId, task.mapId);
  assert.ok((await next.result).ok);
  assert.equal(calls, 11);
});

test('outline timeout removes abandoned task and ignores late success', async () => {
  const gate = deferred<KnowledgeMapOutline>();
  let late = true;
  let searches = 0;
  const service = new MapGenerationService({ timeoutMs: 10, clientFactory: () => client({
    answer: () => late ? gate.promise : Promise.resolve(fixture),
    search: async () => { searches++; return { resources }; },
  }) });
  const task = service.generate('test', context);
  const events: SseEvent[] = [];
  task.subscribe((event) => events.push(event));
  assert.equal((await task.result).ok, false);
  late = false;
  const next = await service.generate('test', context).result;
  assert.ok(next.ok);
  gate.resolve(fixture);
  await tick();
  assert.equal(events.length, 1);
  assert.equal(searches, 6);
  assert.equal(service.getCached('test', context)?.mapId, next.map.mapId);
});

test('disconnecting one or all subscribers leaves shared task running and cacheable', async () => {
  const gate = deferred<KnowledgeMapOutline>();
  const service = new MapGenerationService({ clientFactory: () => client({ answer: () => gate.promise }) });
  const task = service.generate('test', context);
  const a: SseEvent[] = [];
  const b: SseEvent[] = [];
  const stopA = task.subscribe((e) => a.push(e));
  const stopB = task.subscribe((e) => b.push(e));
  stopA();
  stopB();
  gate.resolve(fixture);
  assert.ok((await task.result).ok);
  assert.equal(a.length, 0);
  assert.equal(b.length, 0);
  assert.ok(service.getCached('test', context));
});

test('finished tasks clear timers and isolate failing subscribers', async () => {
  let aborts = 0;
  const service = new MapGenerationService({ timeoutMs: 10, clientFactory: () => client({
    answer: async (_prompt, signal) => {
      signal!.addEventListener('abort', () => { aborts++; });
      return fixture;
    },
  }) });
  const task = service.generate('test', context);
  task.subscribe(() => { throw new Error('bad subscriber'); });
  const events: SseEvent[] = [];
  task.subscribe((event) => events.push(event));
  assert.ok((await task.result).ok);
  await delay(15);
  assert.equal(aborts, 0);
  assert.equal(events.at(-1)?.event, 'complete');
});

test('JSON generation, standalone APIs, cache hit and miss follow existing contracts', async () => {
  const service = new MapGenerationService({ clientFactory: () => client() });
  const handlers = createMapHandlers(service, () => context);
  const missing = await handlers.map(new Request('http://localhost/api/map?topic=test'));
  assert.equal(missing.status, 404);
  const outline = await handlers.outline(request({ topic: 'test' }));
  assert.equal(outline.status, 200);
  assert.equal((await outline.json()).mockMode, true);
  const resource = await handlers.resources(request({ topic: 'test', nodeId: 'id', query: 'query' }));
  assert.equal(resource.status, 200);
  assert.equal((await resource.json()).state, 'ready');
  const generated = await handlers.generate(request({ topic: 'test' }));
  assert.equal(generated.status, 200);
  const result = await generated.json();
  const cached = await handlers.map(new Request('http://localhost/api/map?topic=test'));
  assert.equal(cached.status, 200);
  assert.deepEqual(await cached.json(), result);
});

test('JSON partial is 200 but standalone resource failure is non-2xx', async () => {
  const handlers = createMapHandlers(new MapGenerationService({
    clientFactory: () => client({ search: async () => fail('QUOTA_EXHAUSTED') }),
  }), () => context);
  const response = await handlers.generate(request({ topic: 'test' }));
  assert.equal(response.status, 200);
  const partial = await response.json();
  assert.equal(partial.status, 'partial');
  assert.equal(partial.failedNodeCount, 6);
  assert.equal(partial.completedNodeCount, 6);
  assert.ok(partial.nodes.every((n: { error: { code: string } }) => n.error.code === 'QUOTA_EXHAUSTED'));
  const independent = await handlers.resources(request({ topic: 'test', nodeId: 'id', query: 'query' }));
  assert.equal(independent.status, 429);
  assert.deepEqual(await independent.json(), {
    ok: false, mockMode: true,
    error: { code: 'QUOTA_EXHAUSTED', message: '知乎服务额度已耗尽', retryable: false },
  });
});

test('SSE failures before and after establishment have distinct error transport', async () => {
  const invalid = createMapHandlers(new MapGenerationService(), () => context);
  const bad = await invalid.generate(request({ topic: ' ' }, true));
  assert.equal(bad.status, 400);
  assert.equal((await bad.json()).mockMode, true);
  const service = new MapGenerationService({
    clientFactory: () => client({ answer: async () => fail('NOT_LEARNABLE') }),
  });
  const handlers = createMapHandlers(service, () => context);
  const stream = await handlers.generate(request({ topic: 'test' }, true));
  assert.equal(stream.status, 200);
  assert.ok(stream.headers.get('content-type')?.startsWith('text/event-stream'));
  const events = eventsFrom(await stream.text());
  assert.equal(events.length, 1);
  assert.equal(events[0].event, 'generation_error');
  if (events[0].event === 'generation_error') assert.equal(events[0].data.error.code, 'NOT_LEARNABLE');
  assert.ok(events[0].data.mapId);
  assert.equal(events[0].data.mockMode, true);
  const json = await handlers.generate(request({ topic: 'test' }));
  assert.equal(json.status, 422);
});

test('SSE replay preserves event IDs and cancellation only detaches one reader', async () => {
  const gate = deferred<KnowledgeMapOutline>();
  const service = new MapGenerationService({ clientFactory: () => client({ answer: () => gate.promise }) });
  const handlers = createMapHandlers(service, () => context);
  const disconnected = new AbortController();
  const first = await handlers.generate(request({ topic: 'test' }, true, disconnected.signal));
  const second = await handlers.generate(request({ topic: 'test' }, true));
  disconnected.abort();
  const firstText = await first.text();
  assert.equal(eventsFrom(firstText).length, 0);
  gate.resolve(fixture);
  const secondText = await second.text();
  const events = eventsFrom(secondText);
  assert.equal(events[0].event, 'outline');
  assert.equal(events.at(-1)?.event, 'complete');
  const cached = await handlers.generate(request({ topic: 'test' }, true));
  assert.deepEqual(
    (await cached.text()).match(/^id: .+$/gm),
    secondText.match(/^id: .+$/gm),
  );
  const canceled = await handlers.generate(request({ topic: 'new' }, true));
  await canceled.body!.cancel();
  await tick();
  assert.ok(service.getCached('new', context));
});

test('mock generation uses existing fixtures and never fetches outside', async () => {
  let calls = 0;
  const service = new MapGenerationService({
    clientFactory: (mode) => createZhihuClient({
      ...mode, fetchImpl: async () => { calls++; throw new Error('external fetch forbidden'); },
    }),
  });
  const handlers = createMapHandlers(service, () => context);
  const response = await handlers.generate(request({ topic: '微积分' }, true));
  const events = eventsFrom(await response.text());
  assert.equal(events.length, 8);
  assert.equal(events.at(-1)?.event, 'complete');
  assert.ok(events.every((event) => event.data.mockMode));
  assert.equal(calls, 0);
});

test('safe errors do not include upstream details, including before SSE establishment', async () => {
  const sentinel = 'private-error-sentinel';
  const service = new MapGenerationService({
    clientFactory: () => { throw new Error(sentinel); },
  });
  const handlers = createMapHandlers(service, () => context);
  const response = await handlers.generate(request({ topic: 'test' }, true));
  assert.equal(response.status, 502);
  assert.equal((await response.text()).includes(sentinel), false);
});

test('invalid JSON, excessive bodies and missing resource fields return uniform errors', async () => {
  const handlers = createMapHandlers(new MapGenerationService(), () => context);
  for (const value of ['', '{', 'null', '[]', JSON.stringify({ topic: 'x'.repeat(9000) })]) {
    const req = new Request('http://localhost/api/generate', {
      method: 'POST', body: value, headers: { 'content-type': 'application/json' },
    });
    const response = await handlers.generate(req);
    assert.equal(response.status, 400);
    assert.equal((await response.json()).error.code, 'INVALID_TOPIC');
  }
  const response = await handlers.resources(request({ topic: 'test' }));
  assert.equal(response.status, 400);
});

test('ranking uses relevance and interaction, filters unsafe links and returns at most three', () => {
  const list = [
    ...resources,
    { ...resources[0], contentId: 'unsafe', url: 'javascript:alert(1)' },
    { ...resources[0], contentId: 'ad', title: '广告推广' },
    { ...resources[0] },
  ];
  const ranked = rankResources(list);
  assert.equal(ranked.length, 3);
  assert.ok(ranked.every((r) => r.score >= 0 && r.score <= 1));
  assert.equal(ranked[0].contentId, resources[0].contentId);
});

test('runtime context isolates server-selected mock scenarios', () => {
  process.env.ZHIJING_MOCK_MODE = 'true';
  process.env.ZHIJING_MOCK_SCENARIO = 'empty';
  try { assert.deepEqual(generationContext(), { mockMode: true, mockScenario: 'empty' }); }
  finally {
    delete process.env.ZHIJING_MOCK_MODE;
    delete process.env.ZHIJING_MOCK_SCENARIO;
  }
});

test('cached result mutations cannot alter events replayed from the same handle', async () => {
  const service = new MapGenerationService({ clientFactory: () => client() });
  await service.generate('test', context).result;
  const cached = service.generate('test', context);
  const result = await cached.result;
  assert.ok(result.ok);
  result.map.overview.what = 'mutated overview';
  result.map.edges[0].to = 'mutated edge';
  result.map.nodes[0].resources[0].title = 'mutated resource';
  const events: SseEvent[] = [];
  cached.subscribe((event) => events.push(event));
  assert.equal(events[0].event, 'outline');
  if (events[0].event === 'outline') {
    assert.notEqual(events[0].data.overview.what, 'mutated overview');
    assert.notEqual(events[0].data.edges[0].to, 'mutated edge');
  }
  const resourceEvent = events.find((event) => event.event === 'resource_ready');
  assert.notEqual(resourceEvent?.data.resources[0].title, 'mutated resource');
});

test('synchronous regeneration inside terminal callbacks creates a fresh task', async () => {
  for (const partial of [false, true]) {
    let failed = true;
    const service = new MapGenerationService({ clientFactory: () => client({
      answer: async () => {
        if (failed && !partial) fail('UPSTREAM_AUTH');
        return fixture;
      },
      search: async () => {
        if (failed && partial) fail('UPSTREAM_AUTH');
        return { resources };
      },
    }) });
    const task = service.generate('test', context);
    let retry: ReturnType<MapGenerationService['generate']> | undefined;
    task.subscribe((event) => {
      if (event.event === 'complete' || event.event === 'generation_error') {
        failed = false;
        retry = service.generate('test', context);
      }
    });
    await task.result;
    assert.ok(retry);
    assert.notEqual(retry.mapId, task.mapId);
    assert.ok((await retry.result).ok);
  }
});

test('subscribing within an event callback replays the current event exactly once', async () => {
  const service = new MapGenerationService({ clientFactory: () => client() });
  const task = service.generate('test', context);
  const nested: SseEvent[] = [];
  task.subscribe((event) => {
    if (event.event === 'outline') task.subscribe((replayed) => nested.push(replayed));
  });
  await task.result;
  assert.equal(nested.filter((event) => event.event === 'outline').length, 1);
  assert.equal(nested.filter((event) => event.event === 'complete').length, 1);
  assert.equal(nested.length, 8);
});

test('adapter propagates caller cancellation without leaking the reason or starting retries', async () => {
  for (const operation of ['search', 'answer'] as const) {
    const controller = new AbortController();
    let calls = 0;
    let receivedSignal: AbortSignal | undefined;
    const adapter = createZhihuClient({
      mockMode: false, accessSecret: 'unit-test-secret',
      fetchImpl: async (_input, init) => {
        calls++;
        receivedSignal = init!.signal!;
        return new Promise((_, reject) => {
          receivedSignal!.addEventListener('abort', () =>
            reject(new DOMException('cancelled', 'AbortError')), { once: true });
        });
      },
    });
    const promise = operation === 'search'
      ? adapter.search('test', 10, controller.signal)
      : adapter.answer('test', controller.signal);
    controller.abort(new Error('private abort reason'));
    await assert.rejects(promise, (error) => {
      assert.ok(error instanceof ZhihuAdapterError);
      assert.equal(error.apiError.code, 'UPSTREAM_TIMEOUT');
      assert.equal(JSON.stringify(error).includes('private abort reason'), false);
      return true;
    });
    assert.ok(receivedSignal?.aborted);
    assert.equal(calls, 1);
    await assert.rejects(
      operation === 'search'
        ? adapter.search('test', 10, controller.signal)
        : adapter.answer('test', controller.signal),
      (error) => {
        assert.ok(error instanceof ZhihuAdapterError);
        assert.equal(error.apiError.code, 'UPSTREAM_TIMEOUT');
        assert.equal(error.message.includes('private abort reason'), false);
        return true;
      },
    );
    assert.equal(calls, 1);
  }
});

test('failed search releases scheduler slots and queued cancellation never starts work', async () => {
  const scheduler = new SearchScheduler();
  const active = new AbortController();
  const gate = deferred<void>();
  let starts = 0;
  const running = Array.from({ length: 5 }, () => scheduler.run(async () => {
    starts++;
    await gate.promise;
    throw new Error('test failure');
  }, active.signal).catch(() => {}));
  await tick();
  const canceled = new AbortController();
  const queued = scheduler.run(async () => { starts++; }, canceled.signal);
  canceled.abort();
  await assert.rejects(queued);
  gate.resolve();
  await Promise.all(running);
  assert.equal(starts, 5);
  assert.equal(await scheduler.run(async () => 42, active.signal), 42);
});

test('SSE encodes malformed Unicode node IDs without hanging or ambiguous IDs', async () => {
  const outline = structuredClone(fixture);
  outline.nodes[0].id = '\ud800';
  outline.edges[0].from = '\ud800';
  const handlers = createMapHandlers(new MapGenerationService({
    clientFactory: () => client({ answer: async () => outline }),
  }), () => context);
  const response = await handlers.generate(request({ topic: 'test' }, true));
  const text = await response.text();
  const events = eventsFrom(text);
  assert.equal(events.at(-1)?.event, 'complete');
  assert.ok(events.some((event) => 'nodeId' in event.data && event.data.nodeId === '\ud800'));
  assert.equal(new Set(text.match(/^id: .+$/gm)).size, 8);
});

test('Accept quality weights choose JSON when SSE is disabled or less preferred', async () => {
  const handlers = createMapHandlers(new MapGenerationService({
    clientFactory: () => client(),
  }), () => context);
  for (const accept of ['application/json, text/event-stream;q=0',
    'text/event-stream;q=0.3, application/json;q=0.9', 'text/event-stream-other']) {
    const req = request({ topic: 'test' });
    req.headers.set('Accept', accept);
    const response = await handlers.generate(req);
    assert.ok(response.headers.get('content-type')?.startsWith('application/json'));
    assert.equal((await response.json()).status, 'complete');
  }
  const req = request({ topic: 'test' });
  req.headers.set('Accept', 'application/json;q=0.2, Text/Event-Stream;q=0.8');
  assert.equal(eventsFrom(await (await handlers.generate(req)).text()).at(-1)?.event, 'complete');
});
