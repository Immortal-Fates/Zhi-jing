import { fail } from './api-errors.ts';

export class SearchScheduler {
  private active = 0;
  private readonly queue: Array<() => void> = [];

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
      } else if (this.active < 5) {
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
