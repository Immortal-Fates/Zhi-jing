import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import type { SseEvent } from '../types/api.ts';
import { MapEventDecoder } from '../src/client/map-events.ts';
import {
  animatedNodeLayout, CARD, COLUMN_GAP, estimateSatelliteHeight, estimateSummaryExtra,
  MapController, ROW_GAP, SATELLITE, SATELLITE_RESERVE, TARGET_ASPECT, mapLayout,
  nodeRadius, safeResourceUrl, satelliteOpensLeft, satellitePosition, satelliteStackPositions,
  weightedCharCount,
} from '../src/client/map-controller.ts';

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
  assert.equal(nodeRadius(0), 24);
  assert.equal(nodeRadius(3), 44);
  assert.equal(nodeRadius(1.5), 34);
  assert.equal(nodeRadius(Infinity), 24);
  assert.equal(nodeRadius(-1), 24);
  assert.equal(safeResourceUrl(resource.url, true), undefined);
  assert.ok(safeResourceUrl(resource.url, false));
  for (const url of ['javascript:alert(1)', 'https://zhihu.com.evil.example/x', 'https://x:y@www.zhihu.com/x', 'http://www.zhihu.com/x']) {
    assert.equal(safeResourceUrl(url, false), undefined);
  }
});

test('layout builds level columns, centers short columns and targets the wide canvas ratio', () => {
  const nodes = [
    { id: 'a1', level: 1 as const }, { id: 'a2', level: 1 as const }, { id: 'a3', level: 1 as const },
    { id: 'b1', level: 2 as const }, { id: 'b2', level: 2 as const },
    { id: 'c1', level: 3 as const },
  ];
  const { positions, width, height, rowGap } = mapLayout(nodes);
  assert.equal(height, 2 * rowGap + CARD.height);
  assert.ok(rowGap >= ROW_GAP.min && rowGap <= ROW_GAP.max);
  // The fitted box includes the satellite reserve; for 3 rows ROW_GAP.min gives a comfortable ~1.93-2.4 widescreen ratio.
  const fittedAspect = width / (height + 2 * SATELLITE_RESERVE);
  assert.ok(fittedAspect >= 1.85 && fittedAspect <= TARGET_ASPECT + 0.1,
    `fitted aspect ratio ${fittedAspect} should be comfortably widescreen`);
  // Levels are columns and every column shares one x.
  assert.equal(positions.a1.x, 0);
  assert.equal(positions.a2.x, 0);
  assert.equal(positions.b1.x, positions.b2.x);
  assert.equal(positions.c1.x, 2 * positions.b1.x);
  assert.equal(positions.c1.x + CARD.width, width);
  // Rows stack by the derived gap and shorter columns are vertically centered.
  assert.equal(positions.a2.y - positions.a1.y, rowGap);
  assert.equal(positions.a1.y, 0);
  assert.equal(positions.b1.y, rowGap / 2);
  assert.equal(positions.c1.y, rowGap);
  for (const node of nodes) {
    assert.ok(positions[node.id].y >= 0);
    assert.ok(positions[node.id].y + CARD.height <= height);
  }
});

test('columns reserve satellite room so expanded resources never cover the next column', () => {
  const { positions } = mapLayout([
    { id: 'a', level: 1 }, { id: 'b', level: 2 }, { id: 'c', level: 3 },
  ]);
  for (const [id, level] of [['a', 1], ['b', 2]] as const) {
    for (let order = 0; order < 3; order++) {
      const spot = satellitePosition(positions[id], level, order);
      assert.ok(spot.x >= positions[id].x + CARD.width, 'satellites start outside their own card');
      const next = level === 1 ? positions.b : positions.c;
      assert.ok(spot.x + SATELLITE.width <= next.x, `${spot.x + SATELLITE.width} must not reach ${next.x}`);
    }
  }
  // The last column opens leftwards, so the board never needs space beyond the final card.
  assert.ok(satelliteOpensLeft(3));
  for (let order = 0; order < 3; order++) {
    const spot = satellitePosition(positions.c, 3, order);
    assert.ok(spot.x + SATELLITE.width <= positions.c.x, 'level 3 satellites stay left of the card');
    assert.ok(spot.x >= positions.b.x + CARD.width, 'level 3 satellites clear the previous column');
  }
  assert.equal(positions.b.x - positions.a.x, COLUMN_GAP);
});

test('satellites stack smoothly and center on their card with content-driven heights', () => {
  const anchor = { x: 0, y: 500 };
  const items = [
    { title: '短标题' },
    { title: '中等长度的知乎精彩回答标题，通常两行' },
    { title: '非常长的知乎深度长文专栏文章标题，分析十分细致并且内容极为丰富，甚至需要占据四行之多才能完全展现' },
  ];
  const h0 = estimateSatelliteHeight(items[0].title);
  const h1 = estimateSatelliteHeight(items[1].title);
  const h2 = estimateSatelliteHeight(items[2].title);

  assert.ok(h0 >= SATELLITE.minHeight);
  assert.ok(h2 > h0, `Longer title should be taller than short: ${h2} > ${h0}`);
  assert.ok(h2 <= SATELLITE.maxHeight);

  const stack = satelliteStackPositions(anchor, 1, items);
  assert.equal(stack.length, 3);
  assert.equal(stack[0].height, h0);
  assert.equal(stack[1].height, h1);
  assert.equal(stack[2].height, h2);

  // Stacking is contiguous with itemGap and no overlap
  assert.equal(stack[1].y, stack[0].y + h0 + SATELLITE.itemGap);
  assert.equal(stack[2].y, stack[1].y + h1 + SATELLITE.itemGap);

  // Stack is vertically centered on anchor
  const totalH = h0 + h1 + h2 + 2 * SATELLITE.itemGap;
  const middleY = stack[0].y + totalH / 2;
  assert.equal(middleY, anchor.y + CARD.height / 2);
});

test('animatedNodeLayout shifts nodes in the same column downward without occluding cards', () => {
  const nodes = [
    { id: 'top', level: 1 as const, summary: '极度简短的简介，适合两行内' },
    { id: 'middle', level: 1 as const, summary: '这是一篇极其详尽的微积分学习简介，包含了极其丰富的内容与背景介绍，需要展开多行才能完整阅读所有内容' },
    { id: 'bottom', level: 1 as const, summary: '末尾节点' },
    { id: 'otherCol', level: 2 as const, summary: '不同列的节点' },
  ];
  const basePositions = {
    top: { x: 0, y: 0 },
    middle: { x: 0, y: 200 },
    bottom: { x: 0, y: 400 },
    otherCol: { x: 500, y: 200 },
  };

  const extra = estimateSummaryExtra(nodes[1].summary);
  assert.ok(extra > 0, 'Long summary should produce positive extra height');

  // At progress 0: no extra height, no shift
  const zero = animatedNodeLayout(nodes, basePositions, 'middle', 0);
  assert.equal(zero.heights.middle, CARD.height);
  assert.equal(zero.positions.bottom.y, 400);

  // At progress 1: middle expands, bottom shifts down by extra
  const full = animatedNodeLayout(nodes, basePositions, 'middle', 1);
  assert.equal(full.heights.middle, CARD.height + extra);
  assert.equal(full.positions.top.y, 0); // node above does not move
  assert.equal(full.positions.bottom.y, 400 + extra); // node below shifts down
  assert.equal(full.positions.otherCol.y, 200); // other column unaffected

  // No overlap: bottom.y > middle.y + middle.height
  assert.ok(full.positions.bottom.y >= full.positions.middle.y + full.heights.middle,
    'Shifted bottom node must never be occluded by expanded middle node');
});

test('layout keeps a column gap floor so sparse maps never overlap cards', () => {
  const { positions, width, height, rowGap } = mapLayout([
    { id: 'a', level: 1 }, { id: 'b', level: 2 }, { id: 'c', level: 3 },
  ]);
  assert.ok(positions.b.x >= CARD.width);
  assert.equal(positions.a.y, 0);
  assert.equal(positions.b.y, 0);
  assert.equal(height, CARD.height);
  assert.equal(rowGap, ROW_GAP.min);
  assert.equal(width, 2 * positions.b.x + CARD.width);
});

test('layout tolerates missing levels without collapsing positions', () => {
  const { positions, height } = mapLayout([{ id: 'only', level: 2 }]);
  assert.equal(height, CARD.height);
  assert.equal(positions.only.y, 0);
  assert.equal(positions.only.x, COLUMN_GAP);
});

test('auto-recovery sequentially retries recoverable node errors on stream complete and skips empty nodes', async () => {
  const channel = stream();
  const retryCalls: string[] = [];
  const controller = new MapController(async (input, init) => {
    const url = String(input);
    if (url === '/api/generate') return channel.response;
    if (url === '/api/resources') {
      const body = JSON.parse(String(init?.body)) as { nodeId: string };
      retryCalls.push(body.nodeId);
      return new Response(JSON.stringify({
        ok: true, mockMode: true, nodeId: body.nodeId,
        state: 'ready', weight: 2, resources: [resource],
      }), { headers: { 'Content-Type': 'application/json' } });
    }
    throw new Error(`unexpected url ${url}`);
  }, 0); // 0 delay for instant unit tests

  const loadPromise = controller.load('test');
  channel.send(skeleton);
  // Send one empty, one recoverable error, one non-retryable error
  channel.send(
    { event: 'resource_empty', data: { ...identity, nodeId: 'limits', state: 'empty', resources: [], weight: 0 } },
    { event: 'resource_error', data: {
      ...identity, nodeId: 'functions', state: 'error', resources: [], weight: 0, errorCode: 'timeout',
      error: { code: 'UPSTREAM_TIMEOUT', message: '超时', retryable: true },
    } },
    { event: 'resource_error', data: {
      ...identity, nodeId: 'derivatives', state: 'error', resources: [], weight: 0, errorCode: 'quota_exhausted',
      error: { code: 'QUOTA_EXHAUSTED', message: '额度已尽', retryable: false },
    } },
  );
  channel.send(complete);
  channel.end();
  await loadPromise;

  // Only the retryable error ('functions') should be retried, not empty ('limits') and not non-retryable ('derivatives')
  assert.deepEqual(retryCalls, ['functions']);
  const snap = controller.snapshot();
  assert.equal(snap.phase, 'finished');
  assert.equal(snap.recovering, false);
  const fnNode = snap.nodes.find((n) => n.id === 'functions');
  assert.equal(fnNode?.state, 'ready');
  assert.equal(fnNode?.resources.length, 1);
  const limitsNode = snap.nodes.find((n) => n.id === 'limits');
  assert.equal(limitsNode?.state, 'empty');
  const derNode = snap.nodes.find((n) => n.id === 'derivatives');
  assert.equal(derNode?.state, 'error');
});

test('auto-recovery aborts cleanly when controller is cancelled mid-recovery', async () => {
  const channel = stream();
  let retryStarted = false;
  const retryGate = deferred<void>();
  const controller = new MapController(async (input) => {
    const url = String(input);
    if (url === '/api/generate') return channel.response;
    if (url === '/api/resources') {
      retryStarted = true;
      await retryGate.promise;
      return new Response(JSON.stringify({ ok: true, mockMode: true, nodeId: 'functions', state: 'ready', weight: 1, resources: [] }),
        { headers: { 'Content-Type': 'application/json' } });
    }
    throw new Error(`unexpected url ${url}`);
  }, 0);

  const loadPromise = controller.load('test');
  channel.send(skeleton, failed, complete);
  channel.end();

  // Wait until retry starts
  for (let i = 0; i < 20 && !retryStarted; i++) await tick();
  assert.ok(retryStarted, 'retry should have started');
  assert.equal(controller.snapshot().recovering, true);

  controller.cancel();
  retryGate.resolve();
  await loadPromise;

  assert.equal(controller.snapshot().recovering, false);
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
