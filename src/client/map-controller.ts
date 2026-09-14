import type { ApiError, SseEvent } from '../../types/api.ts';
import type {
  DrilldownContext, GenerationStatus, MapEdge, MapNode, MapOverview, NodeLevel,
} from '../../types/domain.ts';
import { isApiError, isKnowledgeMap, isResourceResponse, MapEventDecoder } from './map-events.ts';

export interface MapView {
  requestId: number;
  topic: string;
  mapId?: string;
  mockMode?: boolean;
  progressScope?: string;
  overview?: MapOverview;
  nodes: MapNode[];
  edges: MapEdge[];
  phase: 'idle' | 'loading' | 'streaming' | 'finished' | 'failed';
  originalStatus?: GenerationStatus;
  /** True while failed nodes are being retried automatically after the stream completed. */
  recovering?: boolean;
  error?: string;
  drilldown?: DrilldownContext;
}

/** How many automatic sweeps run over retryable node failures before the user has to step in. */
export const AUTO_RECOVER_ROUNDS = 2;

export const CARD = { width: 360, height: 150 };
export const SATELLITE = { width: 280, minHeight: 128, maxHeight: 184, itemGap: 12, inset: 26 };
// Column spacing fits a satellite stack beside a card, so resources never cover a neighbour column.
export const COLUMN_GAP = CARD.width + 2 * SATELLITE.inset + SATELLITE.width;
// A satellite stack is taller than a card; the fitted view always reserves this much above and below
// so expanding a node never needs to move the viewport.
export const SATELLITE_RESERVE = (3 * SATELLITE.maxHeight + 2 * SATELLITE.itemGap - CARD.height) / 2;
export const ROW_GAP = { min: 176, max: 470 };
export const TARGET_ASPECT = 2.4;

export function nodeRadius(weight: number): number {
  return 24 + 20 * Math.min(1, Math.max(0, Number.isFinite(weight) ? weight / 3 : 0));
}

// Estimates text line length considering CJK (full width) vs ASCII (half width).
export function weightedCharCount(text: string): number {
  let count = 0;
  for (const char of text) {
    const code = char.codePointAt(0) ?? 0;
    // CJK Unified Ideographs, Kana, Hangul, Fullwidth Forms
    if (
      (code >= 0x4e00 && code <= 0x9fff) ||
      (code >= 0x3400 && code <= 0x4dbf) ||
      (code >= 0x3040 && code <= 0x30ff) ||
      (code >= 0xac00 && code <= 0xd7af) ||
      (code >= 0xff01 && code <= 0xffee)
    ) {
      count += 1;
    } else {
      count += 0.55;
    }
  }
  return count;
}

// Satellite title height adapts to content up to 4 lines (max ~184px).
export function estimateSatelliteHeight(title: string): number {
  const weighted = weightedCharCount(title);
  // In a 250px container with 13.5px font, approx 16 CJK chars or 28 ASCII chars per line
  const lines = Math.min(4, Math.max(1, Math.ceil(weighted / 15.5)));
  // Base fixed elements: padding(22) + eyebrow(15) + margins(18) + author(16) + bottom(25) ≈ 96px
  // Plus title line height ≈ 20px per line
  return Math.min(SATELLITE.maxHeight, Math.max(SATELLITE.minHeight, 88 + lines * 20));
}

// Extra height required when a knowledge summary expands from 2 lines to full content.
export function estimateSummaryExtra(summary: string): number {
  const weighted = weightedCharCount(summary);
  if (weighted <= 44) return 0; // Fits within 2 lines
  const extraLines = Math.min(5, Math.ceil((weighted - 44) / 22));
  return extraLines * 18;
}

// The last column opens its satellites leftwards into the reserved gap, so the fitted board never
// needs dead space beyond the card columns.
export function satelliteOpensLeft(level: NodeLevel): boolean {
  return level === 3;
}

export function satellitePosition(
  anchor: { x: number; y: number }, level: NodeLevel, order: number,
): { x: number; y: number } {
  const legacyGap = SATELLITE.minHeight + SATELLITE.itemGap;
  return {
    x: satelliteOpensLeft(level)
      ? anchor.x - SATELLITE.width - SATELLITE.inset
      : anchor.x + CARD.width + SATELLITE.inset,
    y: anchor.y + (CARD.height - SATELLITE.minHeight) / 2 + (order - 1) * legacyGap,
  };
}

// Stacks multiple variable-height satellites smoothly centered on the anchor node.
export function satelliteStackPositions(
  anchor: { x: number; y: number },
  level: NodeLevel,
  items: readonly { title: string }[],
): Array<{ x: number; y: number; height: number }> {
  if (!items.length) return [];
  const heights = items.map((item) => estimateSatelliteHeight(item.title));
  const totalHeight = heights.reduce((sum, h) => sum + h, 0) + (items.length - 1) * SATELLITE.itemGap;
  const startY = anchor.y + (CARD.height - totalHeight) / 2;
  const x = satelliteOpensLeft(level)
    ? anchor.x - SATELLITE.width - SATELLITE.inset
    : anchor.x + CARD.width + SATELLITE.inset;

  let currentY = startY;
  return heights.map((height) => {
    const pos = { x, y: currentY, height };
    currentY += height + SATELLITE.itemGap;
    return pos;
  });
}

// Computes animated positions and heights during summary expansion so that nodes
// in the same column below the expanded node shift downwards smoothly without any occlusion.
export function animatedNodeLayout(
  nodes: readonly { id: string; level: NodeLevel; summary?: string }[],
  basePositions: Record<string, { x: number; y: number }>,
  expandedId: string | undefined,
  progress: number, // 0..1
): {
  positions: Record<string, { x: number; y: number }>;
  heights: Record<string, number>;
  extraHeight: number;
} {
  const positions: Record<string, { x: number; y: number }> = { ...basePositions };
  const heights: Record<string, number> = {};
  for (const node of nodes) {
    heights[node.id] = CARD.height;
  }

  if (!expandedId || progress <= 0) {
    return { positions, heights, extraHeight: 0 };
  }

  const expandedNode = nodes.find((n) => n.id === expandedId);
  if (!expandedNode) {
    return { positions, heights, extraHeight: 0 };
  }

  const extraHeight = estimateSummaryExtra(expandedNode.summary ?? '');
  const delta = Math.round(extraHeight * progress);

  heights[expandedId] = CARD.height + delta;

  const baseAnchor = basePositions[expandedId];
  if (!baseAnchor) return { positions, heights, extraHeight };

  // Shift nodes in the same column that are positioned lower than the expanded node
  for (const node of nodes) {
    if (node.id === expandedId) continue;
    const base = basePositions[node.id];
    if (base && node.level === expandedNode.level && base.y > baseAnchor.y) {
      positions[node.id] = { x: base.x, y: base.y + delta };
    }
  }

  return { positions, heights, extraHeight };
}

// Levels are columns; row spacing stretches so the fitted board, including satellite reserve,
// lands on the wide target ratio instead of hugging the top of the canvas.
export function mapLayout(nodes: readonly { id: string; level: NodeLevel }[]): {
  positions: Record<string, { x: number; y: number }>;
  width: number;
  height: number;
  rowGap: number;
} {
  const columns: string[][] = [[], [], []];
  for (const node of nodes) columns[node.level - 1].push(node.id);
  const rows = Math.max(1, ...columns.map((column) => column.length));
  const width = 2 * COLUMN_GAP + CARD.width;
  const room = width / TARGET_ASPECT - CARD.height - 2 * SATELLITE_RESERVE;
  const rowGap = rows > 1
    ? Math.min(ROW_GAP.max, Math.max(ROW_GAP.min, Math.round(room / (rows - 1))))
    : ROW_GAP.min;
  const positions: Record<string, { x: number; y: number }> = {};
  columns.forEach((column, level) => {
    const top = (rows - column.length) * rowGap / 2;
    column.forEach((id, row) => {
      positions[id] = { x: level * COLUMN_GAP, y: top + row * rowGap };
    });
  });
  return { positions, width, height: (rows - 1) * rowGap + CARD.height, rowGap };
}

export function safeResourceUrl(url: string, mockMode: boolean): string | undefined {
  if (mockMode) return undefined;
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== 'https:' || parsed.username || parsed.password ||
      !(parsed.hostname === 'zhihu.com' || parsed.hostname.endsWith('.zhihu.com'))) return undefined;
    return parsed.href;
  } catch { return undefined; }
}

const message = (error: unknown) => error instanceof Error ? error.message : '请求失败，请重新加载';
const localError = (text: string): ApiError =>
  ({ code: 'UPSTREAM_ERROR', message: text, retryable: true });

/** Only upstream failures recover on their own; `empty` means the community genuinely has nothing. */
const isRecoverable = (node: MapNode): boolean =>
  node.state === 'error' && node.error?.retryable !== false;

function wait(ms: number, signal: AbortSignal): Promise<void> {
  if (ms <= 0 || signal.aborted) return Promise.resolve();
  return new Promise<void>((resolve) => {
    const done = () => {
      clearTimeout(timer);
      signal.removeEventListener('abort', done);
      resolve();
    };
    const timer = setTimeout(done, ms);
    signal.addEventListener('abort', done, { once: true });
  });
}

export class MapController {
  private value: MapView = { requestId: 0, topic: '', phase: 'idle', nodes: [], edges: [] };
  private readonly listeners = new Set<() => void>();
  private subscription?: AbortController;
  private recovery?: AbortController;
  private readonly retries = new Map<string, AbortController>();
  private received = new Set<string>();
  private terminal = false;

  constructor(
    private readonly fetcher: typeof fetch = (...args) => globalThis.fetch(...args),
    private readonly recoverDelayMs = 900,
  ) {}
  snapshot = (): MapView => this.value;
  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  };
  private update(value: Partial<MapView>): void {
    this.value = { ...this.value, ...value };
    this.listeners.forEach((listener) => listener());
  }

  cancel(): void {
    this.subscription?.abort();
    this.recovery?.abort();
    this.recovery = undefined;
    this.retries.forEach((controller) => controller.abort());
    this.retries.clear();
    this.subscription = undefined;
    const hadRecovering = this.value.recovering;
    if (['loading', 'streaming'].includes(this.value.phase) || this.value.nodes.some((n) => n.state === 'retrying') || hadRecovering) {
      this.update({
        recovering: false,
        phase: ['loading', 'streaming'].includes(this.value.phase) ? 'failed' : this.value.phase,
        error: ['loading', 'streaming'].includes(this.value.phase) ? '订阅已取消，可重新加载' : this.value.error,
        nodes: this.value.nodes.map((node) => node.state === 'retrying' ? {
          ...node, state: 'error', error: localError('重试已取消'),
        } : node),
      });
    }
  }

  async load(input: string, drilldown?: DrilldownContext): Promise<void> {
    const topic = input.trim();
    if (!topic || topic.length > 200) {
      this.update({ error: '请输入 1–200 个字符的学习话题' });
      return;
    }
    if (topic === this.value.topic && ['loading', 'streaming'].includes(this.value.phase)) return;
    this.cancel();
    const subscription = this.subscription = new AbortController();
    const requestId = this.value.requestId + 1;
    this.received = new Set();
    this.terminal = false;
    this.value = { requestId, topic, phase: 'loading', nodes: [], edges: [], drilldown };
    this.listeners.forEach((listener) => listener());
    const current = () => this.value.requestId === requestId && !subscription.signal.aborted;
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
    try {
      const response = await this.fetcher('/api/generate', {
        method: 'POST', signal: subscription.signal,
        headers: { 'Content-Type': 'application/json', Accept: 'text/event-stream' },
        body: JSON.stringify({ topic }),
      });
      if (!current()) { await response.body?.cancel().catch(() => {}); return; }
      if (!response.ok) {
        const data: unknown = await response.json();
        if (!current()) return;
        const error = data && typeof data === 'object' && 'error' in data ? data.error : undefined;
        if (data && typeof data === 'object' && 'mockMode' in data && typeof data.mockMode === 'boolean') {
          this.update({ mockMode: data.mockMode });
        }
        throw new Error(isApiError(error) ? error.message : '生成失败，请重新加载');
      }
      if (response.headers.get('content-type')?.includes('application/json')) {
        const data: unknown = await response.json();
        if (!current()) return;
        if (!isKnowledgeMap(data)) throw new Error('地图响应格式不正确');
        this.terminal = true;
        this.update({
          mapId: data.mapId, mockMode: data.mockMode, progressScope: data.progressScope,
          nodes: data.nodes, edges: data.edges, overview: data.overview,
          phase: 'finished', originalStatus: data.status,
        });
      } else if (!response.headers.get('content-type')?.includes('text/event-stream') || !response.body) {
        throw new Error('服务未返回地图事件流');
      } else {
        const parser = new MapEventDecoder((event) => { if (current()) this.event(event); });
        reader = response.body.getReader();
        while (current()) {
          const chunk = await reader.read();
          if (!current()) break;
          if (chunk.done) { parser.finish(); break; }
          parser.push(chunk.value);
          if (this.terminal) break;
        }
        if (current() && !this.terminal) throw new Error('地图连接中断，请重新加载');
      }
    } catch (error) {
      if (current() && !this.terminal) this.update({ phase: 'failed', error: message(error) });
    } finally {
      await reader?.cancel().catch(() => {});
      reader?.releaseLock();
    }
    if (current() && this.value.phase === 'finished') await this.recover(requestId);
  }

  // The first view of a map should be complete, so retryable node failures sweep themselves before
  // the user is asked to act. Retries run one at a time to avoid re-triggering upstream rate limits.
  private async recover(requestId: number): Promise<void> {
    if (!this.value.nodes.some(isRecoverable)) return;
    this.recovery?.abort();
    const recovery = this.recovery = new AbortController();
    const { mapId } = this.value;
    const live = () => this.value.requestId === requestId && this.value.mapId === mapId &&
      this.recovery === recovery && !recovery.signal.aborted;
    this.update({ recovering: true });
    try {
      for (let round = 0; round < AUTO_RECOVER_ROUNDS; round += 1) {
        const pending = this.value.nodes.filter(isRecoverable).map((node) => node.id);
        if (!pending.length) return;
        await wait(this.recoverDelayMs * (round + 1), recovery.signal);
        for (const nodeId of pending) {
          if (!live()) return;
          await this.retry(nodeId, recovery.signal);
        }
      }
    } finally {
      if (this.recovery === recovery) {
        this.recovery = undefined;
        if (this.value.requestId === requestId) this.update({ recovering: false });
      }
    }
  }

  private event(event: SseEvent): void {
    if (this.terminal) return;
    const { data } = event;
    if (this.value.mapId && data.mapId !== this.value.mapId) return;
    if (this.value.mockMode !== undefined && data.mockMode !== this.value.mockMode) return;
    const identity = JSON.stringify([event.event, 'nodeId' in data ? data.nodeId : '']);
    if (this.received.has(identity)) return;
    this.received.add(identity);
    if (event.event === 'outline') {
      this.update({
        mapId: data.mapId, mockMode: data.mockMode, phase: 'streaming',
        progressScope: event.data.progressScope,
        overview: event.data.overview, edges: event.data.edges,
        nodes: event.data.nodes.map(({ id, title, level, summary, query }) =>
          ({ id, title, level, summary, query, state: 'pending', weight: 0, resources: [] })),
      });
    } else if (event.event === 'generation_error') {
      this.terminal = true;
      this.update({ mapId: data.mapId, mockMode: data.mockMode, phase: 'failed', error: event.data.error.message });
    } else if (event.event === 'complete') {
      if (!this.value.mapId) throw new Error('地图缺少骨架');
      this.terminal = true;
      this.update({ phase: 'finished', originalStatus: event.data.status });
    } else {
      if (!this.value.mapId) throw new Error('地图节点先于骨架到达');
      this.update({ nodes: this.value.nodes.map((node) => {
        if (node.id !== event.data.nodeId || node.state !== 'pending') return node;
        return { ...node, ...event.data, id: node.id };
      }) });
    }
  }

  async retry(nodeId: string, external?: AbortSignal): Promise<void> {
    const node = this.value.nodes.find((entry) => entry.id === nodeId);
    if (!node || !['empty', 'error'].includes(node.state) || this.retries.has(nodeId)) return;
    if (node.error?.retryable === false) return;
    if (external?.aborted) return;
    const { requestId, mapId, mockMode, topic } = this.value;
    const controller = new AbortController();
    const relay = () => controller.abort();
    external?.addEventListener('abort', relay, { once: true });
    this.retries.set(nodeId, controller);
    const current = () => this.value.requestId === requestId && this.value.mapId === mapId &&
      this.retries.get(nodeId) === controller && !controller.signal.aborted;
    this.update({ nodes: this.value.nodes.map((n) => n.id === nodeId ? { ...n, state: 'retrying' } : n) });
    try {
      const response = await this.fetcher('/api/resources', {
        method: 'POST', signal: controller.signal, headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ topic, nodeId, query: node.query }),
      });
      const data: unknown = await response.json();
      if (!current()) return;
      if (!response.ok) {
        const error = data && typeof data === 'object' && 'error' in data ? data.error : undefined;
        if (isApiError(error)) {
          this.update({ nodes: this.value.nodes.map((n) => n.id === nodeId ? { ...n, state: 'error', error } : n) });
          return;
        }
        throw new Error('资源请求失败');
      }
      if (!isResourceResponse(data) || data.nodeId !== nodeId || data.mockMode !== mockMode) {
        throw new Error('资源响应与当前地图不匹配');
      }
      this.update({ nodes: this.value.nodes.map((n) => n.id === nodeId ? {
        ...n, resources: data.resources, weight: data.weight, state: data.state,
        error: undefined, errorCode: undefined,
      } : n) });
    } catch (error) {
      if (current()) this.update({ nodes: this.value.nodes.map((n) => n.id === nodeId ? {
        ...n, state: 'error', error: localError(message(error)),
      } : n) });
    } finally {
      external?.removeEventListener('abort', relay);
      if (this.retries.get(nodeId) === controller) this.retries.delete(nodeId);
    }
  }
}
