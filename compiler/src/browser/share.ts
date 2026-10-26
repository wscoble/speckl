// Share links live in the URL hash.
// `#s1.` is unpadded base64url of the UTF-8 spec (older links, no checksum).
// `#s2.` is unpadded base64url of a big-endian CRC-32 followed by the UTF-8
// spec, so a link that was cut off or edited does not load a partial spec.

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
  const body = new TextEncoder().encode(source);
  const packed = new Uint8Array(4 + body.length);
  const crc = crc32(body);
  packed[0] = (crc >>> 24) & 255;
  packed[1] = (crc >>> 16) & 255;
  packed[2] = (crc >>> 8) & 255;
  packed[3] = crc & 255;
  packed.set(body, 4);
  return 's2.' + encodeBase64Url(packed);
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
  const version = /^s(\d+)\./.exec(raw);
  if (version && version[1] !== '1' && version[1] !== '2') {
    return {
      ok: false,
      message: `This share link uses version s${version[1]}, which this playground does not understand. An example was loaded instead.`,
    };
  }
  if (raw.startsWith('s1.')) return decodeS1(raw.slice(3));
  if (raw.startsWith('s2.')) return decodeS2(raw.slice(3));
  return {
    ok: false,
    message: 'This share link is not a Speckl playground link. It was ignored, and an example was loaded instead.',
  };
}

function decodeS1(payload: string): DecodeResult {
  const bytes = decodeBase64Url(payload);
  if (!bytes) {
    return {
      ok: false,
      message: 'This share link is damaged or was edited, so the spec could not be read. An example was loaded instead.',
    };
  }
  return decodeUtf8(bytes);
}

function decodeS2(payload: string): DecodeResult {
  const bytes = decodeBase64Url(payload);
  if (!bytes || bytes.length < 4) {
    return {
      ok: false,
      message: 'This share link was cut off, so the spec could not be read. An example was loaded instead.',
    };
  }
  const stated = (((bytes[0] << 24) | (bytes[1] << 16) | (bytes[2] << 8) | bytes[3]) >>> 0);
  const body = bytes.subarray(4);
  if (crc32(body) !== stated) {
    return {
      ok: false,
      message: 'This share link was cut off or edited, so the spec could not be read. An example was loaded instead.',
    };
  }
  return decodeUtf8(body);
}

function decodeUtf8(bytes: Uint8Array): DecodeResult {
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

/** IEEE CRC-32. Used so an s2 link that lost its tail does not decode. */
export function crc32(bytes: Uint8Array): number {
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) {
    c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  }
  return (c ^ 0xffffffff) >>> 0;
}

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
    table[n] = c >>> 0;
  }
  return table;
})();
