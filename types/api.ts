import type {
  KnowledgeMap,
  KnowledgeMapOutline,
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

export type ApiResponse<T extends object> = T | ApiErrorResponse;

export interface OutlineRequest {
  topic: string;
}

export interface ResourcesRequest extends OutlineRequest {
  nodeId: string;
  query: string;
}

export type MapRequest = OutlineRequest;

export type OutlineResponse = ApiResponse<KnowledgeMapOutline>;

export type MapResponse = ApiResponse<KnowledgeMap>;

export interface ResourceResponse {
  ok: true;
  nodeId: string;
  state: Extract<NodeState, 'ready' | 'empty' | 'error'>;
  resources: Resource[];
  errorCode?: NodeErrorCode;
}

export type SseEventName =
  | 'outline'
  | 'resource_ready'
  | 'resource_empty'
  | 'resource_error'
  | 'complete';

export interface OutlineSseEvent {
  event: 'outline';
  data: KnowledgeMapOutline & { mapId: string };
}

export interface ResourceReadySseEvent {
  event: 'resource_ready';
  data: {
    mapId: string;
    nodeId: string;
    state: 'ready';
    resources: Resource[];
  };
}

export interface ResourceEmptySseEvent {
  event: 'resource_empty';
  data: {
    mapId: string;
    nodeId: string;
    state: 'empty';
    resources: [];
  };
}

export interface ResourceErrorSseEvent {
  event: 'resource_error';
  data: {
    mapId: string;
    nodeId: string;
    state: 'error';
    resources: [];
    errorCode: NodeErrorCode;
  };
}

export interface CompleteSseEvent {
  event: 'complete';
  data: {
    mapId: string;
    completedNodeCount: number;
  };
}

export type SseEvent =
  | OutlineSseEvent
  | ResourceReadySseEvent
  | ResourceEmptySseEvent
  | ResourceErrorSseEvent
  | CompleteSseEvent;
