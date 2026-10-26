// `speckl doctor`: fail closed on import and domain errors, and on a domain
// member whose `act` tool is not mapped in every harness block.
//
// This is a spec check. It is not the generated adapter's `doctor` probe
// (that one runs an installed hook). consumes/produces errors are domain
// diagnostics from the lower pass, so they fail here too. A tick scheduler,
// queues, and runtime routing are not checked; they are not implemented.

import fs from 'fs';
import path from 'path';
import { parseSpeckFile } from './parser.js';
import { lower } from './ir/lower.js';
import type { IR, IRAgentConfig } from './ir/types.js';

export interface DoctorResult {
  ok: boolean;
  errors: string[];
}

export function doctorFile(filePath: string): DoctorResult {
  let ast;
  try {
    ast = parseSpeckFile(filePath);
  } catch (e) {
    return { ok: false, errors: [`doctor: ${filePath}: ${(e as Error).message}`] };
  }
  const ir = lower(ast, { filePath, resolveImports: true, rootDir: path.dirname(path.resolve(filePath)) });
  const errors = [
    ...ir.diagnostics.filter(d => d.level === 'error').map(d => d.message),
    ...unmappedActTools(ir),
  ];
  return { ok: errors.length === 0, errors };
}

/**
 * Every `effect act` tool on a domain member must be the target of a `map`
 * rule in every harness block that member declares. No harness block means
 * the tool is not mapped. Observe tools are not checked. Specks that are
 * not domain members are not checked.
 */
export function unmappedActTools(ir: IR): string[] {
  const errors: string[] = [];
  const byName = new Map(ir.specks.map(s => [s.name, s]));
  for (const domain of ir.domains) {
    const seen = new Set<string>();
    for (const member of domain.members) {
      if (seen.has(member)) continue;
      seen.add(member);
      const speck = byName.get(member);
      const agent: IRAgentConfig | undefined = speck?.facets.behavior.agent;
      if (!agent) continue;
      const harnesses = agent.harnesses ?? [];
      for (const tool of agent.tools) {
        if (tool.effect !== 'act') continue;
        if (harnesses.length === 0) {
          errors.push(`doctor: domain ${domain.name} member ${member} act tool ${tool.name} is not mapped in a harness block`);
          continue;
        }
        for (const harness of harnesses) {
          if (!harness.rules.some(r => r.target === tool.name)) {
            errors.push(`doctor: domain ${domain.name} member ${member} act tool ${tool.name} is not mapped in harness ${harness.name}`);
          }
        }
      }
    }
  }
  return errors;
}

export function runDoctor(argv: string[]): number {
  if (argv.includes('--help') || argv.includes('-h')) {
    console.log(doctorUsage());
    return 0;
  }
  if (argv.length === 0) {
    console.log(doctorUsage());
    return 1;
  }
  const file = argv[0];
  if (!fs.existsSync(file) || !fs.statSync(file).isFile()) {
    console.error(`doctor: cannot read ${file}`);
    return 1;
  }
  const result = doctorFile(file);
  if (!result.ok) {
    for (const e of result.errors) console.error(e);
    return 1;
  }
  console.log(`doctor: ${file} ok`);
  return 0;
}

function doctorUsage(): string {
  return [
    'usage: speckl doctor <file.speckdl>',
    '',
    'Resolve imports and domains, then fail if a domain member declares an',
    'act tool that is not mapped in every harness block.',
    'A missing import, a cycle, a duplicate member, a member of two',
    'domains, or a consumes/produces contract that cannot be wired fails',
    'here as well.',
  ].join('\n');
}
