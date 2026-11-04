#!/usr/bin/env node
// measure-mcp-tools.mjs — MCP tool-definition size/token baseline for the
// speckl agent target (`-t agent`), the gate/harness tool surface.
//
// What it measures, per generated MCP tool definition (entries of the
// generated `agent/tools.json` manifest: name + description + inputSchema,
// plus the `x-speckl` gate metadata the compiler adds alongside):
//
//   description chars   JS string length (UTF-16 code units; all content here
//                       is ASCII, so this equals UTF-8 bytes)
//   description tokens  tiktoken cl100k_base and o200k_base
//   inputSchema chars   JSON.stringify(inputSchema) — compact JSON, no spaces
//   inputSchema tokens  both encoders, over the compact JSON
//   MCP entry           JSON.stringify({ name, description, inputSchema }) —
//                       compact JSON, as an MCP tools/list entry on the wire;
//                       measured with both encoders
//   entry incl x-speckl same, with the full on-disk entry object
//
// It also reports per-spec AGENTS.md sizes (the readable-rails surface) and
// the pretty-printed on-disk tools.json size, as supplementary totals.
//
// Usage (from compiler/):
//   npm run build                 # the script shells out to dist/index.js
//   npm i js-tiktoken             # tokenizer only; not a compiler dependency
//   node scripts/measure-mcp-tools.mjs            # markdown report
//   node scripts/measure-mcp-tools.mjs --json     # machine-readable report
//
// By default it compiles every examples/*.speckdl that yields an agent block;
// pass spec paths as positional args to measure a subset.

import { execFileSync } from 'node:child_process';
import { readFileSync, readdirSync, mkdirSync, rmSync, existsSync } from 'node:fs';
import { join, dirname, basename, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptDir = dirname(fileURLToPath(import.meta.url));
const compilerDir = dirname(scriptDir);            // compiler/
const repoRoot = dirname(compilerDir);             // repo root
const tmpOut = join(compilerDir, '.measure-mcp-tmp');

let tiktoken;
try {
  tiktoken = await import('js-tiktoken');
} catch {
  console.error('js-tiktoken is required: npm i js-tiktoken   (run inside compiler/)');
  process.exit(1);
}
const encoders = {
  o200k_base: tiktoken.getEncoding('o200k_base'),
  cl100k_base: tiktoken.getEncoding('cl100k_base'),
};
const tokensOf = (text, enc) => encoders[enc].encode(text).length;
const charsOf = (text) => [...text].length;        // Unicode code points

function gitSha() {
  try {
    return execFileSync('git', ['-C', repoRoot, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
  } catch {
    return '(not a git checkout)';
  }
}

function discoverSpecs(args) {
  if (args.length > 0) return args.map((p) => (p.startsWith('/') ? p : join(repoRoot, p)));
  const examplesDir = join(repoRoot, 'examples');
  return existsSync(examplesDir)
    ? readdirSync(examplesDir).filter((f) => f.endsWith('.speckdl')).map((f) => join(examplesDir, f))
    : [];
}

function compileSpec(specPath, outDir) {
  execFileSync('node', [join(compilerDir, 'dist', 'index.js'), specPath, '-o', outDir, '-t', 'agent'], {
    cwd: compilerDir,
    stdio: ['ignore', 'ignore', 'pipe'],
  });
}

function measureEntry(tool) {
  const entry = { name: tool.name, description: tool.description, inputSchema: tool.inputSchema };
  const entryJson = JSON.stringify(entry);
  const fullJson = JSON.stringify(tool);
  const schemaJson = JSON.stringify(tool.inputSchema ?? {});
  const row = {
    name: tool.name,
    descriptionChars: charsOf(tool.description ?? ''),
    inputSchemaChars: charsOf(schemaJson),
    entryChars: charsOf(entryJson),
    entryWithXSpecklChars: charsOf(fullJson),
    tokens: {},
    tokensWithXSpeckl: {},
  };
  for (const enc of Object.keys(encoders)) {
    row.tokens[enc] = {
      name: tokensOf(tool.name ?? '', enc),
      description: tokensOf(tool.description ?? '', enc),
      inputSchema: tokensOf(schemaJson, enc),
      entry: tokensOf(entryJson, enc),
    };
    row.tokensWithXSpeckl[enc] = tokensOf(fullJson, enc);
  }
  return row;
}

const jsonOut = process.argv.includes('--json');
const specArgs = process.argv.slice(2).filter((a) => !a.startsWith('--'));

const specs = discoverSpecs(specArgs);
if (specs.length === 0) {
  console.error('no .speckdl specs found to measure');
  process.exit(1);
}

rmSync(tmpOut, { recursive: true, force: true });
const perSpec = [];
const allRows = [];

for (const specPath of specs) {
  const specName = basename(specPath, '.speckdl');
  const outDir = join(tmpOut, specName);
  try {
    compileSpec(specPath, outDir);
  } catch (err) {
    perSpec.push({ spec: specName, error: String(err.stderr ?? err).split('\n')[0] });
    continue;
  }
  const toolsJsonPath = join(outDir, 'agent', 'tools.json');
  if (!existsSync(toolsJsonPath)) continue;        // spec declares no agent block
  const manifest = JSON.parse(readFileSync(toolsJsonPath, 'utf8'));
  const rows = (manifest.tools ?? []).map(measureEntry);
  const agentsMdPath = join(outDir, 'agent', 'AGENTS.md');
  const agentsMd = existsSync(agentsMdPath) ? readFileSync(agentsMdPath, 'utf8') : '';
  const toolsJsonRaw = readFileSync(toolsJsonPath, 'utf8');
  const specRow = {
    spec: relative(repoRoot, specPath),
    tools: rows,
    agentsMdChars: charsOf(agentsMd),
    agentsMdTokens: { o200k_base: tokensOf(agentsMd, 'o200k_base'), cl100k_base: tokensOf(agentsMd, 'cl100k_base') },
    toolsJsonFileChars: charsOf(toolsJsonRaw),
    toolsJsonFileTokens: { o200k_base: tokensOf(toolsJsonRaw, 'o200k_base'), cl100k_base: tokensOf(toolsJsonRaw, 'cl100k_base') },
  };
  perSpec.push(specRow);
  for (const r of rows) allRows.push({ ...r, spec: specName });
}

const sum = (xs) => xs.reduce((a, b) => a + b, 0);
const totals = { tools: allRows.length };
for (const enc of Object.keys(encoders)) {
  totals[enc] = {
    name: sum(allRows.map((r) => r.tokens[enc].name)),
    description: sum(allRows.map((r) => r.tokens[enc].description)),
    inputSchema: sum(allRows.map((r) => r.tokens[enc].inputSchema)),
    mcpEntry: sum(allRows.map((r) => r.tokens[enc].entry)),
    mcpEntryWithXSpeckl: sum(allRows.map((r) => r.tokensWithXSpeckl[enc])),
  };
  totals[`${enc}Chars`] = {
    description: sum(allRows.map((r) => r.descriptionChars)),
    inputSchema: sum(allRows.map((r) => r.inputSchemaChars)),
    mcpEntry: sum(allRows.map((r) => r.entryChars)),
    mcpEntryWithXSpeckl: sum(allRows.map((r) => r.entryWithXSpecklChars)),
  };
}
const top5 = [...allRows]
  .sort((a, b) => b.tokens.o200k_base.entry - a.tokens.o200k_base.entry)
  .slice(0, 5)
  .map((r) => ({ spec: r.spec, name: r.name, entryTokens: r.tokens.o200k_base.entry, entryChars: r.entryChars }));

const report = { measuredAt: new Date().toISOString(), commit: gitSha(), tokenizer: 'tiktoken via js-tiktoken (o200k_base + cl100k_base)', serialization: 'compact JSON (JSON.stringify, no spaces); chars = Unicode code points', specs: perSpec, totals, top5 };

if (jsonOut) {
  console.log(JSON.stringify(report, null, 2));
} else {
  const md = [];
  md.push(`# MCP tool-definition baseline — speckl agent target`);
  md.push('');
  md.push(`- Commit measured: \`${report.commit}\``);
  md.push(`- Tokenizer: tiktoken via js-tiktoken — o200k_base and cl100k_base`);
  md.push(`- Serialization: compact JSON (as an MCP tools/list entry); chars = Unicode code points (ASCII here, equals bytes)`);
  md.push('');
  md.push('| Spec | Tool | Desc chars | Desc tok (o200k) | Schema chars | Schema tok (o200k) | MCP entry tok (o200k) | MCP entry tok (cl100k) | +x-speckl tok (o200k) |');
  md.push('| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |');
  for (const s of perSpec) {
    if (s.error) { md.push(`| ${s.spec} | _compile failed: ${s.error}_ | | | | | | | |`); continue; }
    for (const t of s.tools) {
      md.push(`| ${s.spec} | \`${t.name}\` | ${t.descriptionChars} | ${t.tokens.o200k_base.description} | ${t.inputSchemaChars} | ${t.tokens.o200k_base.inputSchema} | ${t.tokens.o200k_base.entry} | ${t.tokens.cl100k_base.entry} | ${t.tokensWithXSpeckl.o200k_base} |`);
    }
  }
  md.push(`| **TOTAL (${totals.tools} tools)** | | **${totals.o200k_baseChars.description}** | **${totals.o200k_base.description}** | **${totals.o200k_baseChars.inputSchema}** | **${totals.o200k_base.inputSchema}** | **${totals.o200k_base.mcpEntry}** | **${totals.cl100k_base.mcpEntry}** | **${totals.o200k_base.mcpEntryWithXSpeckl}** |`);
  md.push('');
  md.push('## Top 5 largest tool definitions (by o200k_base MCP-entry tokens)');
  md.push('');
  for (const [i, t] of top5.entries()) md.push(`${i + 1}. \`${t.spec}\` / \`${t.name}\` — ${t.entryTokens} tok (${t.entryChars} chars)`);
  md.push('');
  md.push('## Supplementary: readable-rails and on-disk manifest sizes');
  md.push('');
  md.push('| Spec | AGENTS.md chars | AGENTS.md tok (o200k) | tools.json (pretty) chars | tools.json (pretty) tok (o200k) |');
  md.push('| --- | ---: | ---: | ---: | ---: |');
  for (const s of perSpec) {
    if (s.error) continue;
    md.push(`| ${s.spec} | ${s.agentsMdChars} | ${s.agentsMdTokens.o200k_base} | ${s.toolsJsonFileChars} | ${s.toolsJsonFileTokens.o200k_base} |`);
  }
  md.push('');
  console.log(md.join('\n'));
}
