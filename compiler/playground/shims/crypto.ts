// Sync SHA-256. The agent target hashes the spec while compiling; Web Crypto
// is async, and the compiler calls createHash().digest() synchronously.
import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex, utf8ToBytes } from '@noble/hashes/utils.js';

export function createHash(algorithm: string): {
  update(data: string | Uint8Array): ReturnType<typeof createHash>;
  digest(encoding?: string): string | Uint8Array;
} {
  if (algorithm !== 'sha256') {
    throw new Error(`The playground can hash with sha256 only (asked for ${algorithm}).`);
  }
  const parts: Uint8Array[] = [];
  const hash = {
    update(data: string | Uint8Array) {
      parts.push(typeof data === 'string' ? utf8ToBytes(data) : data);
      return hash;
    },
    digest(encoding?: string) {
      const total = concat(parts);
      const digest = sha256(total);
      if (encoding === 'hex') return bytesToHex(digest);
      return digest;
    },
  };
  return hash;
}

function concat(parts: Uint8Array[]): Uint8Array {
  const len = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(len);
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

export default { createHash };
