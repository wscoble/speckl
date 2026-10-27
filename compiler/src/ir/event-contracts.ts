// Compile-time consumes/produces checks.
//
// A domain names events that already exist as `event` declarations. The
// check is a flat lookup, not a walk of the produces/consumes graph, so a
// cycle between domains terminates. Routing, queues, and a tick scheduler
// are not implemented here: this only rejects a contract that cannot be
// wired.

import type { IRDiagnostic, IRDomain, IREvent, IRSpeck, IRStmt } from './types.js';

interface EventDecl {
  external: boolean;
  /** Field shape, so two declarations of one name can be compared. */
  shape: string;
  specks: string[];
  /** `kpi` tag. Null when the declaration has none. */
  kpi: string | null;
}

function typeKey(t: { kind: string; primitive?: string; name?: string; elementType?: unknown; keyType?: unknown; valueType?: unknown; nullable?: boolean }): string {
  const n = t.nullable ? '?' : '';
  if (t.kind === 'primitive') return `p:${t.primitive ?? ''}${n}`;
  if (t.kind === 'ident') return `i:${t.name ?? ''}${n}`;
  if (t.kind === 'list' || t.kind === 'set') return `${t.kind}(${typeKey((t.elementType ?? { kind: 'unknown' }) as never)})${n}`;
  if (t.kind === 'map') return `map(${typeKey((t.keyType ?? { kind: 'unknown' }) as never)},${typeKey((t.valueType ?? { kind: 'unknown' }) as never)})${n}`;
  return `${t.kind}${n}`;
}

function shapeOf(ev: IREvent): string {
  return ev.fields.map(f => `${f.name}:${typeKey(f.type)}`).join(',');
}

function push(diagnostics: IRDiagnostic[], message: string): void {
  diagnostics.push({ level: 'error', message });
}

/** Events an action emits, including an `emit` hidden in an unlowered block. */
function emittedBy(statements: IRStmt[]): string[] {
  const names: string[] = [];
  for (const s of statements) {
    if (s.kind === 'emit' && s.event) names.push(s.event);
    if (s.raw) {
      for (const m of s.raw.matchAll(/\bemit\s+([A-Za-z_]\w*)/g)) names.push(m[1]);
    }
  }
  return names;
}

/**
 * Fail closed on a contract that cannot be wired:
 * - every consumed event is produced by some domain, or declared `external`;
 * - a domain does not produce an event that is declared `external`;
 * - no member emits an event its domain does not list in `produces`.
 */
export function checkEventContracts(specks: IRSpeck[], domains: IRDomain[], diagnostics: IRDiagnostic[]): void {
  const events = new Map<string, EventDecl>();
  for (const speck of specks) {
    for (const ev of speck.facets.behavior.events) {
      const shape = shapeOf(ev);
      const external = ev.external === true;
      const kpi = ev.kpi ?? null;
      const prev = events.get(ev.name);
      if (!prev) {
        events.set(ev.name, { external, shape, specks: [speck.name], kpi });
        continue;
      }
      prev.specks.push(speck.name);
      if (prev.external !== external) {
        push(diagnostics, `domain: event ${ev.name} is declared external and also as an internal event`);
      }
      if (prev.shape !== shape) {
        push(diagnostics, `domain: event ${ev.name} is declared with different fields`);
      }
      if (prev.kpi !== kpi) {
        push(diagnostics, `domain: event ${ev.name} kpi differs across declarations`);
      }
    }
  }

  const producers = new Map<string, string[]>();
  for (const domain of domains) {
    for (const name of domain.produces) {
      const decl = events.get(name);
      if (!decl) {
        push(diagnostics, `domain: ${domain.name} produces ${name}, which is not an event`);
        continue;
      }
      if (decl.external) {
        push(diagnostics, `domain: ${domain.name} produces ${name}, which is declared external`);
      }
      const list = producers.get(name) ?? [];
      list.push(domain.name);
      producers.set(name, list);
    }
    for (const name of domain.consumes) {
      if (!events.has(name)) {
        push(diagnostics, `domain: ${domain.name} consumes ${name}, which is not an event`);
      }
    }
  }

  for (const domain of domains) {
    for (const name of domain.consumes) {
      const decl = events.get(name);
      if (!decl) continue;
      const produced = (producers.get(name) ?? []).length > 0;
      if (!produced && !decl.external) {
        push(diagnostics, `domain: ${domain.name} consumes ${name}, which no domain produces and which is not external`);
      }
    }
  }

  const byName = new Map(specks.map(s => [s.name, s]));
  for (const domain of domains) {
    const produced = new Set(domain.produces);
    const seen = new Set<string>();
    for (const member of domain.members) {
      if (seen.has(member)) continue;
      seen.add(member);
      const speck = byName.get(member);
      if (!speck) continue;
      for (const action of speck.facets.behavior.actions) {
        for (const name of emittedBy(action.statements)) {
          if (!produced.has(name)) {
            push(diagnostics, `domain: ${domain.name} member ${member} action ${action.name} emits ${name}, which ${domain.name} does not produce`);
          }
        }
      }
    }
  }
}
