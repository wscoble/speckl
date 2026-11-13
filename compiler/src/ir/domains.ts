// File-level domain blocks. A domain lists speck names. It does not
// merge those specks. Each name must be a speck in the lowered unit,
// once per domain, and in only one domain. The same domain name in two
// files is an error. Same name in the same file is also an error.

import { realpathSync } from 'node:fs';
import { resolve } from 'node:path';
import type { DomainNode } from '../parser.js';
import type { IRDiagnostic, IRDomain } from './types.js';

export function localDomains(
  domains: DomainNode[] | undefined,
  speckNames: readonly string[],
  filePath: string,
  diagnostics: IRDiagnostic[],
): IRDomain[] {
  const known = new Set(speckNames);
  const out: IRDomain[] = [];
  const owner = new Map<string, string>();
  const declared = new Map<string, string>();

  for (const d of domains ?? []) {
    const sourcePath = d.sourceFile ?? filePath;
    const seen = new Set<string>();
    for (const member of d.members) {
      if (seen.has(member)) {
        diagnostics.push({
          level: 'error',
          message: `domain: ${d.name} lists ${member} more than once in ${sourcePath}`,
        });
      }
      seen.add(member);
      const other = owner.get(member);
      if (other !== undefined) {
        const [left, right] = [other, d.name].sort();
        diagnostics.push({
          level: 'error',
          message: `domain: speck ${member} is a member of ${left} and ${right}`,
        });
      } else {
        owner.set(member, d.name);
      }
      if (!known.has(member)) {
        diagnostics.push({
          level: 'error',
          message: `domain: ${d.name} member ${member} is not a speck in ${sourcePath}`,
        });
      }
    }
    const prev = declared.get(d.name);
    if (prev !== undefined) {
      diagnostics.push({
        level: 'error',
        message: canonical(prev) === canonical(sourcePath)
          ? `domain: ${d.name} is declared more than once in ${sourcePath}`
          : `domain: ${d.name} is declared in both ${prev} and ${sourcePath}`,
      });
    } else {
      declared.set(d.name, sourcePath);
    }
    out.push({
      name: d.name,
      members: [...d.members],
      ...(d.language !== undefined ? { language: d.language } : {}),
      sourcePath,
    });
  }
  return out;
}

function canonical(p: string): string {
  try {
    return realpathSync(p);
  } catch {
    return resolve(p);
  }
}
