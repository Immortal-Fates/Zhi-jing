import { MapGenerationService } from './map-generation.ts';
import { createMapHandlers } from './map-http.ts';

const processState = globalThis as typeof globalThis & { zhijingMapService?: MapGenerationService };

function positiveMs(name: string, fallback: number, multiplier = 1): number {
  const value = Number(process.env[name]) * multiplier;
  return Number.isSafeInteger(value) && value > 0 && value <= 2_147_483_647 ? value : fallback;
}

function handlers() {
  const service = processState.zhijingMapService ??= new MapGenerationService({
    timeoutMs: positiveMs('ZHIJING_GENERATION_TIMEOUT_MS', 180_000),
    ttlMs: positiveMs('ZHIJING_MAP_TTL_SECONDS', 86_400_000, 1000),
  });
  return createMapHandlers(service);
}

export const outline = (request: Request) => handlers().outline(request);
export const resources = (request: Request) => handlers().resources(request);
export const map = (request: Request) => handlers().map(request);
export const generate = (request: Request) => handlers().generate(request);
