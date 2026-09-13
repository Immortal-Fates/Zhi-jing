import { normalizeTopic } from '../lib/topic.ts';

export const PROGRESS_KEY = 'zhijing:progress:v1';

export interface LearningProgress {
  completedNodeIds: string[];
  updatedAt: number;
}

type ProgressStorage = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;

export function progressId(topic: string, nodeId: string, scope?: string): string {
  const normalized = normalizeTopic(topic);
  if (!normalized.ok) throw new Error('无效学习话题');
  return JSON.stringify([scope ?? `map_${normalized.cacheKey}`, nodeId]);
}

export function parseProgress(raw: string | null): LearningProgress {
  try {
    const data: unknown = raw === null ? null : JSON.parse(raw);
    if (!data || typeof data !== 'object' || !('completedNodeIds' in data) || !('updatedAt' in data) ||
      !Array.isArray(data.completedNodeIds) ||
      !data.completedNodeIds.every((id) => typeof id === 'string' && id.length > 0) ||
      typeof data.updatedAt !== 'number' || !Number.isSafeInteger(data.updatedAt) || data.updatedAt < 0) {
      return { completedNodeIds: [], updatedAt: 0 };
    }
    return { completedNodeIds: [...new Set(data.completedNodeIds)], updatedAt: data.updatedAt };
  } catch { return { completedNodeIds: [], updatedAt: 0 }; }
}

export class ProgressStore {
  private value: LearningProgress = { completedNodeIds: [], updatedAt: 0 };
  private readonly listeners = new Set<() => void>();
  private ignoreStored = false;

  constructor(
    private readonly storage: () => ProgressStorage = () => window.localStorage,
    private readonly now: () => number = Date.now,
  ) {}

  snapshot = (): LearningProgress => this.value;
  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  };
  private publish(value: LearningProgress): void {
    this.value = value;
    this.listeners.forEach((listener) => listener());
  }
  restore(): void {
    if (this.ignoreStored) return;
    try {
      const raw = this.storage().getItem(PROGRESS_KEY);
      const parsed = parseProgress(raw);
      if (raw !== null && parsed.updatedAt === 0 && parsed.completedNodeIds.length === 0 &&
        this.value.completedNodeIds.length) return;
      this.publish(parsed);
    } catch {}
  }
  mark(id: string): void {
    let previous = this.value.completedNodeIds;
    try {
      if (!this.ignoreStored) {
        previous = [...previous, ...parseProgress(this.storage().getItem(PROGRESS_KEY)).completedNodeIds];
      }
    } catch {}
    const next = { completedNodeIds: [...new Set([...previous, id])], updatedAt: this.now() };
    try {
      this.storage().setItem(PROGRESS_KEY, JSON.stringify(next));
      this.ignoreStored = false;
    } catch {}
    this.publish(next);
  }
  clear(): boolean {
    let persisted = true;
    try { this.storage().removeItem(PROGRESS_KEY); } catch { persisted = false; }
    this.ignoreStored = !persisted;
    this.publish({ completedNodeIds: [], updatedAt: 0 });
    return persisted;
  }
}
