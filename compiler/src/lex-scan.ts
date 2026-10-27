// Structural scan of SpeckDL source. Brace and delimiter counts must not see
// characters inside a string, a `//` line comment, or a `/* */` block comment.
// `//` inside a string is part of the string. Block-comment state can cross
// lines: pass the returned flag back in as `inBlock`.

/**
 * Call `onCode` for every character that is code. Returns true when a
 * block comment is still open at the end of `text`.
 */
export function scanLine(
  text: string,
  onCode: (ch: string, index: number) => void,
  inBlock = false,
): boolean {
  let i = 0;
  let quote: '"' | "'" | null = null;
  if (inBlock) {
    while (i < text.length) {
      if (text[i] === '*' && text[i + 1] === '/') {
        i += 2;
        inBlock = false;
        break;
      }
      i++;
    }
    if (inBlock) return true;
  }
  while (i < text.length) {
    const c = text[i];
    if (quote) {
      if (c === '\\') { i += 2; continue; }
      if (c === quote) quote = null;
      i++;
      continue;
    }
    if (c === '"' || c === "'") { quote = c; i++; continue; }
    if (c === '/' && text[i + 1] === '/') return false;
    if (c === '/' && text[i + 1] === '*') {
      i += 2;
      let closed = false;
      while (i < text.length) {
        if (text[i] === '*' && text[i + 1] === '/') { i += 2; closed = true; break; }
        i++;
      }
      if (!closed) return true;
      continue;
    }
    onCode(c, i);
    i++;
  }
  return false;
}

export function braceCounts(text: string, inBlock = false): { open: number; close: number; inBlock: boolean } {
  let open = 0;
  let close = 0;
  const still = scanLine(text, (ch) => {
    if (ch === '{') open++;
    else if (ch === '}') close++;
  }, inBlock);
  return { open, close, inBlock: still };
}

/** First `{` and the `}` that balances it, ignoring strings and comments. */
export function blockSpan(text: string): { openAt: number; closeAt: number; balanced: boolean } {
  let openAt = -1;
  let closeAt = -1;
  let depth = 0;
  scanLine(text, (ch, index) => {
    if (ch === '{') {
      if (openAt < 0) openAt = index;
      depth++;
    } else if (ch === '}') {
      depth--;
      if (depth === 0 && closeAt < 0) closeAt = index;
    }
  });
  return { openAt, closeAt, balanced: openAt >= 0 && closeAt >= 0 };
}

/**
 * Drop a trailing `//` comment that is outside a string. Text with no such
 * comment is returned unchanged (callers rely on that).
 */
export function stripTrailingLineComment(text: string): string {
  let quote: '"' | "'" | null = null;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quote) {
      if (c === '\\') { i++; continue; }
      if (c === quote) quote = null;
      continue;
    }
    if (c === '"' || c === "'") { quote = c; i++; continue; }
    if (c === '/' && text[i + 1] === '/') return text.slice(0, i).trim();
  }
  return text;
}

/** Index of `target` in code, or -1. Strings and comments are not code. */
export function indexOfCode(text: string, target: string): number {
  let found = -1;
  scanLine(text, (ch, index) => {
    if (found < 0 && ch === target) found = index;
  });
  return found;
}

/** Index of the last `target` in code, or -1. */
export function lastIndexOfCode(text: string, target: string): number {
  let found = -1;
  scanLine(text, (ch, index) => {
    if (ch === target) found = index;
  });
  return found;
}
