import type { SseEvent } from '../../types/api.ts';
import { fail, httpStatus, safeError } from './api-errors.ts';
import { MapGenerationService, type GenerationContext, type GenerationTask } from './map-generation.ts';
import type { MockScenario } from './zhihu-adapter.ts';

const scenarios: MockScenario[] = [
  'default', 'empty', 'invalid_json', 'timeout', 'rate_limited', 'quota_exhausted', 'unauthorized',
];

export function generationContext(): GenerationContext {
  const mockMode = process.env.ZHIJING_MOCK_MODE !== 'false';
  const scenario = process.env.ZHIJING_MOCK_SCENARIO ?? 'default';
  if (mockMode && !scenarios.includes(scenario as MockScenario)) fail('INVALID_TOPIC');
  return { mockMode, mockScenario: mockMode ? scenario as MockScenario : 'default' };
}

function json(value: unknown, status = 200): Response {
  return Response.json(value, {
    status, headers: { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' },
  });
}

async function body(request: Request): Promise<Record<string, unknown>> {
  if (request.headers.get('content-type')?.split(';')[0].trim().toLowerCase() !== 'application/json') {
    fail('INVALID_TOPIC');
  }
  const reader = request.body?.getReader();
  if (!reader) fail('INVALID_TOPIC');
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > 8192) {
        await reader.cancel();
        fail('INVALID_TOPIC');
      }
      chunks.push(value);
    }
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
    const parsed: unknown = JSON.parse(new TextDecoder().decode(bytes));
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) fail('INVALID_TOPIC');
    return parsed as Record<string, unknown>;
  } catch { fail('INVALID_TOPIC'); }
  finally { reader.releaseLock(); }
}

export function generationStream(task: GenerationTask, signal: AbortSignal): Response {
  const encoder = new TextEncoder();
  let stop = () => {};
  let closed = false;
  let cleanup = () => {};
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const close = () => {
        if (closed) return;
        closed = true;
        cleanup();
        controller.close();
      };
      cleanup = () => {
        stop();
        signal.removeEventListener('abort', close);
      };
      if (signal.aborted) { close(); return; }
      signal.addEventListener('abort', close, { once: true });
      controller.enqueue(encoder.encode(': connected\n\n'));
      stop = task.subscribe((event: SseEvent) => {
        if (closed) return;
        try {
          const suffix = 'nodeId' in event.data ? event.data.nodeId : 'global';
          const id = [task.mapId, event.event, suffix].map((part) =>
            encodeURIComponent(JSON.stringify(part))).join(':');
          controller.enqueue(encoder.encode(
            `id: ${id}\nevent: ${event.event}\ndata: ${JSON.stringify(event.data)}\n\n`,
          ));
          if (event.event === 'complete' || event.event === 'generation_error') close();
        } catch {
          try {
            controller.enqueue(encoder.encode(
              `event: generation_error\ndata: ${JSON.stringify({
                mapId: task.mapId, mockMode: task.mockMode, error: safeError(undefined),
              })}\n\n`,
            ));
          } finally {
            close();
          }
        }
      });
      // Replay can deliver a terminal event before subscribe returns its cleanup.
      if (closed) cleanup();
    },
    cancel() { closed = true; cleanup(); },
  });
  return new Response(stream, { headers: {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    'Connection': 'keep-alive',
    'X-Accel-Buffering': 'no',
    'X-Content-Type-Options': 'nosniff',
  } });
}

function acceptsStream(header: string): boolean {
  const quality = new Map<string, number>();
  for (const part of header.split(',')) {
    const [media, ...parameters] = part.toLowerCase().split(';').map((value) => value.trim());
    const weight = parameters.find((value) => value.startsWith('q='));
    const q = weight === undefined ? 1 : Number(weight.slice(2));
    quality.set(media, Number.isFinite(q) && q >= 0 && q <= 1 ? q : 0);
  }
  const stream = quality.get('text/event-stream') ?? 0;
  const json = quality.get('application/json') ?? quality.get('application/*') ?? quality.get('*/*') ?? 0;
  return stream > 0 && stream >= json;
}

export function createMapHandlers(
  service: MapGenerationService,
  contextProvider: () => GenerationContext = generationContext,
) {
  const handle = (operation: (
    request: Request, context: GenerationContext,
  ) => Promise<Response>) => async (request: Request): Promise<Response> => {
    let mockMode = process.env.ZHIJING_MOCK_MODE !== 'false';
    try {
      const context = contextProvider();
      mockMode = context.mockMode;
      return await operation(request, context);
    } catch (error) {
      const safe = safeError(error);
      return json({ ok: false, mockMode, error: safe }, httpStatus(safe));
    }
  };

  return {
    outline: handle(async (request, context) => {
      const input = await body(request);
      return json({ ...await service.outline(input.topic, context), mockMode: context.mockMode });
    }),
    resources: handle(async (request, context) => {
      const input = await body(request);
      return json(await service.resources(input.topic, input.nodeId, input.query, context));
    }),
    map: handle(async (request, context) => {
      const map = service.getCached(new URL(request.url).searchParams.get('topic'), context);
      if (!map) fail('MAP_NOT_FOUND');
      return json(map);
    }),
    generate: handle(async (request, context) => {
      const input = await body(request);
      const task = service.generate(input.topic, context);
      const accept = request.headers.get('accept') ?? '';
      if (acceptsStream(accept)) return generationStream(task, request.signal);
      const result = await task.result;
      return result.ok ? json(result.map) : json({
        ok: false, mockMode: context.mockMode, error: result.error, mapId: task.mapId,
      }, httpStatus(result.error));
    }),
  };
}
