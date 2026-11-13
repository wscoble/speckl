import fs from 'fs';
import { AST, setParseFile } from './speck-part0.js';
import { parseSpeckDocument } from './rd-parser.js';

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
export * from './speck-span.js';

export function parseSpeckFile(filePath: string): AST {
  const content = fs.readFileSync(filePath, 'utf-8');
  return parseSpeckContent(content, filePath);
}

/**
 * Parse SpeckDL content and return the AST
 */

export function parseSpeckContent(content: string, filePath?: string): AST {
  setParseFile(filePath ?? '');
  try {
    return parseSpeckDocument(content, filePath);
  } finally {
    setParseFile('');
  }
}
