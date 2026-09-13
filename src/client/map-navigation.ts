import type { DrilldownContext } from '../../types/domain.ts';
import { MapController } from './map-controller.ts';

export class MapNavigation {
  readonly parent: MapController;
  private child?: MapController;
  private current: MapController;
  private readonly listeners = new Set<() => void>();
  private childSequence = 0;

  constructor(private readonly fetcher: typeof fetch = (...args) => globalThis.fetch(...args)) {
    this.parent = this.current = new MapController(fetcher);
  }

  snapshot = (): MapController => this.current;
  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  };
  private publish(): void { this.listeners.forEach((listener) => listener()); }

  load(topic: string): Promise<void> {
    this.back();
    return this.parent.load(topic);
  }

  enter(nodeId: string): boolean {
    if (this.child) return false;
    const parent = this.parent.snapshot();
    const node = parent.nodes.find((node) => node.id === nodeId);
    if (!node || !['ready', 'empty', 'error'].includes(node.state)) return false;
    if (!node.title.trim() || node.title.trim().length > 200) return false;
    if (node.state === 'error' && parent.originalStatus !== 'partial') return false;
    const context: DrilldownContext = {
      depth: 1, parentTopic: parent.topic, parentNodeId: node.id, topic: node.title,
      breadcrumb: [parent.topic, node.title],
    };
    this.child = new MapController(this.fetcher);
    this.current = this.child;
    this.childSequence += 1;
    void this.child.load(context.topic, context);
    this.publish();
    return true;
  }

  childKey(): number { return this.childSequence; }
  back(): void {
    if (!this.child) return;
    this.child.cancel();
    this.child = undefined;
    this.current = this.parent;
    this.publish();
  }
  cancel(): void { this.parent.cancel(); this.child?.cancel(); }
}
