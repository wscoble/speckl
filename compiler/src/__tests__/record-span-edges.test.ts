// A one-line record stores the brace span. The line walker started on the
// next line and kept the following state and init text as fields.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { parseSpeckContent } from '../parser.js';

const examplesDir = join(fileURLToPath(new URL('.', import.meta.url)), '..', '..', '..', 'examples');

function fieldsOf(src: string, name: string): string[] {
  const ast = parseSpeckContent(src, 'rec.speckdl');
  const member = ast.specks[0].members.find(m => m.type === 'interface' && m.name === name);
  if (member?.type !== 'interface') throw new Error(`missing ${name}`);
  return member.fields.map(f => f.name);
}

const probe = [
  'speck S {',
  '    type LogEntry = { term: Nat, value: Value }',
  '    state {',
  '        currentTerm: Nat',
  '    }',
  '    init {',
  '        currentTerm := 0',
  '    }',
  '}',
  '',
].join('\n');

describe('one-line record span', () => {
  it('stores the brace span, where the line walker stored the following lines', () => {
    // Before, on the line walker: LogEntry fields were currentTerm and the
    // init line `currentTerm := 0`, and TypeScript emitted `currentTerm: = 0`.
    const before = ['currentTerm', 'currentTerm'];
    const after = fieldsOf(probe, 'LogEntry');
    expect(after).not.toEqual(before);
    expect(after).toEqual(['term', 'value']);
    const ast = parseSpeckContent(probe, 'rec.speckdl');
    const state = ast.specks[0].members.find(m => m.type === 'state');
    if (state?.type !== 'state') throw new Error('missing state');
    expect(state.variables.map(v => v.name)).toEqual(['currentTerm']);
  });

  it('keeps KafkaKRaft LogEntry to term and value', () => {
    const file = join(examplesDir, 'KafkaKRaft.speckdl');
    const ast = parseSpeckContent(readFileSync(file, 'utf8'), 'KafkaKRaft.speckdl');
    const logEntry = ast.specks[0].members.find(m => m.type === 'interface' && m.name === 'LogEntry');
    if (logEntry?.type !== 'interface') throw new Error('missing LogEntry');
    expect(logEntry.fields.map(f => f.name)).toEqual(['term', 'value']);
  });

  it('stores an empty record, a comment after the close, and a nested field type', () => {
    expect(fieldsOf('speck S {\n    type Empty = { }\n}\n', 'Empty')).toEqual([]);
    expect(fieldsOf('speck S {\n    type Pair = { a: Nat, b: Nat } // note\n}\n', 'Pair')).toEqual(['a', 'b']);
    const ast = parseSpeckContent('speck S {\n    type Box = { inner: { n: Nat } }\n}\n', 'rec.speckdl');
    const box = ast.specks[0].members.find(m => m.type === 'interface' && m.name === 'Box');
    if (box?.type !== 'interface') throw new Error('missing Box');
    expect(box.fields.map(f => f.name)).toEqual(['inner']);
    expect(box.fields[0].type.type).toBe('record');
  });

  it('does not keep a line comment as a field type', () => {
    const src = 'speck S {\n    type Row = {\n        term: Nat // leader\n        value: Value\n    }\n}\n';
    const ast = parseSpeckContent(src, 'rec.speckdl');
    const row = ast.specks[0].members.find(m => m.type === 'interface' && m.name === 'Row');
    if (row?.type !== 'interface') throw new Error('missing Row');
    expect(row.fields.map(f => f.name)).toEqual(['term', 'value']);
    expect(JSON.stringify(row.fields)).not.toContain('leader');
  });
});
