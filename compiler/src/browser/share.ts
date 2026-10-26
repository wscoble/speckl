// Share links live in the URL hash: `#s1.` plus unpadded base64url of the
// UTF-8 spec. No extra dependency, and the alphabet survives a copied URL.

import { MAX_SOURCE_BYTES, formatBytes } from './limits.js';

const TABLE = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
const REV = new Array<number>(128).fill(-1);
for (let i = 0; i < TABLE.length; i++) REV[TABLE.charCodeAt(i)] = i;
REV['+'.charCodeAt(0)] = 62;
REV['/'.charCodeAt(0)] = 63;

const HASH_CHAR_LIMIT = 4_000_000;

export function encodeBase64Url(bytes: Uint8Array): string {
  let out = '';
  const len = bytes.length;
  let i = 0;
  while (i + 3 <= len) {
    const n = (bytes[i] << 16) | (bytes[i + 1] << 8) | bytes[i + 2];
    out += TABLE[(n >>> 18) & 63]
      + TABLE[(n >>> 12) & 63]
      + TABLE[(n >>> 6) & 63]
      + TABLE[n & 63];
    i += 3;
  }
  const rem = len - i;
  if (rem === 1) {
    const n = bytes[i] << 16;
    out += TABLE[(n >>> 18) & 63] + TABLE[(n >>> 12) & 63];
  } else if (rem === 2) {
    const n = (bytes[i] << 16) | (bytes[i + 1] << 8);
    out += TABLE[(n >>> 18) & 63] + TABLE[(n >>> 12) & 63] + TABLE[(n >>> 6) & 63];
  }
  return out;
}

/** Null when the text is not base64/base64url. */
export function decodeBase64Url(text: string): Uint8Array | null {
  const s = text.replace(/=+$/, '');
  if (s.length === 0) return new Uint8Array();
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c >= 128 || REV[c] < 0) return null;
  }
  const rem = s.length % 4;
  if (rem === 1) return null;
  const out = new Uint8Array(Math.floor((s.length * 3) / 4));
  let o = 0;
  let i = 0;
  while (i + 4 <= s.length) {
    const n = (REV[s.charCodeAt(i)] << 18)
      | (REV[s.charCodeAt(i + 1)] << 12)
      | (REV[s.charCodeAt(i + 2)] << 6)
      | REV[s.charCodeAt(i + 3)];
    out[o++] = (n >>> 16) & 255;
    out[o++] = (n >>> 8) & 255;
    out[o++] = n & 255;
    i += 4;
  }
  if (rem === 2) {
    const n = (REV[s.charCodeAt(i)] << 18) | (REV[s.charCodeAt(i + 1)] << 12);
    out[o++] = (n >>> 16) & 255;
  } else if (rem === 3) {
    const n = (REV[s.charCodeAt(i)] << 18)
      | (REV[s.charCodeAt(i + 1)] << 12)
      | (REV[s.charCodeAt(i + 2)] << 6);
    out[o++] = (n >>> 16) & 255;
    out[o++] = (n >>> 8) & 255;
  }
  return out;
}

export type DecodeResult =
  | { ok: true; source: string }
  | { ok: false; message: string };

export function encodeSpecHash(source: string): string {
  return 's1.' + encodeBase64Url(new TextEncoder().encode(source));
}

export function decodeSpecHash(hash: string): DecodeResult {
  let raw = hash.trim();
  if (raw.startsWith('#')) raw = raw.slice(1);
  if (!raw) return { ok: false, message: 'This share link is empty.' };
  if (raw.length > HASH_CHAR_LIMIT) {
    return {
      ok: false,
      message: 'This share link is too long to read. Open a shorter link, or load an example.',
    };
  }
  if (!raw.startsWith('s1.')) {
    return {
      ok: false,
      message: 'This share link is not a Speckl playground link. It was ignored, and an example was loaded instead.',
    };
  }
  const bytes = decodeBase64Url(raw.slice(3));
  if (!bytes) {
    return {
      ok: false,
      message: 'This share link is damaged or was edited, so the spec could not be read. An example was loaded instead.',
    };
  }
  if (bytes.length > MAX_SOURCE_BYTES) {
    return {
      ok: false,
      message: `This share link decodes to ${formatBytes(bytes.length)}, over the ${formatBytes(MAX_SOURCE_BYTES)} limit. An example was loaded instead.`,
    };
  }
  try {
    const source = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    return { ok: true, source };
  } catch {
    return {
      ok: false,
      message: 'This share link does not contain readable text. An example was loaded instead.',
    };
  }
}
