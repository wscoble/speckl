// `domain Name { members: ...; language: ... }`.
// The body may span lines. `members` is required. `language` is optional.
// A `}` inside a `"` or `'` string does not end the block. The strict
// brace check still runs first, so a domain that never closes is
// `missing final "}"` before this scanner reports `unclosed domain`.

import { DomainNode, lexProblem } from './speck-part0.js';

export function parseDomain(lines: string[], startIndex: number): DomainNode {
  const header = lines[startIndex].trim();
  const hm = header.match(/^domain\s+([\w-]+)\s*\{(.*)$/);
  if (!hm) {
    throw lexProblem(startIndex + 1, `expected "domain <Name> {", got ${JSON.stringify(header)}`);
  }
  const name = hm[1];
  const extracted = extractDomainBody(hm[2] ?? '', lines, startIndex);
  const body = stripCommentsOutsideStrings(extracted.body);
  const stmts = splitOnSemicolons(body);
  let members: string[] | undefined;
  let language: string | undefined;
  const consumes: string[] = [];
  const produces: string[] = [];
  let budgetPerTick: number | undefined;
  let priority: string | undefined;
  const seenConsumes = new Set<string>();
  const seenProduces = new Set<string>();
  for (const raw of stmts) {
    const stmt = raw.trim();
    if (!stmt) continue;
    const mem = stmt.match(/^members\s*:\s*([\s\S]*)$/);
    if (mem) {
      if (members) {
        throw lexProblem(startIndex + 1, `domain ${name} declares members twice`);
      }
      const ids = mem[1].split(',').map(s => s.trim()).filter(Boolean);
      if (ids.length === 0) {
        throw lexProblem(startIndex + 1, `domain ${name} has no members`);
      }
      for (const id of ids) {
        if (!/^[\w-]+$/.test(id)) {
          throw lexProblem(startIndex + 1, `domain ${name} member ${JSON.stringify(id)} is not a speck name`);
        }
      }
      members = ids;
      continue;
    }
    const lang = stmt.match(/^language\s*:\s*([\s\S]*)$/);
    if (lang) {
      if (language !== undefined) {
        throw lexProblem(startIndex + 1, `domain ${name} declares language twice`);
      }
      language = parseLanguageValue(lang[1].trim(), name, startIndex);
      continue;
    }
    const flow = stmt.match(/^(consumes|produces)(?:\s+([\s\S]*))?$/);
    if (flow) {
      const kind = flow[1] as 'consumes' | 'produces';
      const seen = kind === 'consumes' ? seenConsumes : seenProduces;
      const into = kind === 'consumes' ? consumes : produces;
      const ids = (flow[2] ?? '').split(',').map(s => s.trim()).filter(Boolean);
      if (ids.length === 0) {
        throw lexProblem(startIndex + 1, `domain ${name} ${kind} has no event`);
      }
      for (const id of ids) {
        if (!/^[A-Za-z_]\w*$/.test(id)) {
          throw lexProblem(startIndex + 1, `domain ${name} ${kind} ${JSON.stringify(id)} is not an event name`);
        }
        if (seen.has(id)) {
          throw lexProblem(startIndex + 1, `domain ${name} ${kind} ${id} more than once`);
        }
        seen.add(id);
        into.push(id);
      }
      continue;
    }
    if (stmt.startsWith('budget')) {
      const bud = stmt.match(/^budget\s+(\d+)\s+per\s+tick$/);
      const n = bud ? Number(bud[1]) : NaN;
      if (!bud || !Number.isSafeInteger(n)) {
        throw lexProblem(startIndex + 1, `domain ${name} budget must be a non-negative integer per tick`);
      }
      if (budgetPerTick !== undefined) {
        throw lexProblem(startIndex + 1, `domain ${name} declares budget twice`);
      }
      budgetPerTick = n;
      continue;
    }
    if (stmt.startsWith('priority')) {
      const pri = stmt.match(/^priority\s+([A-Za-z_][A-Za-z0-9_]*)\s*$/);
      if (!pri) {
        throw lexProblem(startIndex + 1, `domain ${name} priority must be an identifier`);
      }
      if (priority !== undefined) {
        throw lexProblem(startIndex + 1, `domain ${name} declares priority twice`);
      }
      priority = pri[1];
      continue;
    }
    throw lexProblem(startIndex + 1, `domain ${name} has unexpected clause ${JSON.stringify(stmt)}`);
  }
  if (!members) {
    throw lexProblem(startIndex + 1, `domain ${name} must declare members`);
  }
  return {
    type: 'domain',
    name,
    members,
    ...(language !== undefined ? { language } : {}),
    ...(consumes.length > 0 ? { consumes } : {}),
    ...(produces.length > 0 ? { produces } : {}),
    ...(budgetPerTick !== undefined ? { budgetPerTick } : {}),
    ...(priority !== undefined ? { priority } : {}),
    startLine: startIndex + 1,
    endLine: extracted.endLine,
  };
}

function extractDomainBody(
  firstRemainder: string,
  lines: string[],
  startIndex: number,
): { body: string; endLine: number } {
  let body = '';
  let depth = 1;
  let inStr: '"' | "'" | null = null;
  const consume = (s: string): boolean => {
    for (let k = 0; k < s.length; k++) {
      const ch = s[k];
      if (inStr) {
        body += ch;
        if (ch === '\\' && k + 1 < s.length) {
          body += s[++k];
          continue;
        }
        if (ch === inStr) inStr = null;
        continue;
      }
      if (ch === '"' || ch === "'") {
        inStr = ch;
        body += ch;
        continue;
      }
      if (ch === '{') {
        depth++;
        body += ch;
        continue;
      }
      if (ch === '}') {
        depth--;
        if (depth === 0) return true;
        body += ch;
        continue;
      }
      body += ch;
    }
    return false;
  };
  if (consume(firstRemainder)) return { body, endLine: startIndex + 1 };
  let i = startIndex;
  while (depth > 0) {
    i++;
    if (i >= lines.length) {
      throw lexProblem(startIndex + 1, 'unclosed domain');
    }
    body += '\n';
    if (consume(lines[i])) return { body, endLine: i + 1 };
  }
  return { body, endLine: i + 1 };
}

function stripCommentsOutsideStrings(s: string): string {
  let out = '';
  let inStr: '"' | "'" | null = null;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (inStr) {
      out += ch;
      if (ch === '\\' && i + 1 < s.length) {
        out += s[++i];
        continue;
      }
      if (ch === inStr) inStr = null;
      continue;
    }
    if (ch === '"' || ch === "'") {
      inStr = ch;
      out += ch;
      continue;
    }
    if (ch === '/' && s[i + 1] === '/') {
      while (i < s.length && s[i] !== '\n') i++;
      out += '\n';
      continue;
    }
    out += ch;
  }
  return out;
}

function splitOnSemicolons(s: string): string[] {
  const out: string[] = [];
  let cur = '';
  let inStr: '"' | "'" | null = null;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (inStr) {
      cur += ch;
      if (ch === '\\' && i + 1 < s.length) {
        cur += s[++i];
        continue;
      }
      if (ch === inStr) inStr = null;
      continue;
    }
    if (ch === '"' || ch === "'") {
      inStr = ch;
      cur += ch;
      continue;
    }
    if (ch === ';') {
      out.push(cur);
      cur = '';
      continue;
    }
    cur += ch;
  }
  if (cur.trim()) out.push(cur);
  return out;
}

function parseLanguageValue(v: string, name: string, startIndex: number): string {
  if (!v) {
    throw lexProblem(startIndex + 1, `domain ${name} language is empty`);
  }
  if (v.startsWith('"')) {
    try {
      return JSON.parse(v) as string;
    } catch {
      throw lexProblem(startIndex + 1, `domain ${name} language string is invalid`);
    }
  }
  if (v.startsWith("'") && v.endsWith("'") && v.length >= 2) {
    return v.slice(1, -1);
  }
  return v;
}
