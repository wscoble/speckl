// Library entry used to prove the browser bundle compiles a spec.
// The page itself loads worker.ts, which imports the same shims.
import '../shims/install';

export { compileSource } from '../../src/browser/compile-source';
