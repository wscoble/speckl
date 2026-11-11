// The token parser stores the same members the line walker stored. The
// output-hash pin stays on that output. A later change can store a different
// shape, and that change has to say why the walker was wrong.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { parseSpeckContent } from '../parser.js';

const examplesDir = join(fileURLToPath(new URL('.', import.meta.url)), '..', '..', '..', 'examples');

function parseExample(name: string) {
  const file = join(examplesDir, name);
  return parseSpeckContent(readFileSync(file, 'utf8'), name);
}

describe('token parser matches the line walker', () => {
  it('KafkaKRaft LogEntry is only the brace span, not the following state fields', () => {
    const speck = parseExample('KafkaKRaft.speckdl').specks[0];
    const logEntry = speck.members.find(m => m.type === 'interface' && m.name === 'LogEntry');
    if (logEntry?.type !== 'interface') throw new Error('missing LogEntry');
    // The line walker stored a mixed interface whose fields were the state
    // fields that follow the record, including currentTerm. That was wrong:
    // `type LogEntry = { term: Nat, value: Value }` has two fields.
    expect(logEntry.kind).toBe('record');
    expect(logEntry.fields.map(f => f.name)).toEqual(['term', 'value']);
    expect(logEntry.fields.map(f => f.name)).not.toContain('currentTerm');
    const state = speck.members.find(m => m.type === 'state');
    if (state?.type !== 'state') throw new Error('missing state');
    expect(state.variables.map(v => v.name)).toEqual([
      'currentTerm', 'state', 'votedFor', 'log', 'commitIndex', 'nextIndex', 'matchIndex', 'votesGranted',
    ]);
  });

  it('OAuth invariants keep the trailing line comment the line walker stored', () => {
    const speck = parseExample('OAuth2AuthorizationCode.speckdl').specks[0];
    const expr = (name: string) => {
      const member = speck.members.find(m => m.type === 'invariant' && m.name === name);
      if (member?.type !== 'invariant') throw new Error(`missing ${name}`);
      return member.expr;
    };
    expect(expr('TokenValidityBounded')).toContain('7776000  // 90 days max');
    expect(expr('RedirectUriConsistency')).toBe(
      'forall code in authorizationCodes.keys: let c := authorizationCodes[code] true  // This is enforced in the ExchangeCode action',
    );
  });

  it('a header-line close still absorbs the next speck, as the line walker did', () => {
    const src = 'speck A { state { x: Nat } }\nspeck B {\n  state { y: Nat }\n}\n';
    const ast = parseSpeckContent(src, 'header.speckdl');
    expect(ast.specks.map(s => ({
      name: s.name,
      endLine: s.endLine,
      fields: s.members.flatMap(m => m.type === 'state' ? m.variables.map(v => v.name) : []),
    }))).toEqual([
      { name: 'A', endLine: 3, fields: [] },
      { name: 'B', endLine: 4, fields: [] },
    ]);
  });

  it('a one-line state stores no variables, as the line walker did', () => {
    const src = 'speck A {\n    state { x: Nat }\n    init { x := 0 }\n}\n';
    const speck = parseSpeckContent(src, 'one.speckdl').specks[0];
    const state = speck.members.find(m => m.type === 'state');
    const init = speck.members.find(m => m.type === 'init');
    if (state?.type !== 'state' || init?.type !== 'init') throw new Error('missing state or init');
    expect(state.variables.map(v => v.name)).toEqual([]);
    expect(init.assignments).toEqual([]);
  });
});
