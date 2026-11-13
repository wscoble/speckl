// Outlines of every example. The token parser matches the line walker, so
// this hash is the walker's outline. A new difference fails the hash.
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { parseSpeckContent, type MemberNode, type TypeExpr } from '../parser.js';

const here = fileURLToPath(new URL('.', import.meta.url));
const examplesDir = join(here, '..', '..', '..', 'examples');

interface OutlineMember {
  type: string;
  name?: string;
  tools?: string[];
  prompts?: string[];
  instructions?: number;
  awaits?: string[];
  vars?: string[];
  iface?: { kind: string; fields: string[]; methods: string[] };
  expr?: string;
  init?: string[];
  params?: string[];
}

function typeText(t: TypeExpr | undefined): string {
  if (!t) return '';
  switch (t.type) {
    case 'primitive':
    case 'ident':
      return t.name ?? '';
    case 'list':
      return `List(${typeText(t.elementType)})`;
    case 'set':
      return `Set(${typeText(t.elementType)})`;
    case 'map':
      return `Map(${typeText(t.keyType)},${typeText(t.valueType)})`;
    case 'record':
      return '{' + (t.fields ?? []).map(f => `${f.name}:${typeText(f.type)}`).join(',') + '}';
  }
}

function memberOutline(m: MemberNode): OutlineMember {
  const row: OutlineMember = { type: m.type };
  if ('name' in m && typeof m.name === 'string' && m.name) row.name = m.name;
  if (m.type === 'agent') {
    row.tools = m.tools.map(t => `${t.name}->${t.action}:${t.effect}${t.description !== undefined ? ':desc' : ''}`);
    row.prompts = (m.prompts ?? []).map(p => `${p.tool}${p.stage ? '@' + p.stage : ''}${p.await ? '#' + p.await : ''}`);
    row.instructions = (m.instructions ?? []).length;
    row.awaits = m.awaits.map(a => a.state);
  } else if (m.type === 'state') {
    row.vars = m.variables.map(v => `${v.name}:${typeText(v.typeExpr)}`);
  } else if (m.type === 'interface') {
    row.iface = { kind: m.kind, fields: m.fields.map(f => f.name), methods: m.methods.map(method => method.name) };
  } else if (m.type === 'invariant') {
    row.expr = m.expr;
  } else if (m.type === 'init') {
    row.init = m.assignments.map(a => a.name);
  } else if (m.type === 'action') {
    row.params = m.params.map(p => p.name);
  }
  return row;
}

function outlineExamples(): string {
  const out: Record<string, { name: string; members: OutlineMember[] }[]> = {};
  for (const file of readdirSync(examplesDir).filter(f => f.endsWith('.speckdl')).sort()) {
    const ast = parseSpeckContent(readFileSync(join(examplesDir, file), 'utf8'), file);
    out[file] = ast.specks.map(s => ({ name: s.name, members: s.members.map(memberOutline) }));
  }
  return JSON.stringify(out);
}

const CORPUS_SHA256 = 'fe6289d16c1b94af6ba946ce4e88a6fff6060c000a7407a32a365cba7bee4c91';

describe('example corpus', () => {
  it('matches the line-walker outline of every example', () => {
    const outline = outlineExamples();
    const hash = createHash('sha256').update(outline).digest('hex');
    expect(hash).toBe(CORPUS_SHA256);
  });

  it('keeps Kafka state fields, and LogEntry is only term and value', () => {
    const outline = JSON.parse(outlineExamples()) as Record<string, { members: OutlineMember[] }[]>;
    const speck = outline['KafkaKRaft.speckdl'][0];
    const logEntry = speck.members.find(m => m.name === 'LogEntry');
    const state = speck.members.find(m => m.type === 'state');
    expect(logEntry?.iface).toEqual({ kind: 'record', fields: ['term', 'value'], methods: [] });
    expect(state?.vars?.map(v => v.split(':')[0])).toEqual([
      'currentTerm', 'state', 'votedFor', 'log', 'commitIndex', 'nextIndex', 'matchIndex', 'votesGranted',
    ]);
  });

  it('keeps PodcastPublishing prompts, instructions, and inferred tool names', () => {
    const outline = JSON.parse(outlineExamples()) as Record<string, { members: OutlineMember[] }[]>;
    const agent = outline['PodcastPublishing.speckdl'][0].members.find(m => m.type === 'agent');
    expect(agent?.instructions).toBe(1);
    expect(agent?.tools).toContain('fetch_assets->FetchAssets:act');
    expect(agent?.tools).toContain('apply_metadata->ApplyMetadata:act:desc');
    expect(agent?.prompts).toContain('apply_metadata#AwaitingApproval');
    expect(agent?.awaits).toEqual(['AwaitingApproval']);
  });

  it('a speck that closes on its header line still follows the line walker', () => {
    const alone = parseSpeckContent('speck A { state { x: Nat } }\n', 'one.speckdl');
    expect(alone.specks.map(s => ({ name: s.name, members: s.members.length, endLine: s.endLine }))).toEqual([
      { name: 'A', members: 0, endLine: 1 },
    ]);
    const packed = parseSpeckContent(
      'speck A { state { x: Nat } }\nspeck B {\n  state { y: Nat }\n}\n',
      'packed.speckdl',
    );
    expect(packed.specks.map(s => ({
      name: s.name,
      endLine: s.endLine,
      fields: s.members.flatMap(m => m.type === 'state' ? m.variables.map(v => v.name) : []),
    }))).toEqual([
      { name: 'A', endLine: 3, fields: [] },
      { name: 'B', endLine: 4, fields: [] },
    ]);
  });

  it('a brace inside an agent prompt or description does not drop the next action', () => {
    const src = [
      'speck A {',
      '    state { x: Nat }',
      '    init { x := 0 }',
      '    action Go { x := 1 }',
      '    action Later { x := 2 }',
      '    agent {',
      '        instruction "keep } this"',
      '        prompt tool go "also { braces }"',
      '        tool Go effect act description "end } here"',
      '    }',
      '}',
      '',
    ].join('\n');
    const ast = parseSpeckContent(src, 'prompt.speckdl');
    const speck = ast.specks[0];
    expect(speck.members.map(m => m.type === 'action' ? m.name : m.type)).toEqual(['state', 'init', 'Go', 'Later', 'agent']);
    const agent = speck.members.find(m => m.type === 'agent');
    if (agent?.type !== 'agent') throw new Error('missing agent');
    expect(agent.instructions).toEqual(['keep } this']);
    expect(agent.prompts).toEqual([{ tool: 'go', prompt: 'also { braces }' }]);
    expect(agent.tools).toEqual([{ name: 'go', action: 'Go', effect: 'act', description: 'end } here' }]);
  });
});
