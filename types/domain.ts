import type { ApiError } from './api.ts';

export type NodeLevel = 1 | 2 | 3;

export type NodeState = 'pending' | 'ready' | 'empty' | 'error' | 'retrying';

export type NodeErrorCode =
  | 'timeout' | 'rate_limited' | 'quota_exhausted' | 'unauthorized' | 'provider_error';

export type GenerationStatus = 'complete' | 'partial';

export interface GenerationIdentity {
  mapId: string;
  mockMode: boolean;
}

export interface GenerationSummary {
  status: GenerationStatus;
  completedNodeCount: number;
  failedNodeCount: number;
}

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
  error?: ApiError;
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

export interface KnowledgeMap extends KnowledgeMapOutline, GenerationIdentity, GenerationSummary {
  progressScope: string;
  generatedAt: number;
  expiresAt?: number;
  nodes: MapNode[];
}
