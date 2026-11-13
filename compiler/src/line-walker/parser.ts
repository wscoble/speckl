import fs from 'fs';
import { AST, SpeckNode, lexProblem, setParseFile, lexStart } from './speck-part0.js';
import { setParseFile as setLiveParseFile } from '../speck-part0.js';
import { maskLine, nextCodeIsNamedBlock, parseSpeck } from './speck-part1.js';
import { parseImportStatement } from './speck-part3.js';
import { assertClosedSpec } from '../walker-strict.js';

export * from './speck-part0.js';
export * from './speck-part1.js';
export * from './speck-part2.js';
export * from './speck-part3.js';
export * from './speck-part4.js';
export * from './speck-part5.js';
export * from './speck-part6.js';
export * from './speck-part7.js';
export * from './speck-part8.js';
export * from './speck-part9.js';

export function parseSpeckFile(filePath: string): AST {
  const content = fs.readFileSync(filePath, 'utf-8');
  return parseSpeckContent(content, filePath);
}

/**
 * Parse SpeckDL content and return the AST
 */

export function parseSpeckContent(content: string, filePath?: string): AST {
  setParseFile(filePath ?? '');
  // walker-strict throws through the live lexProblem, which reads the live
  // file slot. Set that slot too so the copy's diagnostics name the file.
  setLiveParseFile(filePath ?? '');
  try {
  assertClosedSpec(content, filePath);
  const specks: SpeckNode[] = [];
  const lines = content.split('\n');
  // A `"` must close on its line, and a `/*` must close before the file ends,
  // including at file level, after the last speck, and inside domain text.
  // A comment that opens on a speck's closing line and closes later is fine.
  let scan = lexStart();
  for (let n = 0; n < lines.length; n++) scan = maskLine(lines[n], scan, n + 1).state;
  if (scan.block) throw lexProblem(scan.openLine, 'unterminated block comment');

  let i = 0;
  let lex = lexStart();
  while (i < lines.length) {
    const masked = maskLine(lines[i], lex, i + 1);
    lex = masked.state;
    const line = lines[i].trim();
    const code = masked.text.trim();
    // The line that closes a comment is code from the closer on. A header
    // there does not start the line; treating it as absent drops the speck
    // or the action. A `speck` still inside the comment has no code, so it
    // is not a speck.
    if (line.startsWith('*/') && /^(speck|action|invariant|state|init)\b/.test(code)) {
      throw lexProblem(i + 1, 'header is not at the start of the line');
    }

    // Skip empty lines and comments
    if (!line || !code || line.startsWith('//') || line.startsWith('/*')) {
      i++;
      continue;
    }
    
    // Handle import statements
    if (line.startsWith('import ')) {
      const importNode = parseImportStatement(line);
      // Import is a special case - it's not part of a speck
      // We'll handle it separately in a future update
      i++;
      continue;
    }
    
    // `speck` on its own line, with `Name {` later, used to be skipped.
    // The name belongs on the `speck` line.
    if (code === 'speck' && nextCodeIsNamedBlock(lines, i + 1, lex)) {
      throw lexProblem(i + 1, 'speck name must be on the same line as "speck"');
    }

    // Handle speck definitions. The masked line has to start with `speck`
    // too, so a header that is still inside a block comment is not one.
    if (line.startsWith('speck ') && code.startsWith('speck ')) {
      const speck = parseSpeck(lines, i);
      if (speck) {
        specks.push(speck);
        // Move index past the speck we just parsed
        i++; // Increment by 1, the loop will continue from next line
      } else {
        i++;
      }
      continue;
    }
    
    i++;
  }
  
  return { specks };
  } finally {
    setParseFile('');
    setLiveParseFile('');
  }
}

/**
 * Lexer carry for brace counting. Strings and comments are not structure:
 * a `{` inside `"..."`, a `//` comment, or a block comment must not open
 * or close a speck, action, or verify block. A block comment may span
 * lines. A `"` string may not: it has to close on the line where it opened.
 *
 * `'` is post-state prime notation (`log'`, `stage'`), not a string quote.
 * Treating it as one swallows every later brace until the next prime.
 */
