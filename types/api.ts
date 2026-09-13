import type {
  KnowledgeMap,
  KnowledgeMapOutline,
  GenerationIdentity,
  GenerationSummary,
  MapNode,
  NodeErrorCode,
  NodeState,
  Resource,
} from './domain.ts';

export type ApiErrorCode =
  | 'INVALID_TOPIC'
  | 'NOT_LEARNABLE'
  | 'OUTLINE_INVALID'
  | 'UPSTREAM_AUTH'
  | 'UPSTREAM_RATE_LIMITED'
  | 'UPSTREAM_TIMEOUT'
  | 'UPSTREAM_ERROR'
  | 'QUOTA_EXHAUSTED'
  | 'MAP_NOT_FOUND';

export interface ApiError {
  code: ApiErrorCode;
  message: string;
  retryable: boolean;
}

export interface ApiErrorResponse {
  ok: false;
  error: ApiError;
}

export type ApiResponse<T extends object> = (T | ApiErrorResponse) & { mockMode: boolean };

export interface OutlineRequest {
  topic: string;
}

export interface ResourcesRequest extends OutlineRequest {
  nodeId: string;
  query: string;
}

export type MapRequest = OutlineRequest;
export type GenerateRequest = OutlineRequest;

export type OutlineResponse = ApiResponse<KnowledgeMapOutline>;

export type MapResponse = ApiResponse<KnowledgeMap>;

export interface ResourceResponse {
  ok: true;
  mockMode: boolean;
  nodeId: string;
  state: Extract<NodeState, 'ready' | 'empty'>;
  resources: Resource[];
  weight: number;
}

export type SseEventName = SseEvent['event'];

export interface OutlineSseEvent {
  event: 'outline';
  data: Omit<KnowledgeMapOutline, 'nodes'> & GenerationIdentity & {
    progressScope: string;
    nodes: MapNode[];
  };
}

export interface ResourceReadySseEvent {
  event: 'resource_ready';
  data: GenerationIdentity & {
    nodeId: string;
    state: 'ready';
    resources: Resource[];
    weight: number;
  };
}

export interface ResourceEmptySseEvent {
  event: 'resource_empty';
  data: GenerationIdentity & {
    nodeId: string;
    state: 'empty';
    resources: [];
    weight: 0;
  };
}

export interface ResourceErrorSseEvent {
  event: 'resource_error';
  data: GenerationIdentity & {
    nodeId: string;
    state: 'error';
    resources: [];
    errorCode: NodeErrorCode;
    error: ApiError;
    weight: 0;
  };
}

export interface CompleteSseEvent {
  event: 'complete';
  data: GenerationIdentity & GenerationSummary & {
    generatedAt: number;
    expiresAt?: number;
  };
}

export interface GenerationErrorSseEvent {
  event: 'generation_error';
  data: GenerationIdentity & { error: ApiError };
}

export type SseEvent =
  | OutlineSseEvent
  | ResourceReadySseEvent
  | ResourceEmptySseEvent
  | ResourceErrorSseEvent
  | CompleteSseEvent
  | GenerationErrorSseEvent;
