import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { PROGRESS_KEY, ProgressStore, parseProgress, progressId } from '../src/client/learning-progress.ts';
import { MapController } from '../src/client/map-controller.ts';
import { MapNavigation } from '../src/client/map-navigation.ts';

const outline = JSON.parse(await readFile('fixtures/outline-calculus.json', 'utf8'));
const resource = {
  title: '测试资源', url: 'https://www.zhihu.com/answer/123', contentId: '123',
  contentType: 'Answer', author: '测试作者', excerpt: '测试摘要',
  voteUpCount: 12, commentCount: 1, editTime: 1, score: 1,
};
function map(topic = '微积分') {
  return {
    ...outline, topic, mapId: `version-${topic}`, progressScope: `map_${topic}`,
    mockMode: false, status: 'complete', completedNodeCount: 6, failedNodeCount: 0, generatedAt: 1,
    nodes: outline.nodes.map((node: object) => ({ ...node, resources: [resource], weight: 1, state: 'ready' })),
  };
}
const tick = () => new Promise<void>((done) => setImmediate(done));
function memoryStorage() {
  const values = new Map<string, string>();
  return {
    values,
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => { values.set(key, value); },
    removeItem: (key: string) => { values.delete(key); },
  };
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

test('progress writes expected key/schema, deduplicates, and restores after refresh', () => {
  const storage = memoryStorage();
  const store = new ProgressStore(() => storage, () => 123);
  store.restore();
  assert.deepEqual(store.snapshot(), { completedNodeIds: [], updatedAt: 0 });
  const id = progressId('微积分', 'limits');
  store.mark(id);
  store.mark(id);
  assert.deepEqual(JSON.parse(storage.values.get(PROGRESS_KEY)!), { completedNodeIds: [id], updatedAt: 123 });
  const refreshed = new ProgressStore(() => storage);
  refreshed.restore();
  assert.deepEqual(refreshed.snapshot(), store.snapshot());
});

test('corrupt and unavailable localStorage degrade without breaking memory progress', () => {
  for (const raw of ['{', 'null', '[]', '{}', '{"completedNodeIds":[1],"updatedAt":1}',
    '{"completedNodeIds":[],"updatedAt":-1}', '{"completedNodeIds":[],"updatedAt":"now"}']) {
    assert.deepEqual(parseProgress(raw), { completedNodeIds: [], updatedAt: 0 });
  }
  const blocked = new ProgressStore(() => { throw new Error('blocked'); });
  blocked.restore();
  blocked.mark('test');
  assert.deepEqual(blocked.snapshot().completedNodeIds, ['test']);
  assert.equal(blocked.clear(), false);
  assert.deepEqual(blocked.snapshot().completedNodeIds, []);
});

test('storage write failures preserve in-memory interaction', () => {
  const store = new ProgressStore(() => ({
    getItem: () => null,
    setItem: () => { throw new Error('quota exceeded'); },
    removeItem: () => {},
  }));
  store.mark('test');
  assert.deepEqual(store.snapshot().completedNodeIds, ['test']);
});

test('stable IDs isolate topics and delimiter collisions and never use mapId', () => {
  assert.equal(progressId(' PYTHON！ ', 'same'), progressId('python', 'same'));
  assert.notEqual(progressId('python', 'same'), progressId('微积分', 'same'));
  assert.notEqual(progressId('a_b', 'c'), progressId('a', 'b_c'));
  assert.notEqual(progressId('a:b', 'c'), progressId('a', 'b:c'));
  assert.equal(progressId('test', 'id', 'map_test'), progressId('TEST', 'id', 'map_test'));
  assert.notEqual(progressId('test', 'id', 'mock:default:test'), progressId('test', 'id', 'map_test'));
});

test('clear removes only progress key and leaves unrelated data intact', () => {
  const storage = memoryStorage();
  storage.setItem('unrelated', 'keep');
  storage.setItem('map-cache', 'keep map');
  const store = new ProgressStore(() => storage);
  store.mark('node');
  assert.equal(store.clear(), true);
  assert.equal(storage.getItem(PROGRESS_KEY), null);
  assert.equal(storage.getItem('unrelated'), 'keep');
  assert.equal(storage.getItem('map-cache'), 'keep map');
});

test('JSON and SSE responses preserve stable progressScope', async () => {
  const json = new MapController(async () => Response.json(map()));
  await json.load('微积分');
  assert.equal(json.snapshot().progressScope, 'map_微积分');
  const frames = [
    { event: 'outline', data: map() },
    ...map().nodes.map((node: { id: string }) => ({
      event: 'resource_ready', data: { mapId: map().mapId, mockMode: false, nodeId: node.id,
        state: 'ready', resources: [resource], weight: 1 },
    })),
    { event: 'complete', data: map() },
  ];
  const sse = new MapController(async () => new Response(frames.map((event) =>
    `event: ${event.event}\ndata: ${JSON.stringify(event.data)}\n\n`).join(''), {
    headers: { 'Content-Type': 'text/event-stream' },
  }));
  await sse.load('微积分');
  assert.equal(sse.snapshot().progressScope, json.snapshot().progressScope);
  assert.deepEqual(sse.snapshot().nodes.map((node) => node.state), json.snapshot().nodes.map((node) => node.state));
});

test('JSON partial maps remain partial and can use independent local progress', async () => {
  const value = map();
  value.status = 'partial';
  value.failedNodeCount = 1;
  value.nodes[1] = { ...value.nodes[1], state: 'error', resources: [], weight: 0,
    error: { code: 'UPSTREAM_TIMEOUT', message: '超时', retryable: true } };
  const controller = new MapController(async () => Response.json(value));
  await controller.load('微积分');
  assert.equal(controller.snapshot().originalStatus, 'partial');
  const storage = memoryStorage();
  const store = new ProgressStore(() => storage);
  store.mark(progressId('微积分', 'functions', controller.snapshot().progressScope));
  assert.equal(store.snapshot().completedNodeIds.length, 1);
  assert.equal(controller.snapshot().originalStatus, 'partial');
});

test('drilldown has one level and retains parent topic, node and breadcrumb', async () => {
  const bodies: unknown[] = [];
  const navigation = new MapNavigation(async (_url, init) => {
    const input = JSON.parse(String(init!.body));
    bodies.push(input);
    return Response.json(map(input.topic));
  });
  await navigation.load('微积分');
  const parent = navigation.parent.snapshot();
  assert.equal(navigation.enter('functions'), true);
  await tick();
  assert.equal(navigation.enter('limits'), false);
  assert.deepEqual(navigation.snapshot().snapshot().drilldown, {
    depth: 1, parentTopic: '微积分', parentNodeId: 'functions', topic: '函数基础',
    breadcrumb: ['微积分', '函数基础'],
  });
  assert.deepEqual(bodies, [{ topic: '微积分' }, { topic: '函数基础' }]);
  navigation.back();
  assert.equal(navigation.snapshot(), navigation.parent);
  assert.equal(navigation.parent.snapshot(), parent);
});

test('child failure and cancellation cannot mutate parent or resurrect a departed child', async () => {
  const pending = deferred<Response>();
  let calls = 0;
  let signal: AbortSignal | undefined;
  const navigation = new MapNavigation(async (_url, init) => {
    if (++calls === 1) return Response.json(map());
    signal = init?.signal ?? undefined;
    return pending.promise;
  });
  await navigation.load('微积分');
  const parent = navigation.parent.snapshot();
  navigation.enter('functions');
  const child = navigation.snapshot();
  navigation.back();
  assert.ok(signal?.aborted);
  pending.resolve(Response.json(map('函数基础')));
  await tick();
  assert.equal(navigation.snapshot(), navigation.parent);
  assert.equal(navigation.parent.snapshot(), parent);
  assert.notEqual(child.snapshot().phase, 'finished');

  const failed = new MapNavigation(async (_url, init) => {
    const { topic } = JSON.parse(String(init!.body));
    return topic === '微积分' ? Response.json(map()) : Response.json({
      mockMode: false, error: { code: 'UPSTREAM_TIMEOUT', message: '下钻失败', retryable: true },
    }, { status: 504 });
  });
  await failed.load('微积分');
  const before = failed.parent.snapshot();
  failed.enter('functions');
  await tick();
  assert.equal(failed.snapshot().snapshot().phase, 'failed');
  failed.back();
  assert.equal(failed.parent.snapshot(), before);
});

test('old JSON parsing result cannot replace a newer request', async () => {
  const slow = deferred<unknown>();
  let calls = 0;
  const controller = new MapController(async () => {
    if (++calls === 1) {
      const response = Response.json({});
      response.json = () => slow.promise;
      return response;
    }
    return Response.json(map('摄影'));
  });
  const first = controller.load('微积分');
  await tick();
  await controller.load('摄影');
  slow.resolve(map());
  await first;
  assert.equal(controller.snapshot().topic, '摄影');
  assert.equal(controller.snapshot().progressScope, 'map_摄影');
});

test('failed clear does not resurrect cleared records on the next mark or restore', () => {
  const storage = memoryStorage();
  storage.setItem(PROGRESS_KEY, JSON.stringify({ completedNodeIds: ['old'], updatedAt: 1 }));
  const store = new ProgressStore(() => ({ ...storage, removeItem: () => { throw new Error('blocked'); } }));
  store.restore();
  assert.equal(store.clear(), false);
  store.restore();
  assert.deepEqual(store.snapshot().completedNodeIds, []);
  store.mark('new');
  assert.deepEqual(store.snapshot().completedNodeIds, ['new']);
  assert.deepEqual(JSON.parse(storage.getItem(PROGRESS_KEY)!).completedNodeIds, ['new']);
});

test('unreadable or corrupt subsequent restore preserves current session marks', () => {
  const storage = memoryStorage();
  let blocked = false;
  const store = new ProgressStore(() => { if (blocked) throw new Error('blocked'); return storage; });
  store.mark('session');
  blocked = true;
  store.restore();
  assert.deepEqual(store.snapshot().completedNodeIds, ['session']);
  blocked = false;
  storage.setItem(PROGRESS_KEY, 'broken');
  store.restore();
  assert.deepEqual(store.snapshot().completedNodeIds, ['session']);
  storage.removeItem(PROGRESS_KEY);
  store.restore();
  assert.deepEqual(store.snapshot().completedNodeIds, []);
});

test('oversized drilldown titles cannot strand navigation away from its parent', async () => {
  const value = map();
  value.nodes[0].title = 'x'.repeat(201);
  const navigation = new MapNavigation(async () => Response.json(value));
  await navigation.load('微积分');
  assert.equal(navigation.enter('functions'), false);
  assert.equal(navigation.snapshot(), navigation.parent);
});
