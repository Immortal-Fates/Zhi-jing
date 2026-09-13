import type { ApiError } from '../../types/api.ts';
import type {
  KnowledgeMapOutline,
  NodeLevel,
} from '../../types/domain.ts';

export type OutlineIssueCode =
  | 'INVALID_SHAPE'
  | 'INVALID_FIELD'
  | 'INVALID_NODE_COUNT'
  | 'DUPLICATE_NODE_ID'
  | 'INVALID_NODE_ID'
  | 'INVALID_NODE_LEVEL'
  | 'MISSING_NODE_LEVEL'
  | 'EMPTY_NODE_FIELD'
  | 'INVALID_EDGE'
  | 'UNKNOWN_EDGE_NODE'
  | 'INVALID_EDGE_TYPE'
  | 'CYCLIC_GRAPH';

export interface OutlineValidationIssue {
  code: OutlineIssueCode;
  path: string;
  message: string;
}

export type OutlineValidationResult =
  | {
      ok: true;
      value: KnowledgeMapOutline;
    }
  | {
      ok: false;
      error: ApiError;
      issues: OutlineValidationIssue[];
    };

interface RecordValue {
  [key: string]: unknown;
}

function isRecord(value: unknown): value is RecordValue {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasText(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function isNodeLevel(value: unknown): value is NodeLevel {
  return value === 1 || value === 2 || value === 3;
}

function hasCycle(adjacency: Map<string, string[]>): boolean {
  const colors = new Map<string, 0 | 1 | 2>();

  for (const startId of adjacency.keys()) {
    if ((colors.get(startId) ?? 0) !== 0) {
      continue;
    }

    colors.set(startId, 1);
    const stack: Array<{ nodeId: string; nextIndex: number }> = [
      { nodeId: startId, nextIndex: 0 },
    ];

    while (stack.length > 0) {
      const frame = stack[stack.length - 1];
      const neighbors = adjacency.get(frame.nodeId) ?? [];

      if (frame.nextIndex >= neighbors.length) {
        colors.set(frame.nodeId, 2);
        stack.pop();
        continue;
      }

      const nextId = neighbors[frame.nextIndex];
      frame.nextIndex += 1;
      const nextColor = colors.get(nextId) ?? 0;
      if (nextColor === 1) {
        return true;
      }
      if (nextColor === 0) {
        colors.set(nextId, 1);
        stack.push({ nodeId: nextId, nextIndex: 0 });
      }
    }
  }

  return false;
}

export function validateOutline(input: unknown): OutlineValidationResult {
  const error: ApiError = {
    code: 'OUTLINE_INVALID',
    message: '大纲数据校验失败',
    retryable: true,
  };
  const issues: OutlineValidationIssue[] = [];

  if (!isRecord(input)) {
    return {
      ok: false,
      error,
      issues: [
        {
          code: 'INVALID_SHAPE',
          path: '',
          message: '大纲必须是对象',
        },
      ],
    };
  }

  if (!hasText(input.topic)) {
    issues.push({
      code: 'INVALID_FIELD',
      path: 'topic',
      message: 'topic 不能为空',
    });
  }

  const overview = input.overview;
  if (!isRecord(overview)) {
    issues.push({
      code: 'INVALID_SHAPE',
      path: 'overview',
      message: 'overview 必须是对象',
    });
  } else {
    for (const field of ['what', 'gain', 'duration']) {
      if (!hasText(overview[field])) {
        issues.push({
          code: 'INVALID_FIELD',
          path: `overview.${field}`,
          message: `${field} 不能为空`,
        });
      }
    }
  }

  const nodes = input.nodes;
  const nodeIds = new Set<string>();
  const levels = new Set<NodeLevel>();

  if (!Array.isArray(nodes)) {
    issues.push({
      code: 'INVALID_SHAPE',
      path: 'nodes',
      message: 'nodes 必须是数组',
    });
  } else {
    if (nodes.length < 6 || nodes.length > 10) {
      issues.push({
        code: 'INVALID_NODE_COUNT',
        path: 'nodes',
        message: '节点数量必须在 6 到 10 个之间',
      });
    }

    for (const [index, node] of nodes.entries()) {
      const path = `nodes[${index}]`;
      if (!isRecord(node)) {
        issues.push({
          code: 'INVALID_SHAPE',
          path,
          message: '节点必须是对象',
        });
        continue;
      }

      if (!hasText(node.id)) {
        issues.push({
          code: 'INVALID_NODE_ID',
          path: `${path}.id`,
          message: '节点 id 不能为空',
        });
      } else if (nodeIds.has(node.id)) {
        issues.push({
          code: 'DUPLICATE_NODE_ID',
          path: `${path}.id`,
          message: `节点 id 重复：${node.id}`,
        });
      } else {
        nodeIds.add(node.id);
      }

      if (!isNodeLevel(node.level)) {
        issues.push({
          code: 'INVALID_NODE_LEVEL',
          path: `${path}.level`,
          message: '节点 level 只能是 1、2 或 3',
        });
      } else {
        levels.add(node.level);
      }

      for (const field of ['title', 'summary', 'query']) {
        if (!hasText(node[field])) {
          issues.push({
            code: 'EMPTY_NODE_FIELD',
            path: `${path}.${field}`,
            message: `${field} 不能为空`,
          });
        }
      }
    }

    for (const level of [1, 2, 3] as const) {
      if (!levels.has(level)) {
        issues.push({
          code: 'MISSING_NODE_LEVEL',
          path: 'nodes',
          message: `缺少 level ${level} 节点`,
        });
      }
    }
  }

  const edges = input.edges;
  const adjacency = new Map<string, string[]>();
  for (const nodeId of nodeIds) {
    adjacency.set(nodeId, []);
  }

  if (!Array.isArray(edges)) {
    issues.push({
      code: 'INVALID_SHAPE',
      path: 'edges',
      message: 'edges 必须是数组',
    });
  } else {
    for (const [index, edge] of edges.entries()) {
      const path = `edges[${index}]`;
      if (!isRecord(edge)) {
        issues.push({
          code: 'INVALID_EDGE',
          path,
          message: '边必须是对象',
        });
        continue;
      }

      const from = edge.from;
      const to = edge.to;
      const type = edge.type;

      if (typeof from !== 'string' || typeof to !== 'string') {
        issues.push({
          code: 'INVALID_EDGE',
          path,
          message: '边必须包含字符串 from 和 to',
        });
      } else {
        if (!nodeIds.has(from) || !nodeIds.has(to)) {
          issues.push({
            code: 'UNKNOWN_EDGE_NODE',
            path,
            message: '边的起点和终点必须引用存在的节点',
          });
        } else {
          adjacency.get(from)?.push(to);
        }
      }

      if (type !== 'main' && type !== 'branch') {
        issues.push({
          code: 'INVALID_EDGE_TYPE',
          path: `${path}.type`,
          message: '边 type 只能是 main 或 branch',
        });
      }
    }
  }

  if (hasCycle(adjacency)) {
    issues.push({
      code: 'CYCLIC_GRAPH',
      path: 'edges',
      message: '大纲图不能成环',
    });
  }

  if (issues.length > 0) {
    return { ok: false, error, issues };
  }

  return {
    ok: true,
    value: input as unknown as KnowledgeMapOutline,
  };
}
