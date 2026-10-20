// scripts/lib/baseline.mjs
//
// Acknowledged unchecked obligations. A spec directory may carry
// `.speckl-unchecked.json`:
//
//   { "KafkaKRaft.speckdl": { "TermMonotonicity": "post-state invariant" } }
//
// Listed obligations still fail to count as passed; they are reported as
// UNCHECKED (acknowledged) instead of failing the run, so a repo can ratchet
// toward full proofs. Without the file, every unchecked obligation fails.

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

export const BASELINE_FILE = '.speckl-unchecked.json';

/** Returns { path, entries: Map<specFile, Map<key, reason>> }. Throws on a malformed file. */
export function loadBaseline(dir) {
  const path = join(dir, BASELINE_FILE);
  const entries = new Map();
  if (!existsSync(path)) return { path: null, entries };
  const data = JSON.parse(readFileSync(path, 'utf-8'));
  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    throw new Error(`${path}: expected an object of { "<spec>.speckdl": { "<verify>": "<reason>" } }`);
  }
  for (const [file, keys] of Object.entries(data)) {
    if (file.startsWith('$')) continue; // "$comment" and similar
    if (!keys || typeof keys !== 'object' || Array.isArray(keys)) {
      throw new Error(`${path}: "${file}" must map verify names to reasons`);
    }
    entries.set(file, new Map(Object.entries(keys).map(([k, v]) => [k, String(v)])));
  }
  return { path, entries };
}
