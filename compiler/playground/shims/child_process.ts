// The agent target syntax-checks generated JavaScript with `node --check`.
// Browsers have no Node. Acorn parses the same file as a module; a parse
// error fails the compile the way a syntax error would.
import * as acorn from 'acorn';
import { readFileSync } from './fs';

export interface SpawnResult {
  status: number;
  stdout: string;
  stderr: string;
}

export function syntaxCheck(code: string): { ok: true } | { ok: false; error: string } {
  const src = code.startsWith('#!') ? code.slice(code.indexOf('\n') + 1) : code;
  try {
    acorn.parse(src, { ecmaVersion: 'latest', sourceType: 'module', allowHashBang: true });
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

export function spawnSync(_command: string, args?: string[]): SpawnResult {
  const check = Array.isArray(args) && args[0] === '--check' ? args[1] : undefined;
  if (!check) {
    return { status: 0, stdout: '', stderr: '' };
  }
  let code = '';
  try {
    code = String(readFileSync(check, 'utf8'));
  } catch (err) {
    return { status: 1, stdout: '', stderr: err instanceof Error ? err.message : String(err) };
  }
  const result = syntaxCheck(code);
  if (result.ok) return { status: 0, stdout: '', stderr: '' };
  return { status: 1, stdout: '', stderr: result.error };
}

export default { spawnSync };
