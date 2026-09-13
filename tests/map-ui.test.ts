import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import type { SseEvent } from '../types/api.ts';
import { MapEventDecoder } from '../src/client/map-events.ts';
import { MapController, nodeRadius, safeResourceUrl } from '../src/client/map-controller.ts';

const outline = JSON.parse(await readFile('fixtures/outline-calculus.json', 'utf8'));
const identity = { mapId: 'test-map', mockMode: true };
const skeleton: SseEvent = { event: 'outline', data: { ...outline, ...identity, progressScope: 'mock:default:test' } };
const resource = {
  title: '示例', url: 'https://www.zhihu.com/answer/123', contentType: 'Answer', contentId: '123',
  author: '作者', excerpt: '摘要', editTime: 1, voteUpCount: 10, commentCount: 2, score: 1,
};
const frame = (event: SseEvent) => `event: ${event.event}\ndata: ${JSON.stringify(event.data)}\n\n`;
const encoder = new TextEncoder();
const complete: SseEvent = { event: 'complete', data: {
  ...identity, status: 'partial', completedNodeCount: 6, failedNodeCount: 1, generatedAt: 1,
} };
const empty: SseEvent = { event: 'resource_empty', data: {
  ...identity, nodeId: 'limits', state: 'empty', resources: [], weight: 0,
} };
const failed: SseEvent = { event: 'resource_error', data: {
  ...identity, nodeId: 'functions', state: 'error', resources: [], weight: 0, errorCode: 'timeout',
  error: { code: 'UPSTREAM_TIMEOUT', message: '超时', retryable: true },
} };
function stream() {
  let writer!: ReadableStreamDefaultController<Uint8Array>;
  const body = new ReadableStream<Uint8Array>({ start(c) { writer = c; } });
  return { response: new Response(body, { headers: { 'Content-Type': 'text/event-stream' } }),
    send: (...events: SseEvent[]) => writer.enqueue(encoder.encode(events.map(frame).join(''))),
    end: () => writer.close() };
}
const tick = () => new Promise<void>((done) => setImmediate(done));
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

test('SSE parser handles every UTF8 byte boundary, CRLF and multiple events', () => {
  const received: SseEvent[] = [];
  const decoder = new MapEventDecoder((e) => received.push(e));
  const bytes = encoder.encode(`: heartbeat\r\n\r\n${frame(skeleton)}${frame(empty)}${frame(complete)}`.replace(/\n/g, '\r\n'));
  for (const byte of bytes) decoder.push(new Uint8Array([byte]));
  decoder.finish();
  assert.deepEqual(received, [skeleton, empty, complete]);
});

test('SSE parser supports multiline data and ignores unknown event names', () => {
  const received: SseEvent[] = [];
  const decoder = new MapEventDecoder((e) => received.push(e));
  const json = JSON.stringify(complete.data, null, 2).split('\n').map((line) => `data: ${line}`).join('\n');
  decoder.push(encoder.encode(`event: future\ndata: {}\n\nevent: complete\n${json}\n\n`));
  decoder.finish();
  assert.deepEqual(received, [complete]);
});

test('SSE parser rejects incomplete trailing event, malformed JSON and bad structure', () => {
  const decoder = new MapEventDecoder(() => {});
  decoder.push(encoder.encode(frame(complete).slice(0, -1)));
  assert.throws(() => decoder.finish());
  for (const body of ['event: complete\ndata: {\n\n', 'event: outline\ndata: {}\n\n']) {
    assert.throws(() => new MapEventDecoder(() => {}).push(encoder.encode(body)));
  }
});

test('controller reuses contracts, keeps partial status and treats empty as normal', async () => {
  const source = stream();
  const controller = new MapController(async () => source.response);
  const task = controller.load('test');
  source.send(skeleton, skeleton, empty, empty, failed, complete);
  await task;
  const view = controller.snapshot();
  assert.equal(view.nodes.length, 6);
  assert.equal(view.phase, 'finished');
  assert.equal(view.originalStatus, 'partial');
  assert.equal(view.nodes.find((n) => n.id === 'limits')!.state, 'empty');
  assert.equal(view.nodes.find((n) => n.id === 'functions')!.state, 'error');
});

test('retries are deduplicated, survive complete, and never rewrite original status', async () => {
  const source = stream();
  const retry = deferred<Response>();
  let retries = 0;
  const controller = new MapController(async (url) => {
    if (url === '/api/resources') { retries++; return retry.promise; }
    return source.response;
  });
  const task = controller.load('test');
  source.send(skeleton, failed);
  await tick();
  const a = controller.retry('functions');
  const b = controller.retry('functions');
  assert.equal(controller.snapshot().nodes[0].state, 'retrying');
  source.send(complete);
  await task;
  retry.resolve(Response.json({ ok: true, ...identity, nodeId: 'functions', state: 'ready', weight: 1, resources: [resource] }));
  await Promise.all([a, b]);
  assert.equal(retries, 1);
  assert.equal(controller.snapshot().originalStatus, 'partial');
  assert.equal(controller.snapshot().nodes[0].state, 'ready');
});

test('switching topics aborts subscriptions and rejects old retry results even for reused mapId', async () => {
  const a = stream();
  const b = stream();
  const retry = deferred<Response>();
  const signals: AbortSignal[] = [];
  let loads = 0;
  const controller = new MapController(async (url, init) => {
    signals.push(init!.signal!);
    if (url === '/api/resources') return retry.promise;
    return ++loads === 1 ? a.response : b.response;
  });
  const first = controller.load('first');
  a.send(skeleton, failed);
  await tick();
  const attempt = controller.retry('functions');
  const second = controller.load('second');
  b.send(skeleton, empty, complete);
  a.send(empty);
  await Promise.all([first, second]);
  retry.resolve(Response.json({ ok: true, ...identity, nodeId: 'functions', state: 'ready', resources: [resource], weight: 1 }));
  await attempt;
  assert.equal(signals[0].aborted, true);
  assert.equal(controller.snapshot().topic, 'second');
  assert.equal(controller.snapshot().nodes[0].state, 'pending');
  assert.equal(controller.snapshot().nodes.find((n) => n.id === 'limits')!.state, 'empty');
});

test('mapId mismatch and events after terminal cannot replace current nodes', async () => {
  const source = stream();
  const controller = new MapController(async () => source.response);
  const task = controller.load('test');
  source.send(skeleton, { ...empty, data: { ...empty.data, mapId: 'other' } }, complete, failed);
  await task;
  assert.equal(controller.snapshot().nodes[0].state, 'pending');
  assert.equal(controller.snapshot().nodes[1].state, 'pending');
});

test('whole generation errors can arrive before skeleton and non-2xx errors stay visible', async () => {
  const source = stream();
  const controller = new MapController(async () => source.response);
  const task = controller.load('test');
  source.send({ event: 'generation_error', data: { ...identity, error: {
    code: 'NOT_LEARNABLE', message: '不是学习话题', retryable: false,
  } } });
  await task;
  assert.equal(controller.snapshot().phase, 'failed');
  assert.equal(controller.snapshot().error, '不是学习话题');
  const http = new MapController(async () => Response.json({ mockMode: true, error: failed.data.error }, { status: 504 }));
  await http.load('test');
  assert.equal(http.snapshot().error, '超时');
});

test('early EOF reports failure; duplicate loading submissions do not create new requests', async () => {
  const source = stream();
  let calls = 0;
  const controller = new MapController(async () => { calls++; return source.response; });
  const task = controller.load('test');
  await controller.load('test');
  source.send(skeleton);
  source.end();
  await task;
  assert.equal(calls, 1);
  assert.equal(controller.snapshot().phase, 'failed');
});

test('radius represents bounded total display weight and mock links are never active', () => {
  assert.equal(nodeRadius(0), 40);
  assert.equal(nodeRadius(3), 90);
  assert.equal(nodeRadius(1.5), 65);
  assert.equal(nodeRadius(Infinity), 40);
  assert.equal(nodeRadius(-1), 40);
  assert.equal(safeResourceUrl(resource.url, true), undefined);
  assert.ok(safeResourceUrl(resource.url, false));
  for (const url of ['javascript:alert(1)', 'https://zhihu.com.evil.example/x', 'https://x:y@www.zhihu.com/x', 'http://www.zhihu.com/x']) {
    assert.equal(safeResourceUrl(url, false), undefined);
  }
});

test('cancelled subscription can be loaded again with the same topic', async () => {
  const first = stream();
  const second = stream();
  let calls = 0;
  const controller = new MapController(async () => ++calls === 1 ? first.response : second.response);
  const initial = controller.load('test');
  controller.cancel();
  assert.equal(controller.snapshot().phase, 'failed');
  const next = controller.load('test');
  second.send(skeleton, complete);
  await Promise.all([initial, next]);
  assert.equal(calls, 2);
  assert.equal(controller.snapshot().phase, 'finished');
});
