import '../shims/install';
import { compileSource } from '../../src/browser/compile-source';
import { workerCrashMessage } from '../../src/browser/diagnostics';

interface Job {
  id: number;
  source: string;
  target?: string;
  /** Test hook. Ignored unless the spec also contains the spin marker. */
  spin?: boolean;
}

interface Reply {
  id: number;
  result: ReturnType<typeof compileSource>;
}

// `?spin=1` on the page asks the worker to busy-wait when the spec contains
// this marker, so tests can prove the UI stays up and the worker can be killed.
const SPIN = '/*__SPECKL_SPIN__*/';

addEventListener('message', (ev: MessageEvent<Job>) => {
  const data = ev.data;
  if (!data || typeof data.id !== 'number') return;
  try {
    if (data.spin && typeof data.source === 'string' && data.source.includes(SPIN)) {
      const until = Date.now() + 10_000;
      while (Date.now() < until) {
        // Intentional. The main thread terminates this worker on timeout.
      }
    }
    const result = compileSource(typeof data.source === 'string' ? data.source : '', { target: data.target });
    const reply: Reply = { id: data.id, result };
    postMessage(reply);
  } catch {
    const reply: Reply = {
      id: data.id,
      result: {
        ok: false,
        diagnostics: [{ level: 'error', message: workerCrashMessage() }],
        files: [],
        elapsedMs: 0,
      },
    };
    postMessage(reply);
  }
});
