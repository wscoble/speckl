// Pure session rules for the playground page: share links, history, stale
// compiles, and caret position. No DOM and no compiler, so the page and the
// tests share one implementation.

import { HISTORY_PUSH_MS, shareAllowed } from './limits.js';
import { decodeSpecHash, encodeSpecHash } from './share.js';

export class RequestGate {
  current = 0;

  issue(): number {
    this.current += 1;
    return this.current;
  }

  isCurrent(id: number): boolean {
    return id === this.current;
  }
}

export type HistoryReason = 'boot' | 'edit' | 'example' | 'navigation';

export function historyMode(opts: {
  lastPushAt: number;
  now: number;
  hashChanged: boolean;
  reason: HistoryReason;
}): 'push' | 'replace' | 'skip' {
  if (!opts.hashChanged) return 'skip';
  if (opts.reason === 'boot' || opts.reason === 'navigation') return 'replace';
  if (opts.reason === 'example') return 'push';
  if (opts.now - opts.lastPushAt >= HISTORY_PUSH_MS) return 'push';
  return 'replace';
}

export type ApplyHash =
  | { action: 'ignore' }
  | { action: 'reject'; message: string }
  | { action: 'load'; source: string };

export function applyHash(hash: string, currentSource: string): ApplyHash {
  const trimmed = hash.trim();
  if (trimmed === '' || trimmed === '#') return { action: 'ignore' };
  const decoded = decodeSpecHash(trimmed);
  if (!decoded.ok) return { action: 'reject', message: decoded.message };
  if (decoded.source === currentSource) return { action: 'ignore' };
  return { action: 'load', source: decoded.source };
}

/** Ask only when the editor holds text that is not the spec already loaded. */
export function shouldConfirmDiscard(editor: string, loaded: string): boolean {
  return editor.trim() !== '' && editor !== loaded;
}

export function hashForSource(source: string): { hash: string; reason?: string } {
  if (!shareAllowed(source)) {
    return {
      hash: '',
      reason: 'This spec is too large to put in a share link. It stays in this tab. A refresh keeps it; a copied URL will not.',
    };
  }
  return { hash: '#' + encodeSpecHash(source) };
}

/** 1-based line and column for a caret offset. Column counts UTF-16 code units, same as a textarea. */
export function cursorLineCol(source: string, offset: number): { line: number; column: number } {
  const pos = Math.max(0, Math.min(Number.isFinite(offset) ? Math.floor(offset) : 0, source.length));
  let line = 1;
  let lastNl = -1;
  for (let i = 0; i < pos; i++) {
    if (source.charCodeAt(i) === 10) {
      line++;
      lastNl = i;
    }
  }
  return { line, column: pos - lastNl };
}

/** Character range of a 1-based line, or null when the line is outside the spec. */
export function lineRange(source: string, line: number): { start: number; end: number } | null {
  if (!Number.isInteger(line) || line < 1) return null;
  const parts = source.split('\n');
  if (line > parts.length) return null;
  let start = 0;
  for (let i = 0; i < line - 1; i++) start += parts[i].length + 1;
  return { start, end: start + parts[line - 1].length };
}

const RANK = [
  'agent/AGENTS.md',
  'agent/hook.mjs',
  'agent/tools.json',
  'agent/agent-config.json',
  'agent/signal.mjs',
  'agent/README.md',
];

function inAgentDir(norm: string): boolean {
  return norm === 'agent' || norm.startsWith('agent/') || norm.includes('/agent/');
}

function rankPath(p: string): number {
  const norm = p.replace(/\\/g, '/');
  const known = RANK.indexOf(norm);
  if (known >= 0) return known;
  if (norm.endsWith('/AGENTS.md') || norm === 'AGENTS.md' || norm.endsWith('AGENTS.md')) return 0;
  if (norm.endsWith('.smt2') && !norm.endsWith('.ir.smt2')) return 20;
  if (norm.endsWith('.ir.smt2')) return 21;
  if (norm.endsWith('hook.mjs')) return 2;
  if (norm.endsWith('.ts') && !inAgentDir(norm)) return 30;
  return 100;
}

export function orderOutputPaths(paths: string[]): string[] {
  return [...paths].sort((a, b) => rankPath(a) - rankPath(b) || a.localeCompare(b));
}

export function preferredOutput(paths: string[]): string | null {
  const ordered = orderOutputPaths(paths);
  return ordered[0] ?? null;
}

/**
 * Files to show for a playground target. The compiler still emits TypeScript
 * beside OpenAPI, Protobuf, Kubernetes, Elm, Go, and Camel. The page lists
 * the files for the target the user picked.
 */
export function filesForTarget(paths: string[], target: string): string[] {
  const pred = targetFile(target);
  if (!pred) return orderOutputPaths(paths);
  const filtered = paths.filter((p) => pred(p.replace(/\\/g, '/')));
  return orderOutputPaths(filtered.length > 0 ? filtered : paths);
}

function targetFile(target: string): ((norm: string) => boolean) | null {
  switch (target) {
    case 'all':
    case 'all-ir':
    case '':
      return null;
    case 'typescript':
      return (p) => p.endsWith('.ts') && !inAgentDir(p);
    case 'z3':
      return (p) => p.endsWith('.smt2');
    case 'rust':
      return (p) => p.endsWith('.rs') || p.endsWith('Cargo.toml');
    case 'go':
      return (p) => p.endsWith('.go');
    case 'protobuf':
      return (p) => p.endsWith('.proto');
    case 'k8s':
      return (p) => p.startsWith('k8s/') || p.includes('/k8s/');
    case 'openapi':
      return (p) => p.startsWith('openapi/') || p.includes('/openapi/') || p.endsWith('.openapi.json');
    case 'camel':
      return (p) => p.endsWith('.java');
    case 'elm':
      return (p) => p.endsWith('.elm');
    case 'agent':
      return (p) => inAgentDir(p) || p.endsWith('AGENTS.md') || p.endsWith('hook.mjs') || p.endsWith('tools.json');
    default:
      return null;
  }
}
