import deployGate from '../../../examples/DeployGate.speckdl?raw';
import agentPolicy from '../../../examples/AgentPolicy.speckdl?raw';
import claudeCode from '../../../examples/ClaudeCodePolicy.speckdl?raw';
import toggleSwitch from '../../../examples/ToggleSwitch.speckdl?raw';

export interface ExampleSpec {
  id: string;
  title: string;
  blurb: string;
  source: string;
}

export const EXAMPLES: ExampleSpec[] = [
  {
    id: 'deploy-gate',
    title: 'DeployGate',
    blurb: 'Call-bound sign-off: one approval covers one deploy',
    source: deployGate,
  },
  {
    id: 'agent-policy',
    title: 'Agent policy',
    blurb: 'Tools, a hook, and a human review signal',
    source: agentPolicy,
  },
  {
    id: 'claude-code',
    title: 'Claude Code policy',
    blurb: 'The same rails, wired into Claude Code and Cursor hooks',
    source: claudeCode,
  },
  {
    id: 'toggle',
    title: 'Toggle switch',
    blurb: 'The smallest state machine, with no agent block',
    source: toggleSwitch,
  },
];

export function matchingExampleId(source: string): string | null {
  const found = EXAMPLES.find((ex) => ex.source === source);
  return found ? found.id : null;
}
