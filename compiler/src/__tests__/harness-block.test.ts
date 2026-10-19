// Parser / printer / IR diagnostics / generator for `harness` blocks.
import { describe, it, expect } from 'vitest';
import { mkdtempSync, readFileSync, existsSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseSpeckContent, parseHarnessMapLine, AgentMemberNode } from '../parser.js';
import { printAST } from '../printer.js';
import { lower } from '../ir/lower.js';
import { generateAgent, compileHarnesses } from '../generators/agent/index.js';

function spec(harness: string): string {
  return `speck Mini {
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
    action Look(path: String) {
        return true
    }
    agent {
        stages stage {
            Idle = 0
            Done = 1
        }
        tool go -> Go effect act
        tool look -> Look effect observe
${harness}
    }
    next: Go | Look
}`;
}

const GOOD = `        harness claude-code {
            // comment lines are fine
            map Bash command ~ "make go( -j[0-9]{1,2})?" -> go
            map Read|Grep -> look { path = file_path }
            map mcp__fs__read_file -> look
        }
        harness cursor {
            map Shell command ~ "echo \\"hi\\"" -> go
        }`;

const agentOf = (src: string) => parseSpeckContent(src).specks[0].members.find(m => m.type === 'agent') as AgentMemberNode;
const errorsOf = (src: string) => {
  const file = join(mkdtempSync(join(tmpdir(), 'speckl-harness-lower-')), 'Mini.speckdl');
  writeFileSync(file, src);
  return lower(parseSpeckContent(src, file), { filePath: file, resolveImports: false })
    .diagnostics.filter(d => d.message.startsWith('agent harness'));
};

describe('harness block parsing', () => {
  it('parses map lines with patterns, renames and multi-tool lists', () => {
    const a = agentOf(spec(GOOD));
    expect(a.harnesses).toEqual([
      {
        name: 'claude-code',
        rules: [
          { tools: ['Bash'], field: 'command', pattern: 'make go( -j[0-9]{1,2})?', target: 'go', params: [] },
          { tools: ['Read', 'Grep'], target: 'look', params: [{ param: 'path', field: 'file_path' }] },
          { tools: ['mcp__fs__read_file'], target: 'look', params: [] },
        ],
      },
      { name: 'cursor', rules: [{ tools: ['Shell'], field: 'command', pattern: 'echo "hi"', target: 'go', params: [] }] },
    ]);
  });
  it('omits harnesses when none are declared (AST unchanged for older specs)', () => {
    expect('harnesses' in agentOf(spec(''))).toBe(false);
  });
  it('accepts Cursor MCP names and hyphenated server names', () => {
    expect(parseHarnessMapLine('map MCP:create_pr|mcp__my-srv__x -> go', 'h').tools).toEqual(['MCP:create_pr', 'mcp__my-srv__x']);
  });
  it('rejects malformed map lines', () => {
    expect(() => parseHarnessMapLine('map Bash -> ', 'h')).toThrow(/expected map/);
    expect(() => parseHarnessMapLine('map Bash command "x" -> go', 'h')).toThrow(/expected map/);
    expect(() => parseHarnessMapLine('map Read -> look { path: file_path }', 'h')).toThrow(/param = field/);
    expect(() => parseSpeckContent(spec('        harness claude-code {\n            allow Bash\n        }'))).toThrow(/expected map/);
  });
  it('round-trips through the printer', () => {
    const ast = parseSpeckContent(spec(GOOD));
    const again = parseSpeckContent(printAST(ast));
    expect(agentOf(printAST(again))).toEqual(agentOf(printAST(ast)));
    expect((again.specks[0].members.find(m => m.type === 'agent') as AgentMemberNode).harnesses)
      .toEqual(agentOf(spec(GOOD)).harnesses);
  });
});

describe('harness validation', () => {
  it('a good block has no diagnostics', () => {
    expect(errorsOf(spec(GOOD))).toEqual([]);
  });
  it('reports unknown harnesses, duplicates, targets, params and patterns', () => {
    const bad = `        harness windsurf {
            map X -> go
        }
        harness cursor {
            map Shell command ~ "(" -> go
            map Read -> nope
            map Read -> look { file = file_path, path = a, path = b }
        }
        harness cursor {
        }`;
    const msgs = errorsOf(spec(bad)).map(d => `${d.level}: ${d.message}`);
    expect(msgs).toEqual(expect.arrayContaining([
      'error: agent harness windsurf: unknown harness (supported: claude-code, cursor, codex, gemini, copilot, goose, hermes)',
      expect.stringMatching(/^error: agent harness cursor map Shell: pattern "\(" is not a valid regular expression/),
      'error: agent harness cursor map Read: -> nope is not a declared tool',
      'error: agent harness cursor map Read: file is not a parameter of Look (has: path)',
      'error: agent harness cursor map Read: path is mapped twice',
      'error: agent harness cursor: declared twice',
      'warning: agent harness cursor: no map lines; every tool call will be denied',
    ]));
  });
});

describe('harness generation', () => {
  it('emits adapter, config rules with resolved inputs, wiring and docs sections', () => {
    const out = mkdtempSync(join(tmpdir(), 'speckl-harness-gen-'));
    generateAgent(parseSpeckContent(spec(GOOD)), { outputDir: out });
    const dir = join(out, 'agent');
    const cfg = JSON.parse(readFileSync(join(dir, 'agent-config.json'), 'utf-8'));
    expect(cfg.harness['claude-code'].rules[1]).toEqual({ tools: ['Read', 'Grep'], target: 'look', inputs: [{ param: 'path', field: 'file_path' }] });
    expect(cfg.harness['claude-code'].rules[2].inputs).toEqual([{ param: 'path', field: 'path' }]);
    expect(cfg.harness['claude-code'].rules[0]).toMatchObject({ field: 'command', pattern: 'make go( -j[0-9]{1,2})?', inputs: [] });
    expect(existsSync(join(dir, 'adapter.mjs'))).toBe(true);
    const settings = JSON.parse(readFileSync(join(dir, 'harness', 'claude-code', 'settings.json'), 'utf-8'));
    expect(settings.hooks.PreToolUse[0].hooks[0].onFailure).toBe('block');
    const cursor = JSON.parse(readFileSync(join(dir, 'harness', 'cursor', 'hooks.json'), 'utf-8'));
    expect(cursor.hooks.preToolUse[0].failClosed).toBe(true);
    const agentsMd = readFileSync(join(dir, 'AGENTS.md'), 'utf-8');
    expect(agentsMd).toContain('## Harness wiring');
    expect(agentsMd).toContain('| `Bash` | `command` matches `make go( -j[0-9]{1,2})?` | `go` |');
    expect(readFileSync(join(dir, 'README.md'), 'utf-8')).toContain('node adapter.mjs install <harness>');
  });
  it('no harness block: no adapter, no harness config, README points at the docs', () => {
    const out = mkdtempSync(join(tmpdir(), 'speckl-harness-none-'));
    generateAgent(parseSpeckContent(spec('')), { outputDir: out });
    const dir = join(out, 'agent');
    expect(existsSync(join(dir, 'adapter.mjs'))).toBe(false);
    expect(existsSync(join(dir, 'harness'))).toBe(false);
    expect(JSON.parse(readFileSync(join(dir, 'agent-config.json'), 'utf-8')).harness).toBeUndefined();
    expect(readFileSync(join(dir, 'AGENTS.md'), 'utf-8')).not.toContain('Harness wiring');
    expect(readFileSync(join(dir, 'README.md'), 'utf-8')).toContain('docs/harness-adapters.md');
  });
  it('compileHarnesses tolerates an action without params', () => {
    const a = agentOf(spec(GOOD));
    expect(compileHarnesses(a, [])['cursor'].rules[0].inputs).toEqual([]);
  });
});
