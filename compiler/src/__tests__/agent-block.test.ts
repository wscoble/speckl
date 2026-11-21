// Parser / printer / IR diagnostics for agent { } blocks.
import { describe, it, expect } from 'vitest';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { join } from 'node:path';
import { parseSpeckContent, parseDurationToMs } from '../parser.js';
import { printAST } from '../printer.js';
import { lower } from '../ir/lower.js';
import { generateAgent } from '../generators/agent/index.js';
import { injectSignalActions } from '../generators/agent/inject-signals.js';

const MINIMAL = `speck Mini {
    state {
        stage: Nat
    }
    init {
        stage := 0
    }
    action Go {
        require stage == 0
        stage := 1
    }
    action Peek {
        return true
    }
    agent {
        stages stage {
            Idle = 0
            AwaitingReview = 1
            Approved = 2
            Rejected = 3
        }
        tool go -> Go effect act
        tool peek -> Peek effect observe
        await AwaitingReview {
            signal review
            mode near
            require outcome in { approve, reject! }
            require claims { reviewer: String }
            on approve -> Approved
            on reject -> Rejected
            timeout 24h -> reject
        }
    }
    next: Go | Peek
}
`;

describe('parseDurationToMs', () => {
  it('parses h/m/s/ms/d', () => {
    expect(parseDurationToMs('24h')).toBe(86_400_000);
    expect(parseDurationToMs('30m')).toBe(1_800_000);
    expect(parseDurationToMs('90s')).toBe(90_000);
    expect(parseDurationToMs('500ms')).toBe(500);
    expect(parseDurationToMs('1d')).toBe(86_400_000);
  });
  it('rejects junk', () => {
    expect(() => parseDurationToMs('24')).toThrow(/duration/);
  });
});

describe('agent { } parser', () => {
  it.each([
    ['FetchAssets', 'fetch_assets'], ['ReadTranscript', 'read_transcript'], ['OpenPR', 'open_pr'],
  ])('infers %s as %s and preserves prompt bindings', (action, name) => {
    const src = MINIMAL.replace(/\bGo\b/g, action)
      .replace(`tool go -> ${action} effect act`, `prompt tool ${name} "brief"\n        tool ${action} effect act`);
    const ast = parseSpeckContent(src);
    const agent = ast.specks[0].members.find(m => m.type === 'agent') as any;
    expect(agent.tools[0]).toMatchObject({ name, action, effect: 'act' });
    expect(agent.prompts[0].tool).toBe(name);
    const printed = printAST(ast);
    expect(printed).toContain(`tool ${action} effect act`);
    expect((parseSpeckContent(printed).specks[0].members.find(m => m.type === 'agent') as any).tools).toEqual(agent.tools);
  });

  it.each([
    ['tool Go -> launch effect act description "Launch it"', 'Launch it'],
    ['tool Go -> launch effect act description file "launch.txt"', { file: 'launch.txt' }],
    ['tool launch -> Go effect act description "Launch it"', 'Launch it'],
    ['tool launch -> Go effect act description file "launch.txt"', { file: 'launch.txt' }],
    ['tool Go effect act description "Launch it"', 'Launch it'],
    ['tool Go effect act description file "launch.txt"', { file: 'launch.txt' }],
  ])('parses and prints %s', (declaration, description) => {
    const ast = parseSpeckContent(MINIMAL.replace('tool go -> Go effect act', declaration));
    const agent = ast.specks[0].members.find(m => m.type === 'agent') as any;
    const alias = declaration.includes('launch ->') || declaration.includes('-> launch');
    expect(agent.tools[0]).toEqual({ name: alias ? 'launch' : 'go', action: 'Go', effect: 'act', description });
    const printed = printAST(ast);
    expect(printed).toContain(`tool Go${alias ? ' -> launch' : ''} effect act description`);
    expect((parseSpeckContent(printed).specks[0].members.find(m => m.type === 'agent') as any).tools).toEqual(agent.tools);
  });
  it('round-trips escaped advisory instructions and tool descriptions', () => {
    const instruction = 'Read "all" } notes and use \\ safely.\nNext line.';
    const description = 'Describe "the" { call \\ accurately.';
    const src = MINIMAL.replace('tool go -> Go effect act', `// unmatched quote " in a comment\n        instruction ${JSON.stringify(instruction)}\n        tool go -> Go effect act description ${JSON.stringify(description)}`);
    const ast = parseSpeckContent(src);
    const agent = ast.specks[0].members.find(m => m.type === 'agent') as any;
    expect(agent.instructions).toEqual([instruction]);
    expect(agent.tools[0].description).toBe(description);
    const again = parseSpeckContent(printAST(ast)).specks[0].members.find(m => m.type === 'agent');
    expect(again).toEqual(expect.objectContaining({ instructions: agent.instructions, tools: agent.tools, awaits: agent.awaits }));
  });

  it('binds prompts to tools, stage and await without bleeding', () => {
    const dir = mkdtempSync(join(tmpdir(), 'speckl-bound-'));
    try {
      const file = join(dir, 'spec.speckdl');
      const src = MINIMAL.replace('tool go -> Go effect act', `prompt tool go stage Idle file "brief.txt"\n        prompt tool go stage Idle await AwaitingReview "review ONLY go"\n        prompt tool peek await AwaitingReview "review ONLY peek"\n        tool go -> Go effect act`);
      writeFileSync(file, src);
      writeFileSync(join(dir, 'brief.txt'), 'GO FILE BRIEF');
      const ast = parseSpeckContent(src, file);
      expect(printAST(parseSpeckContent(printAST(ast)))).toBe(printAST(ast));
      const out = join(dir, 'out');
      generateAgent(ast, { outputDir: out, sourcePath: file });
      const tools = JSON.parse(readFileSync(join(out, 'agent', 'tools.json'), 'utf8')).tools;
      expect(tools[0].description).toContain('[Advisory: stage Idle]\nGO FILE BRIEF');
      expect(tools[0].description).toContain('[Advisory: stage Idle, await AwaitingReview]\nreview ONLY go');
      expect(tools[0].description).not.toContain('review ONLY peek');
      expect(tools[1].description).toContain('[Advisory: await AwaitingReview]\nreview ONLY peek');
      expect(tools[1].description).not.toContain('GO FILE BRIEF');
      const md = readFileSync(join(out, 'agent', 'AGENTS.md'), 'utf8');
      expect(md).toContain('### Tool `go`');
      expect(md).toContain('stage `Idle`');
      expect(md.indexOf('review ONLY go')).toBeGreaterThan(md.indexOf('### `AwaitingReview`'));
      expect(md).toContain('#### Tool `peek`');
      expect(() => parseSpeckContent(src.replace('prompt tool go stage Idle', 'prompt tool missing stage Idle'))).toThrow(/unknown tool/);
      expect(() => parseSpeckContent(src.replace('stage Idle file', 'stage Missing file'))).toThrow(/unknown stage/);
      expect(() => parseSpeckContent(src.replace('await AwaitingReview "review ONLY peek"', 'await Missing "review ONLY peek"'))).toThrow(/unknown await/);
      expect(() => parseSpeckContent(src.replace(/        stages stage \{[\s\S]*?        \}\n/, ''))).toThrow(/unknown stage/);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it('ignores unbalanced braces and escaped quotes in bound prompts', () => {
    const text = 'literal } } and escaped " quote';
    const src = MINIMAL.replace('tool go -> Go effect act', `prompt tool go ${JSON.stringify(text)}\n        prompt tool peek file "path{.txt"\n        tool go -> Go effect act`);
    const ast = parseSpeckContent(src);
    expect((ast.specks[0].members.find(m => m.type === 'agent') as any).prompts).toEqual([
      { tool: 'go', prompt: text }, { tool: 'peek', prompt: { file: 'path{.txt' } },
    ]);
    expect(printAST(parseSpeckContent(printAST(ast)))).toBe(printAST(ast));
  });

  it('rejects malformed advisory strings', () => {
    expect(() => parseSpeckContent(MINIMAL.replace('tool go -> Go effect act', 'instruction "bad\\q"'))).toThrow();
    expect(() => parseSpeckContent(MINIMAL.replace('effect act', 'effect act description missing'))).toThrow();
  });
  it('parses tools, stages, await, timeout', () => {
    const ast = parseSpeckContent(MINIMAL);
    const agent = ast.specks[0].members.find(m => m.type === 'agent');
    expect(agent?.type).toBe('agent');
    if (agent?.type !== 'agent') return;
    expect(agent.stages?.variable).toBe('stage');
    expect(agent.tools).toHaveLength(2);
    expect(agent.tools[0]).toEqual({ name: 'go', action: 'Go', effect: 'act' });
    expect(agent.awaits[0].mode).toBe('near');
    expect(agent.awaits[0].timeout?.durationText).toBe('24h');
    expect(agent.awaits[0].claims[0].name).toBe('reviewer');
    expect(agent.awaits[0].bindCall).toEqual([]);
  });

  it('round-trips through the printer', () => {
    const ast = parseSpeckContent(MINIMAL);
    const printed = printAST(ast);
    const again = parseSpeckContent(printed);
    const a = ast.specks[0].members.find(m => m.type === 'agent');
    const b = again.specks[0].members.find(m => m.type === 'agent');
    expect(b).toEqual(expect.objectContaining({
      type: 'agent',
      tools: (a as any).tools,
      awaits: expect.arrayContaining([
        expect.objectContaining({ state: 'AwaitingReview', signal: 'review', mode: 'near' }),
      ]),
    }));
  });

  it('rejects unknown tool action at lower time', () => {
    const src = MINIMAL.replace('tool go -> Go effect act', 'tool go -> NoSuch effect act');
    const dir = mkdtempSync(join(tmpdir(), 'speckl-agent-diag-'));
    const file = join(dir, 'x.speckdl');
    writeFileSync(file, src);
    try {
      const ir = lower(parseSpeckContent(src, file), { filePath: file, resolveImports: false });
      expect(ir.diagnostics.some(d => d.level === 'error' && /unknown action/.test(d.message))).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('rejects timeout to a non-reject outcome', () => {
    const src = MINIMAL.replace('timeout 24h -> reject', 'timeout 24h -> approve');
    const dir = mkdtempSync(join(tmpdir(), 'speckl-agent-to-'));
    const file = join(dir, 'x.speckdl');
    writeFileSync(file, src);
    try {
      const ir = lower(parseSpeckContent(src, file), { filePath: file, resolveImports: false });
      expect(ir.diagnostics.some(d => /timeout may only resolve to a reject/.test(d.message))).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('rejects bad tool syntax at parse time', () => {
    expect(() => parseSpeckContent(MINIMAL.replace('effect act', 'effect side'))).toThrow(/unexpected line|effect/);
  });

  it('injectSignalActions appends synthetics to next:', () => {
    const inj = injectSignalActions(parseSpeckContent(MINIMAL));
    const actions = inj.specks[0].members.filter(m => m.type === 'action').map((m: any) => m.name);
    expect(actions).toContain('__signal_review_approve');
    expect(actions).toContain('__signal_review_reject');
    const next = inj.specks[0].members.find(m => m.type === 'next') as any;
    expect(next.actions).toContain('__signal_review_approve');
  });
});


describe('file-backed advisory prompts', () => {
  it('round-trips references and embeds file contents alongside inline prompts', () => {
    const dir = mkdtempSync(join(tmpdir(), 'speckl-prompts-'));
    try {
      const file = join(dir, 'spec.speckdl');
      const src = MINIMAL.replace('tool go -> Go effect act', `instruction "inline"\n        instruction file "brief{.txt"\n        tool go -> Go effect act description file "tool.txt"`);
      writeFileSync(file, src);
      writeFileSync(join(dir, 'brief{.txt'), 'First work brief');
      writeFileSync(join(dir, 'tool.txt'), 'First tool description');
      const ast = parseSpeckContent(src, file);
      const printed = printAST(ast);
      expect(printed).toContain('instruction file "brief{.txt"');
      expect(printed).toContain('description file "tool.txt"');
      expect(printAST(parseSpeckContent(printed))).toBe(printed);
      const out = join(dir, 'out');
      generateAgent(ast, { outputDir: out, sourcePath: file });
      const md = () => readFileSync(join(out, 'agent', 'AGENTS.md'), 'utf8');
      const tools = () => JSON.parse(readFileSync(join(out, 'agent', 'tools.json'), 'utf8')).tools;
      expect(md()).toContain('inline');
      expect(md()).toContain('First work brief');
      expect(tools()[0].description).toBe('First tool description');
      const hash = readFileSync(join(out, 'agent', 'spec.sha256'), 'utf8');
      writeFileSync(join(dir, 'brief{.txt'), 'Changed brief');
      writeFileSync(join(dir, 'tool.txt'), 'Changed description');
      generateAgent(ast, { outputDir: out, sourcePath: file });
      expect(md()).toContain('Changed brief');
      expect(tools()[0].description).toBe('Changed description');
      expect(readFileSync(join(out, 'agent', 'spec.sha256'), 'utf8')).toBe(hash);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it('compiles from a different working directory', () => {
    const dir = mkdtempSync(join(tmpdir(), 'speckl-cwd-'));
    try {
      const file = join(dir, 'spec.speckdl');
      writeFileSync(file, MINIMAL.replace('tool go -> Go effect act', 'instruction file "brief.txt"\n        tool go -> Go effect act description file "brief.txt"'));
      writeFileSync(join(dir, 'brief.txt'), 'located beside spec');
      const compiler = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
      const out = join(dir, 'out');
      const run = spawnSync(process.execPath, [join(compiler, 'node_modules/vite-node/vite-node.mjs'), join(compiler, 'src/index.ts'), file, '-t', 'agent', '-o', out], { cwd: compiler, encoding: 'utf8' });
      expect(run.status, run.stderr + run.stdout).toBe(0);
      expect(readFileSync(join(out, 'agent', 'AGENTS.md'), 'utf8')).toContain('located beside spec');
      expect(JSON.parse(readFileSync(join(out, 'agent', 'tools.json'), 'utf8')).tools[0].description).toBe('located beside spec');
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it('fails clearly for missing, nonlocal, and source-less references', () => {
    const dir = mkdtempSync(join(tmpdir(), 'speckl-prompts-'));
    try {
      const file = join(dir, 'spec.speckdl');
      for (const reference of ['instruction file "missing.txt"', 'tool go -> Go effect act description file "missing.txt"']) {
        const ast = parseSpeckContent(MINIMAL.replace('tool go -> Go effect act', reference));
        expect(() => generateAgent(ast, { outputDir: join(dir, 'out'), sourcePath: file })).toThrow(/Cannot read prompt file.*missing.txt/);
        expect(() => generateAgent(ast, { outputDir: join(dir, 'out') })).toThrow(/without a spec source path/);
      }
      for (const ref of ['/tmp/prompt', 'https://example.invalid/prompt']) {
        const ast = parseSpeckContent(MINIMAL.replace('tool go -> Go effect act', `instruction file ${JSON.stringify(ref)}`));
        expect(() => generateAgent(ast, { outputDir: join(dir, 'out'), sourcePath: file })).toThrow(/relative local path/);
      }
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});
