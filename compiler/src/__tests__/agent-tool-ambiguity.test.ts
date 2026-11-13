import { describe, expect, it } from 'vitest';
import { parseSpeckContent } from '../parser.js';
import { printAST } from '../printer.js';

function source(tool: string, action: string): string {
  return `speck Mini {
    agent {
        ${tool}
    }
    action ${action} {
        return true
    }
}`;
}

function tools(src: string) {
  const agent = parseSpeckContent(src).specks[0].members.find(m => m.type === 'agent');
  if (!agent || agent.type !== 'agent') throw new Error('missing agent');
  return agent.tools;
}

describe('agent tool alias orientation', () => {
  it('preserves the legacy orientation when both names are declared actions', () => {
    const src = source('tool Run -> Other effect act', 'Other').replace(
      '    action Other {', '    action Run {\n        return true\n    }\n    action Other {');
    const ast = parseSpeckContent(src);
    expect(tools(src)).toEqual([{ name: 'Run', action: 'Other', effect: 'act' }]);
    expect(tools(printAST(ast))).toEqual(tools(src));
  });
  it.each([
    ['tool LegacyTool -> run effect act', 'run', 'LegacyTool'],
    ['tool run -> launch effect act', 'run', 'launch'],
    ['tool legacy -> run effect act', 'run', 'legacy'],
    ['tool FetchAssets -> PublishEpisode effect observe', 'FetchAssets', 'PublishEpisode'],
    ['tool FETCH -> Run effect act', 'Run', 'FETCH'],
  ])('resolves %s against an action declared later and round-trips', (declaration, action, name) => {
    const src = source(declaration, action);
    const ast = parseSpeckContent(src);
    expect(tools(src)).toEqual([{ action, name, effect: declaration.includes('observe') ? 'observe' : 'act' }]);
    expect(tools(printAST(ast))).toEqual(tools(src));
  });
});
