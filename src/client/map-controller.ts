import type { ApiError, SseEvent } from '../../types/api.ts';
import type { GenerationStatus, MapEdge, MapNode, MapOverview } from '../../types/domain.ts';
import { isApiError, isResourceResponse, MapEventDecoder } from './map-events.ts';

export interface MapView {
  requestId: number;
  topic: string;
  mapId?: string;
  mockMode?: boolean;
  overview?: MapOverview;
  nodes: MapNode[];
  edges: MapEdge[];
  phase: 'idle' | 'loading' | 'streaming' | 'finished' | 'failed';
  originalStatus?: GenerationStatus;
  error?: string;
}

export function nodeRadius(weight: number): number {
  return 40 + 50 * Math.min(1, Math.max(0, Number.isFinite(weight) ? weight / 3 : 0));
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

export class MapController {
  private value: MapView = { requestId: 0, topic: '', phase: 'idle', nodes: [], edges: [] };
  private readonly listeners = new Set<() => void>();
  private subscription?: AbortController;
  private readonly retries = new Map<string, AbortController>();
  private received = new Set<string>();
  private terminal = false;

  constructor(private readonly fetcher: typeof fetch = (...args) => globalThis.fetch(...args)) {}
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
    this.retries.forEach((controller) => controller.abort());
    this.retries.clear();
    this.subscription = undefined;
    if (['loading', 'streaming'].includes(this.value.phase) || this.value.nodes.some((n) => n.state === 'retrying')) {
      this.update({
        phase: ['loading', 'streaming'].includes(this.value.phase) ? 'failed' : this.value.phase,
        error: ['loading', 'streaming'].includes(this.value.phase) ? '订阅已取消，可重新加载' : this.value.error,
        nodes: this.value.nodes.map((node) => node.state === 'retrying' ? {
          ...node, state: 'error', error: localError('重试已取消'),
        } : node),
      });
    }
  }

  async load(input: string): Promise<void> {
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
    this.value = { requestId, topic, phase: 'loading', nodes: [], edges: [] };
    this.listeners.forEach((listener) => listener());
    const current = () => this.value.requestId === requestId && !subscription.signal.aborted;
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
    try {
      const response = await this.fetcher('/api/generate', {
        method: 'POST', signal: subscription.signal,
        headers: { 'Content-Type': 'application/json', Accept: 'text/event-stream' },
        body: JSON.stringify({ topic }),
      });
      if (!current()) return;
      if (!response.ok) {
        const data: unknown = await response.json();
        if (!current()) return;
        const error = data && typeof data === 'object' && 'error' in data ? data.error : undefined;
        if (data && typeof data === 'object' && 'mockMode' in data && typeof data.mockMode === 'boolean') {
          this.update({ mockMode: data.mockMode });
        }
        throw new Error(isApiError(error) ? error.message : '生成失败，请重新加载');
      }
      if (!response.headers.get('content-type')?.includes('text/event-stream') || !response.body) {
        throw new Error('服务未返回地图事件流');
      }
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
    } catch (error) {
      if (current() && !this.terminal) this.update({ phase: 'failed', error: message(error) });
    } finally {
      await reader?.cancel().catch(() => {});
      reader?.releaseLock();
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

  async retry(nodeId: string): Promise<void> {
    const node = this.value.nodes.find((entry) => entry.id === nodeId);
    if (!node || !['empty', 'error'].includes(node.state) || this.retries.has(nodeId)) return;
    if (node.error?.retryable === false) return;
    const { requestId, mapId, mockMode, topic } = this.value;
    const controller = new AbortController();
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
      if (this.retries.get(nodeId) === controller) this.retries.delete(nodeId);
    }
  }
}
