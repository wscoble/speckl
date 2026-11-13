// speckl doctor: a domain member's `effect act` tool must be a `map` target
// in every harness block on that speck. Observe tools are not checked.
// A speck that is not a domain member is not checked. A domain error from
// lower is reported as-is. A file that cannot be read or parsed fails closed.

import { existsSync, statSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { expandImports } from './imports.js';
import { lower } from './ir/lower.js';
import { parseSpeckFile, type AgentMemberNode, type AST } from './parser.js';

export interface DoctorResult {
  ok: boolean;
  errors: string[];
}

export function doctorFile(filePath: string): DoctorResult {
  const abs = resolve(filePath);
  if (!existsSync(abs) || !statSync(abs).isFile()) {
    return { ok: false, errors: [`doctor: cannot read ${filePath}`] };
  }
  let ast: AST;
  try {
    ast = expandImports(parseSpeckFile(abs), abs, { rootDir: dirname(abs) });
  } catch (err) {
    return { ok: false, errors: [`doctor: ${filePath}: ${(err as Error).message}`] };
  }
  const ir = lower(ast, { filePath: abs, resolveImports: true, rootDir: dirname(abs) });
  const errors = ir.diagnostics
    .filter(d => d.level === 'error' && d.message.startsWith('domain:'))
    .map(d => d.message);
  errors.push(...unmappedActTools(ast, ir.domains ?? []));
  return { ok: errors.length === 0, errors };
}

function unmappedActTools(ast: AST, domains: { name: string; members: string[] }[]): string[] {
  const errors: string[] = [];
  for (const domain of domains) {
    for (const member of domain.members) {
      const speck = ast.specks.find(s => s.name === member);
      if (!speck) continue;
      const agent = speck.members.find((m): m is AgentMemberNode => m.type === 'agent');
      if (!agent) continue;
      for (const tool of agent.tools) {
        if (tool.effect !== 'act') continue;
        if (!agent.harnesses || agent.harnesses.length === 0) {
          errors.push(`doctor: domain ${domain.name} member ${member} act tool ${tool.name} is not mapped in a harness block`);
          continue;
        }
        for (const harness of agent.harnesses) {
          const mapped = harness.rules.some(rule => rule.target === tool.name);
          if (!mapped) {
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
  const files = argv.filter(a => !a.startsWith('-'));
  if (files.length === 0) {
    console.error(doctorUsage());
    return 1;
  }
  let failed = false;
  for (const file of files) {
    const result = doctorFile(file);
    if (result.ok) {
      console.log(`doctor: ${file} ok`);
      continue;
    }
    failed = true;
    for (const error of result.errors) console.error(error);
  }
  return failed ? 1 : 0;
}

function doctorUsage(): string {
  return 'Usage: speckl doctor [files..]';
}
