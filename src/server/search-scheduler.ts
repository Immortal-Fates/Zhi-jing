import { fail } from './api-errors.ts';

// Zhihu search rejects bursts above two concurrent calls with UPSTREAM_RATE_LIMITED.
export const DEFAULT_SEARCH_CONCURRENCY = 2;

function configuredConcurrency(): number {
  const value = Number(process.env.ZHIJING_SEARCH_CONCURRENCY);
  return Number.isSafeInteger(value) && value > 0 && value <= 8 ? value : DEFAULT_SEARCH_CONCURRENCY;
}

export class SearchScheduler {
  private active = 0;
  private readonly queue: Array<() => void> = [];
  private readonly limit: number;

  constructor(limit: number = configuredConcurrency()) {
    if (!Number.isSafeInteger(limit) || limit < 1) fail('UPSTREAM_ERROR');
    this.limit = limit;
  }

  async run<T>(work: () => Promise<T>, signal: AbortSignal): Promise<T> {
    await new Promise<void>((resolve, reject) => {
      const abort = () => {
        const index = this.queue.indexOf(start);
        if (index !== -1) this.queue.splice(index, 1);
        signal.removeEventListener('abort', abort);
        try { fail('UPSTREAM_TIMEOUT'); } catch (error) { reject(error); }
      };
      const start = () => {
        signal.removeEventListener('abort', abort);
        this.active += 1;
        resolve();
      };
      if (signal.aborted) {
        abort();
      } else if (this.active < this.limit) {
        start();
      } else {
        this.queue.push(start);
        signal.addEventListener('abort', abort, { once: true });
      }
    });
    try {
      if (signal.aborted) fail('UPSTREAM_TIMEOUT');
      return await work();
    } finally {
      this.active -= 1;
      this.queue.shift()?.();
    }
  }
}
