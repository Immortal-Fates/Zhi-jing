import type { ApiError, ApiErrorCode } from '../../types/api.ts';
import { ZhihuAdapterError } from './zhihu-adapter.ts';

const errors: Record<ApiErrorCode, { status: number; message: string; retryable: boolean }> = {
  INVALID_TOPIC: { status: 400, message: '请输入有效的学习话题及请求参数', retryable: false },
  NOT_LEARNABLE: { status: 422, message: '请更换为可学习的领域或技能', retryable: false },
  OUTLINE_INVALID: { status: 502, message: '学习大纲解析或校验失败', retryable: true },
  UPSTREAM_AUTH: { status: 502, message: '知乎服务鉴权失败', retryable: false },
  UPSTREAM_RATE_LIMITED: { status: 429, message: '知乎服务请求频率受限', retryable: true },
  UPSTREAM_TIMEOUT: { status: 504, message: '地图生成或资源请求超时', retryable: true },
  UPSTREAM_ERROR: { status: 502, message: '生成服务暂时不可用', retryable: true },
  QUOTA_EXHAUSTED: { status: 429, message: '知乎服务额度已耗尽', retryable: false },
  MAP_NOT_FOUND: { status: 404, message: '地图缓存不存在或已过期', retryable: false },
};

export function errorFor(code: ApiErrorCode): ApiError {
  const { message, retryable } = errors[code];
  return { code, message, retryable };
}

export function safeError(error: unknown): ApiError {
  const code = error instanceof ZhihuAdapterError ? error.apiError.code : undefined;
  return errorFor(code && Object.hasOwn(errors, code) ? code : 'UPSTREAM_ERROR');
}

export function httpStatus(error: ApiError): number {
  return errors[error.code].status;
}

export function fail(code: ApiErrorCode): never {
  throw new ZhihuAdapterError(errorFor(code));
}
