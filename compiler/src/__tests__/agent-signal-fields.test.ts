// Priority and kpi tags copied onto the generated agent config.
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { compileSpec } from '../compile.js';

function compile(source: string): { config: { tools: { name: string; priority?: string; kpis?: string[] }[] }; tools: { tools: { name: string; 'x-speckl': { priority?: string; kpis?: string[] } }[] } } {
  const dir = mkdtempSync(join(tmpdir(), 'speckl-signal-fields-'));
  const file = join(dir, 't.speckdl');
  writeFileSync(file, source);
  const log = vi.spyOn(console, 'log').mockImplementation(() => {});
  try {
    compileSpec(file, { outputDir: join(dir, 'out'), target: 'agent', bomFormat: 'cdx', verifyDepth: 1 });
  } finally {
    log.mockRestore();
  }
  const agent = join(dir, 'out', 'agent');
  const config = JSON.parse(readFileSync(join(agent, 'agent-config.json'), 'utf8'));
  const tools = JSON.parse(readFileSync(join(agent, 'tools.json'), 'utf8'));
  rmSync(dir, { recursive: true, force: true });
  return { config, tools };
}

const base = `speck Worker {
    state { stage: Nat }
    init { stage := 0 }
    action Go {
        priority P0
        stage := 1
        emit Noted { }
    }
    action Quiet {
        stage := stage
    }
    action Branched {
        if stage == 0 {
            emit Hidden { }
        }
        stage := 1
    }
    action Commented {
        stage := stage
    }
    event Noted kpi "notes" { }
    event Hidden kpi "hidden" { }
    agent {
        tool go -> Go effect act
        tool quiet -> Quiet effect act
        tool branched -> Branched effect act
        tool commented -> Commented effect observe
    }
}
domain Ops {
    members: Worker;
    priority P1;
    produces Noted, Hidden;
}
`;

describe('agent completion-signal fields', () => {
  it('copies an action priority and a straight-line kpi onto the tool', () => {
    const { config, tools } = compile(base);
    const go = config.tools.find(t => t.name === 'go');
    expect(go?.priority).toBe('P0');
    expect(go?.kpis).toEqual(['notes']);
    const tagged = tools.tools.find(t => t.name === 'go');
    expect(tagged?.['x-speckl'].priority).toBe('P0');
    expect(tagged?.['x-speckl'].kpis).toEqual(['notes']);
  });

  it('uses the domain priority when the action declares none', () => {
    const { config } = compile(base);
    expect(config.tools.find(t => t.name === 'quiet')?.priority).toBe('P1');
    expect(config.tools.find(t => t.name === 'quiet')?.kpis).toBeUndefined();
  });

  it('does not tag an emit inside an if or a comment', () => {
    const source = base.replace(
      '    action Commented {\n        stage := stage\n    }',
      '    action Commented {\n        // emit Noted { }\n        stage := stage\n    }',
    );
    const { config } = compile(source);
    expect(config.tools.find(t => t.name === 'branched')?.kpis).toBeUndefined();
    expect(config.tools.find(t => t.name === 'commented')?.kpis).toBeUndefined();
  });

  it('omits priority and kpis when the speck declares neither', () => {
    const source = `speck Worker {
    state { stage: Nat }
    init { stage := 0 }
    action Go { stage := 1 }
    agent {
        tool go -> Go effect act
    }
}
`;
    const { config, tools } = compile(source);
    expect(config.tools[0].priority).toBeUndefined();
    expect(config.tools[0].kpis).toBeUndefined();
    expect(tools.tools[0]['x-speckl'].priority).toBeUndefined();
    expect(tools.tools[0]['x-speckl'].kpis).toBeUndefined();
  });
});
