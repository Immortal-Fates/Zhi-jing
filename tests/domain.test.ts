import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import test from 'node:test';

import { validateOutline } from '../src/lib/outline-validator.ts';
import { normalizeTopic } from '../src/lib/topic.ts';

type MutableOutline = {
  topic: string;
  overview: Record<string, unknown>;
  nodes: Array<Record<string, unknown>>;
  edges: Array<Record<string, unknown>>;
};

async function readFixture(name: string): Promise<unknown> {
  return JSON.parse(await readFile(resolve(process.cwd(), 'fixtures', name), 'utf8'));
}

async function readOutline(): Promise<MutableOutline> {
  return structuredClone((await readFixture('outline-calculus.json')) as MutableOutline);
}

function assertInvalidOutline(input: unknown, code: string) {
  const result = validateOutline(input);
  assert.equal(result.ok, false);
  if (result.ok) {
    return;
  }
  assert.equal(result.error.code, 'OUTLINE_INVALID');
  assert.ok(result.error.message);
  assert.equal(result.error.retryable, true);
  assert.ok(result.issues.some((issue) => issue.code === code));
}

test('normalizes topics into cache keys', () => {
  const result = normalizeTopic('  Python   BASICS！  ');
  assert.deepEqual(result, {
    ok: true,
    topic: 'python basics',
    cacheKey: 'python basics',
  });
});

test('normalizes Unicode whitespace and punctuation', () => {
  const result = normalizeTopic('\n\t「  微积分　入门  」\u3000');
  assert.deepEqual(result, {
    ok: true,
    topic: '微积分 入门',
    cacheKey: '微积分 入门',
  });
});

test('rejects empty topics with the unified error structure', () => {
  const result = normalizeTopic('  ……  ');
  assert.deepEqual(result, {
    ok: false,
    error: {
      code: 'INVALID_TOPIC',
      message: '请输入学习话题',
      retryable: false,
    },
  });
});

test('returns independent topic errors', () => {
  const first = normalizeTopic('');
  const second = normalizeTopic('');
  assert.equal(first.ok, false);
  assert.equal(second.ok, false);
  if (first.ok || second.ok) {
    return;
  }
  first.error.message = 'changed locally';
  assert.equal(second.error.message, '请输入学习话题');
});

test('accepts the complete calculus outline fixture', async () => {
  const result = validateOutline(await readFixture('outline-calculus.json'));
  assert.equal(result.ok, true);
  if (!result.ok) {
    return;
  }
  assert.equal(result.value.nodes.length, 6);
  assert.deepEqual(new Set(result.value.nodes.map((node) => node.level)), new Set([1, 2, 3]));
});

test('accepts both node count boundaries', async () => {
  const sixNodes = await readOutline();
  assert.equal(validateOutline(sixNodes).ok, true);

  const tenNodes = await readOutline();
  tenNodes.nodes.push(
    {
      id: 'limits-extra-1',
      title: '极限练习一',
      level: 1,
      summary: '补充练习',
      query: '微积分 极限 练习',
    },
    {
      id: 'limits-extra-2',
      title: '极限练习二',
      level: 1,
      summary: '补充练习',
      query: '微积分 极限 题目',
    },
    {
      id: 'limits-extra-3',
      title: '极限练习三',
      level: 2,
      summary: '补充练习',
      query: '微积分 极限 进阶',
    },
    {
      id: 'limits-extra-4',
      title: '极限练习四',
      level: 3,
      summary: '补充练习',
      query: '微积分 极限 深入',
    },
  );
  assert.equal(validateOutline(tenNodes).ok, true);
});

test('handles oversized invalid graphs without recursion overflow', () => {
  const nodes = Array.from({ length: 1000 }, (_, index) => ({
    id: `node-${index}`,
    title: `节点 ${index}`,
    level: (index % 3) + 1,
    summary: '测试节点',
    query: '测试查询',
  }));
  const edges = nodes.slice(0, -1).map((node, index) => ({
    from: node.id,
    to: nodes[index + 1].id,
    type: 'main',
  }));
  const result = validateOutline({
    topic: '测试',
    overview: { what: '测试', gain: '测试', duration: '测试' },
    nodes,
    edges,
  });
  assert.equal(result.ok, false);
});

test('rejects each invalid outline condition', async (t) => {
  const tooFewNodes = await readOutline();
  tooFewNodes.nodes.pop();
  await t.test('node count', () => assertInvalidOutline(tooFewNodes, 'INVALID_NODE_COUNT'));

  const duplicateIds = await readOutline();
  duplicateIds.nodes[1].id = duplicateIds.nodes[0].id;
  await t.test('duplicate node ids', () => assertInvalidOutline(duplicateIds, 'DUPLICATE_NODE_ID'));

  const invalidLevel = await readOutline();
  invalidLevel.nodes[0].level = 4;
  await t.test('invalid node levels', () => assertInvalidOutline(invalidLevel, 'INVALID_NODE_LEVEL'));

  const invalidNodeId = await readOutline();
  invalidNodeId.nodes[0].id = '  ';
  await t.test('invalid node ids', () => assertInvalidOutline(invalidNodeId, 'INVALID_NODE_ID'));

  const missingLevel = await readOutline();
  for (const node of missingLevel.nodes) {
    node.level = 1;
  }
  await t.test('missing levels', () => assertInvalidOutline(missingLevel, 'MISSING_NODE_LEVEL'));

  const emptyTitle = await readOutline();
  emptyTitle.nodes[0].title = '  ';
  await t.test('empty titles', () => assertInvalidOutline(emptyTitle, 'EMPTY_NODE_FIELD'));

  const emptySummary = await readOutline();
  emptySummary.nodes[0].summary = '';
  await t.test('empty summaries', () => assertInvalidOutline(emptySummary, 'EMPTY_NODE_FIELD'));

  const emptyQuery = await readOutline();
  emptyQuery.nodes[0].query = '';
  await t.test('empty queries', () => assertInvalidOutline(emptyQuery, 'EMPTY_NODE_FIELD'));

  const unknownEdgeNode = await readOutline();
  unknownEdgeNode.edges[0].to = 'missing-node';
  await t.test('unknown edge nodes', () => assertInvalidOutline(unknownEdgeNode, 'UNKNOWN_EDGE_NODE'));

  const invalidEdgeType = await readOutline();
  invalidEdgeType.edges[0].type = 'sideways';
  await t.test('invalid edge types', () => assertInvalidOutline(invalidEdgeType, 'INVALID_EDGE_TYPE'));

  const malformedEdge = await readOutline();
  malformedEdge.edges[0].from = 1;
  await t.test('malformed edges', () => assertInvalidOutline(malformedEdge, 'INVALID_EDGE'));

  const cyclicGraph = await readOutline();
  cyclicGraph.edges.push({ from: 'applications', to: 'functions', type: 'branch' });
  await t.test('cyclic graphs', () => assertInvalidOutline(cyclicGraph, 'CYCLIC_GRAPH'));

  await t.test('invalid root shape', () => assertInvalidOutline(null, 'INVALID_SHAPE'));
});

test('does not mutate invalid outline input', async () => {
  const outline = await readOutline();
  outline.nodes[0].title = '';
  const before = structuredClone(outline);
  validateOutline(outline);
  assert.deepEqual(outline, before);
});

test('loads success and empty resource fixtures', async () => {
  const success = (await readFixture('resources-limits.json')) as {
    Code: number;
    Data: { Items: Array<{ ContentType: string }> };
  };
  const empty = (await readFixture('resources-empty.json')) as {
    Code: number;
    Data: { Items: unknown[]; EmptyReason: string };
  };

  assert.equal(success.Code, 0);
  assert.equal(success.Data.Items.length, 3);
  assert.deepEqual(
    new Set(success.Data.Items.map((item) => item.ContentType)),
    new Set(['Answer', 'Article']),
  );
  assert.equal(empty.Code, 0);
  assert.deepEqual(empty.Data.Items, []);
  assert.ok(empty.Data.EmptyReason);
});

test('loads upstream failure fixtures without credentials', async () => {
  const invalidOutline = (await readFixture('outline-invalid.json')) as {
    choices: Array<{ message: { content: string } }>;
  };
  const timeout = (await readFixture('upstream-timeout.json')) as {
    ok: false;
    error: { code: string; message: string; retryable: boolean };
  };
  const rateLimited = (await readFixture('upstream-rate-limited.json')) as { Code: number };
  const quotaExhausted = (await readFixture('upstream-quota-exhausted.json')) as { Code: number };
  const auth = (await readFixture('upstream-auth.json')) as { Code: number };

  assert.throws(() => JSON.parse(invalidOutline.choices[0].message.content));
  assert.equal(timeout.ok, false);
  assert.equal(timeout.error.code, 'UPSTREAM_TIMEOUT');
  assert.equal(timeout.error.retryable, true);
  assert.ok(timeout.error.message);
  assert.equal(rateLimited.Code, 30001);
  assert.equal(quotaExhausted.Code, 30002);
  assert.equal(auth.Code, 20001);
});
