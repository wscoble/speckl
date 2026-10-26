// Bounds for the in-browser playground. The compiler itself has no size cap;
// these exist so a pasted dump cannot freeze the tab.

/** Specs at least this large must still compile. The hard cap is higher. */
export const MIN_ACCEPTED_BYTES = 1024 * 1024;

/** Refuse to compile past this. 1MB+ inputs still go through. */
export const MAX_SOURCE_BYTES = 2 * 1024 * 1024;

/**
 * Share links are the URL hash. Above this many characters the link is not
 * written; the spec stays in the tab (sessionStorage covers refresh).
 */
export const SHARE_MAX_CHARS = 60_000;

/** A single line this long gets a warning. The worker timeout is the backstop. */
export const LONG_LINE_CHARS = 20_000;

/** How long a compile may run before the page kills the worker. */
export const COMPILE_TIMEOUT_MS = 8_000;

/** Wait after the last keystroke before compiling. */
export const DEBOUNCE_MS = 200;

/** Push a history entry at most this often while typing. */
export const HISTORY_PUSH_MS = 1_500;

export function sourceByteLength(source: string): number {
  return new TextEncoder().encode(source).length;
}

export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return '0 bytes';
  if (bytes < 1024) return `${Math.round(bytes)} bytes`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/**
 * NUL, or a high ratio of ASCII control characters in the leading sample.
 * Tabs, newlines, and carriage returns are text.
 */
export function looksBinary(source: string): boolean {
  if (source.includes('\0')) return true;
  const sample = source.length > 8192 ? source.slice(0, 8192) : source;
  if (sample.length === 0) return false;
  let controls = 0;
  for (let i = 0; i < sample.length; i++) {
    const c = sample.charCodeAt(i);
    if (c === 9 || c === 10 || c === 13) continue;
    if (c < 32 || c === 127) controls++;
  }
  return controls / sample.length > 0.05;
}

export function shareAllowed(source: string): boolean {
  return source.length <= SHARE_MAX_CHARS && sourceByteLength(source) <= MAX_SOURCE_BYTES;
}
