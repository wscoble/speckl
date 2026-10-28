import type { AgentHarnessRule } from './parser.js';

const HARNESS_MAP_RE = new RegExp(
  '^map\\s+([A-Za-z_][\\w:.-]*(?:\\s*\\|\\s*[A-Za-z_][\\w:.-]*)*)'
  + '(?:\\s+([A-Za-z_]\\w*)\\s*~\\s*"((?:[^"\\\\]|\\\\.)*)")?'
  + '\\s*->\\s*([A-Za-z_][\\w-]*)'
  + '\\s*(?:\\{([^}]*)\\})?\\s*$',
);

/** Parse one `map ...` line of a harness block. */
export function parseHarnessMapLine(line: string, harness: string): AgentHarnessRule {
  const m = line.match(HARNESS_MAP_RE);
  if (!m) {
    throw new Error(`Parse error in harness ${harness}: expected map <Tool>[|<Tool>] [<field> ~ "<regex>"] -> <tool> [{ param = field }], got ${JSON.stringify(line)}`);
  }
  const tools = m[1].split('|').map(s => s.trim());
  const rule: AgentHarnessRule = { tools, target: m[4], params: [] };
  if (m[2] !== undefined) {
    rule.field = m[2];
    rule.pattern = m[3].replace(/\\"/g, '"');
  }
  if (m[5] !== undefined) {
    for (const part of m[5].split(',')) {
      const p = part.trim();
      if (!p) continue;
      const pm = p.match(/^([A-Za-z_]\w*)\s*=\s*([A-Za-z_]\w*)$/);
      if (!pm) {
        throw new Error(`Parse error in harness ${harness}: input mapping must be param = field, got ${JSON.stringify(p)}`);
      }
      rule.params.push({ param: pm[1], field: pm[2] });
    }
  }
  return rule;
}

/** Parse durations like `24h`, `30m`, `90s`, `500ms` into milliseconds. */
export function parseDurationToMs(text: string): number {
  const m = text.match(/^(\d+)(ms|s|m|h|d)$/);
  if (!m) {
    throw new Error(`Parse error: duration ${JSON.stringify(text)} must look like 24h, 30m, 90s, or 500ms`);
  }
  const n = parseInt(m[1], 10);
  switch (m[2]) {
    case 'ms': return n;
    case 's': return n * 1000;
    case 'm': return n * 60_000;
    case 'h': return n * 3_600_000;
    case 'd': return n * 86_400_000;
    default: throw new Error(`Parse error: unknown duration unit in ${text}`);
  }
}
