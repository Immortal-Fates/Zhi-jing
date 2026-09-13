import type { ApiError } from '../../types/api.ts';

export type TopicNormalizationResult =
  | {
      ok: true;
      topic: string;
      cacheKey: string;
    }
  | {
      ok: false;
      error: ApiError;
    };

export function normalizeTopic(input: unknown): TopicNormalizationResult {
  const error: ApiError = {
    code: 'INVALID_TOPIC',
    message: '请输入学习话题',
    retryable: false,
  };

  if (typeof input !== 'string') {
    return { ok: false, error };
  }

  const topic = input
    .toLowerCase()
    .replace(/\s+/gu, ' ')
    .replace(/^[\p{P}\s]+|[\p{P}\s]+$/gu, '')
    .replace(/\s+/gu, ' ');

  if (!topic) {
    return { ok: false, error };
  }

  return {
    ok: true,
    topic,
    cacheKey: topic,
  };
}
