export type NodeLevel = 1 | 2 | 3;

export type NodeState = 'pending' | 'ready' | 'empty' | 'error' | 'retrying';

export type NodeErrorCode = 'timeout' | 'rate_limited' | 'unauthorized' | 'provider_error';

export type MapEdgeType = 'main' | 'branch';

export interface MapOverview {
  what: string;
  gain: string;
  duration: string;
}

export interface MapNodeOutline {
  id: string;
  title: string;
  level: NodeLevel;
  summary: string;
  query: string;
}

export interface Resource {
  title: string;
  url: string;
  contentId: string;
  contentType: string;
  author: string;
  authorBadge?: string;
  authorBadgeText?: string;
  authorityLevel?: string;
  rankingScore?: number;
  voteUpCount: number;
  commentCount: number;
  excerpt: string;
  editTime: number;
  score: number;
}

export interface MapNode extends MapNodeOutline {
  resources: Resource[];
  weight: number;
  state: NodeState;
  errorCode?: NodeErrorCode;
}

export interface MapEdge {
  from: string;
  to: string;
  type: MapEdgeType;
}

export interface KnowledgeMapOutline {
  topic: string;
  overview: MapOverview;
  nodes: MapNodeOutline[];
  edges: MapEdge[];
}

export interface KnowledgeMap extends KnowledgeMapOutline {
  generatedAt: number;
  expiresAt?: number;
  nodes: MapNode[];
}
