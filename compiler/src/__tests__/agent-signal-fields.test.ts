// Priority and kpi tags copied onto the generated agent config.
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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

  it('does not use a domain priority when the speck is not a member', () => {
    const source = `speck Idle {
    state { stage: Nat }
    init { stage := 0 }
    action Go { stage := 1 }
    agent { tool go -> Go effect act }
}
speck Worker {
    state { stage: Nat }
    init { stage := 0 }
    action Go { stage := 1 }
    agent { tool go -> Go effect act }
}
domain Ops { members: Idle; priority P9; }
`;
    const { config } = compile(source);
    expect(config.tools[0].priority).toBeUndefined();
  });

  it('does not tag an emit after return', () => {
    const source = base.replace(
      '        emit Noted { }',
      '        return stage\n        emit Noted { }',
    );
    const { config } = compile(source);
    expect(config.tools.find(t => t.name === 'go')?.kpis).toBeUndefined();
    expect(config.tools.find(t => t.name === 'go')?.priority).toBe('P0');
  });

  it('tags a repeated kpi once', () => {
    const source = base
      .replace('event Hidden kpi "hidden"', 'event Hidden kpi "notes"')
      .replace('emit Noted { }', 'emit Noted { }\n        emit Hidden { }');
    const { config } = compile(source);
    expect(config.tools.find(t => t.name === 'go')?.kpis).toEqual(['notes']);
  });

  it('copies an action priority onto an observe tool', () => {
    const source = base.replace(
      '    action Commented {\n        stage := stage\n    }',
      '    action Commented {\n        priority P3\n        stage := stage\n    }',
    );
    const { config } = compile(source);
    expect(config.tools.find(t => t.name === 'commented')?.priority).toBe('P3');
  });

  it('copies a kpi onto an observe tool', () => {
    const source = base.replace(
      '    action Commented {\n        stage := stage\n    }',
      '    action Commented {\n        stage := stage\n        emit Noted { }\n    }',
    );
    const { config } = compile(source);
    expect(config.tools.find(t => t.name === 'commented')?.kpis).toEqual(['notes']);
  });

  it('a line that is only return does not stop the scan', () => {
    const source = base.replace(
      '        emit Noted { }',
      '        return\n        emit Noted { }',
    );
    const { config } = compile(source);
    expect(config.tools.find(t => t.name === 'go')?.kpis).toEqual(['notes']);
    expect(config.tools.find(t => t.name === 'go')?.priority).toBe('P0');
  });

  it('does not write a decision line', () => {
    const dir = mkdtempSync(join(tmpdir(), 'speckl-signal-fields-'));
    const file = join(dir, 't.speckdl');
    writeFileSync(file, base);
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      compileSpec(file, { outputDir: join(dir, 'out'), target: 'agent', bomFormat: 'cdx', verifyDepth: 1 });
      const names = readdirSync(join(dir, 'out'), { recursive: true }).map(String);
      expect(names.some(name => name.endsWith('log.jsonl') || name.endsWith('head.json'))).toBe(false);
    } finally {
      log.mockRestore();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
