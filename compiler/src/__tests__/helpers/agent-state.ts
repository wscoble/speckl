// Test helpers for the tamper-evident agent state: a shared state key and a
// way for tests (playing the trusted operator) to re-sign fixture edits.
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import crypto from 'node:crypto';

export function canonical(v: unknown): string {
  if (Array.isArray(v)) return '[' + v.map(canonical).join(',') + ']';
  if (v !== null && typeof v === 'object') {
    const o = v as Record<string, unknown>;
    return '{' + Object.keys(o).filter(k => o[k] !== undefined).sort()
      .map(k => JSON.stringify(k) + ':' + canonical(o[k])).join(',') + '}';
  }
  return JSON.stringify(v === undefined ? null : v);
}

/** Create a key file and point SPECKL_STATE_KEY_FILE at it for this worker (inherited by spawned hooks). */
export function useStateKey(): string {
  const file = join(mkdtempSync(join(tmpdir(), 'speckl-key-')), 'state.key');
  writeFileSync(file, crypto.randomBytes(32).toString('hex') + '\n', { mode: 0o600 });
  process.env.SPECKL_STATE_KEY_FILE = file;
  return file;
}

export function macOf(state: Record<string, unknown>, keyFile: string): string {
  const { mac: _m, ...rest } = state;
  const key = Buffer.from(readFileSync(keyFile, 'utf-8').trim(), 'hex');
  return crypto.createHmac('sha256', key).update(canonical(rest)).digest('hex');
}

/** Write `state` re-signed with the worker's key (an operator edit, not an agent one). */
export function writeSigned(file: string, state: Record<string, unknown>, keyFile = process.env.SPECKL_STATE_KEY_FILE!): void {
  writeFileSync(file, JSON.stringify({ ...state, mac: macOf(state, keyFile) }));
}
