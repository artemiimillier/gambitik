import { DEFAULT_ENGINE_URL } from './types.ts';
import type { EngineTransport } from './types.ts';

/**
 * Browser transport: a CLASSIC Worker (never `{ type: 'module' }`, never bundled) running the
 * Stockfish build copied to `public/engine/`. The worker finds its `.wasm` next to the `.js` file and
 * queues commands that arrive before the WASM module is ready, so posting `uci` immediately is safe.
 */
export function createWorkerTransport(url: string = DEFAULT_ENGINE_URL): EngineTransport {
  const worker = new Worker(url);
  let lineCb: ((line: string) => void) | null = null;
  let errorCb: ((error: Error) => void) | null = null;
  let terminated = false;

  worker.onmessage = (event: MessageEvent<unknown>) => {
    if (terminated || typeof event.data !== 'string') return;
    for (const line of event.data.split('\n')) {
      const trimmed = line.trim();
      if (trimmed.length > 0) lineCb?.(trimmed);
    }
  };
  worker.onerror = (event: ErrorEvent) => {
    if (terminated) return;
    event.preventDefault?.();
    errorCb?.(new Error(event.message || `engine worker failed to load: ${url}`));
  };
  worker.onmessageerror = () => {
    if (terminated) return;
    errorCb?.(new Error('engine worker sent an undecodable message'));
  };

  return {
    post(cmd: string): void {
      if (!terminated) worker.postMessage(cmd);
    },
    onLine(cb: (line: string) => void): void {
      lineCb = cb;
    },
    onError(cb: (error: Error) => void): void {
      errorCb = cb;
    },
    terminate(): void {
      if (terminated) return;
      terminated = true;
      lineCb = null;
      errorCb = null;
      try {
        worker.postMessage('quit');
      } catch {
        // The worker may already be gone; terminate() below is what matters.
      }
      worker.terminate();
    },
  };
}
