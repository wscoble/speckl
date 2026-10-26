// One pass over SpeckDL source. Comments and string literals do not contribute
// braces. The result is the same length as the source, so a brace's index is
// its column. Newlines are kept, so split lines stay aligned with the file.

export interface MaskOptions {
  /** An unclosed block comment throws, or is blanked through the end of the file. */
  unclosed?: 'throw' | 'blank';
  /** When true, `{` and `}` inside strings become spaces. Comments are always blanked. */
  blankStringBraces?: boolean;
}

/**
 * Blank `//` and `/* *\/` comments. Optionally blank braces inside strings.
 * An unclosed `/*` is a parse error at the line where it opened.
 */
export function maskSource(source: string, opts?: MaskOptions): string {
  const unclosed = opts?.unclosed ?? 'throw';
  const blankStringBraces = opts?.blankStringBraces !== false;
  const parts: string[] = [];
  let i = 0;
  let line = 1;
  let rawFrom = 0;
  const flush = (to: number) => {
    if (to > rawFrom) parts.push(source.slice(rawFrom, to));
    rawFrom = to;
  };

  while (i < source.length) {
    const c = source[i];
    if (c === '"' || c === "'") {
      const quote = c;
      i++;
      while (i < source.length && source[i] !== '\n') {
        if (source[i] === '\\') {
          i += 2;
          continue;
        }
        if (source[i] === quote) {
          i++;
          break;
        }
        if (blankStringBraces && (source[i] === '{' || source[i] === '}')) {
          flush(i);
          parts.push(' ');
          i++;
          rawFrom = i;
          continue;
        }
        i++;
      }
      continue;
    }
    if (c === '/' && source[i + 1] === '/') {
      flush(i);
      const start = i;
      i += 2;
      while (i < source.length && source[i] !== '\n') i++;
      parts.push(' '.repeat(i - start));
      rawFrom = i;
      continue;
    }
    if (c === '/' && source[i + 1] === '*') {
      flush(i);
      const openLine = line;
      const start = i;
      i += 2;
      let closed = false;
      while (i < source.length) {
        if (source[i] === '*' && source[i + 1] === '/') {
          i += 2;
          closed = true;
          break;
        }
        if (source[i] === '\n') line++;
        i++;
      }
      parts.push(source.slice(start, i).replace(/[^\n]/g, ' '));
      rawFrom = i;
      if (!closed && unclosed === 'throw') {
        throw new Error(`Parse error at line ${openLine}: unclosed comment opened at line ${openLine}`);
      }
      continue;
    }
    if (c === '\n') line++;
    i++;
  }
  flush(source.length);
  return parts.join('');
}
