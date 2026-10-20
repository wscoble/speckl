import fs from 'fs';
import path from 'path';
import { spawnSync } from 'child_process';
import { fileURLToPath } from 'url';

/**
 * `speckl verify [paths...]`: run the bundled Z3 verifier (scripts/verify-z3.mjs,
 * shipped in the package) with this compiler. Returns the verifier's exit code
 * (0 all obligations hold, 1 a failure, 2 no z3 binary).
 */
export function runVerify(args: string[], here = path.dirname(fileURLToPath(import.meta.url))): number {
  const script = path.join(here, '..', 'scripts', 'verify-z3.mjs');
  if (!fs.existsSync(script)) {
    console.error(`speckl verify: verifier not found at ${script}`);
    return 1;
  }
  const env = { ...process.env };
  const self = path.join(here, 'index.js');
  if (!env.SPECKL_BIN && fs.existsSync(self)) env.SPECKL_BIN = self;
  const r = spawnSync(process.execPath, [script, ...args], { stdio: 'inherit', env });
  if (r.error) {
    console.error(`speckl verify: ${r.error.message}`);
    return 1;
  }
  return r.status ?? 1;
}

/** Version from the package.json next to dist/ (or src/), so --version works when installed. */
export function packageVersion(): string {
  try {
    const here = path.dirname(fileURLToPath(import.meta.url));
    return JSON.parse(fs.readFileSync(path.join(here, '..', 'package.json'), 'utf-8')).version;
  } catch {
    return 'unknown';
  }
}

