// Each row is an intended difference from the line walker. The assertion is
// the after-value. The before-value is what the line walker stored, and this
// parser must not store it.
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

describe('intended parser differences', () => {
  it('KafkaKRaft LogEntry is the record term, value, and the state fields stay on the state', () => {
    const speck = parseExample('KafkaKRaft.speckdl').specks[0];
    const logEntry = speck.members.find(m => m.type === 'interface' && m.name === 'LogEntry');
    if (logEntry?.type !== 'interface') throw new Error('missing LogEntry');
    expect(logEntry.kind).toBe('record');
    expect(logEntry.fields.map(f => f.name)).toEqual(['term', 'value']);
    expect(logEntry.fields.map(f => f.name)).not.toContain('currentTerm');
    const state = speck.members.find(m => m.type === 'state');
    if (state?.type !== 'state') throw new Error('missing state');
    expect(state.variables.map(v => v.name)).toEqual([
      'currentTerm', 'state', 'votedFor', 'log', 'commitIndex', 'nextIndex', 'matchIndex', 'votesGranted',
    ]);
  });

  it('OAuth invariants drop the trailing line comment and keep the expression', () => {
    const speck = parseExample('OAuth2AuthorizationCode.speckdl').specks[0];
    const expr = (name: string) => {
      const member = speck.members.find(m => m.type === 'invariant' && m.name === name);
      if (member?.type !== 'invariant') throw new Error(`missing ${name}`);
      return member.expr;
    };
    const bounded = expr('TokenValidityBounded');
    expect(bounded).toBe(
      'forall token in accessTokens.keys: let t := accessTokens[token] t.expires_at > currentTime forall rt in refreshTokens.keys: let r := refreshTokens[rt] currentTime - r.created_at <= 7776000',
    );
    expect(bounded).not.toContain('// 90 days max');
    const redirect = expr('RedirectUriConsistency');
    expect(redirect).toBe(
      'forall code in authorizationCodes.keys: let c := authorizationCodes[code] true',
    );
    expect(redirect).not.toContain('// This is enforced in the ExchangeCode action');
  });

  it('a header-line close ends the speck and does not absorb the next one', () => {
    const src = 'speck A { state { x: Nat } }\nspeck B {\n  state { y: Nat }\n}\n';
    const ast = parseSpeckContent(src, 'header.speckdl');
    expect(ast.specks.map(s => ({
      name: s.name,
      endLine: s.endLine,
      fields: s.members.flatMap(m => m.type === 'state' ? m.variables.map(v => v.name) : []),
    }))).toEqual([
      { name: 'A', endLine: 1, fields: [] },
      { name: 'B', endLine: 4, fields: ['y'] },
    ]);
  });

  it('a one-line state stores its field', () => {
    const src = 'speck A {\n    state { x: Nat }\n    init { x := 0 }\n}\n';
    const speck = parseSpeckContent(src, 'one.speckdl').specks[0];
    const state = speck.members.find(m => m.type === 'state');
    const init = speck.members.find(m => m.type === 'init');
    if (state?.type !== 'state' || init?.type !== 'init') throw new Error('missing state or init');
    expect(state.variables.map(v => v.name)).toEqual(['x']);
    expect(init.assignments).toEqual([{ name: 'x', expr: '0' }]);
  });
});
