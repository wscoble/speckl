#!/usr/bin/env node
// Download the pinned third-party files that the compile tests need to
// check generated code, into a local cache. Run once (needs network);
// the tests themselves never touch the network.
//
//   node scripts/fetch-compile-deps.mjs        # fetch what is missing
//   node scripts/fetch-compile-deps.mjs --check # exit 1 if anything is missing
//
// Cache: $SPECKL_COMPILE_DEPS_DIR, default compiler/.cache/compile-deps.
// Every file is checked against its pinned SHA-256.
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
export const DEPS_DIR = process.env.SPECKL_COMPILE_DEPS_DIR || join(here, '..', '.cache', 'compile-deps');

const MAVEN = 'https://repo1.maven.org/maven2';

/**
 * Java: the generated Camel projects target Camel Quarkus 3.15 (Camel 4.8.0).
 * javac needs only the APIs the generated sources import.
 */
export const DEPS = [
  { group: 'java', file: 'camel-api-4.8.0.jar', url: `${MAVEN}/org/apache/camel/camel-api/4.8.0/camel-api-4.8.0.jar`, sha256: '375e159c62163d54fe783869f89eca708ca6063d7c43c68032f39714895b376d' },
  { group: 'java', file: 'camel-core-model-4.8.0.jar', url: `${MAVEN}/org/apache/camel/camel-core-model/4.8.0/camel-core-model-4.8.0.jar`, sha256: 'c53961a72479fcf547d6ee9c42cc38d47443e6ffe7bd4848702ef26b87c10302' },
  { group: 'java', file: 'jakarta.enterprise.cdi-api-4.1.0.jar', url: `${MAVEN}/jakarta/enterprise/jakarta.enterprise.cdi-api/4.1.0/jakarta.enterprise.cdi-api-4.1.0.jar`, sha256: 'c42c808f17925129a0800f618febe050d966e181a4c7384c8a5e7a0283d68699' },
  { group: 'java', file: 'jakarta.inject-api-2.0.1.jar', url: `${MAVEN}/jakarta/inject/jakarta.inject-api/2.0.1/jakarta.inject-api-2.0.1.jar`, sha256: 'f7dc98062fccf14126abb751b64fab12c312566e8cbdc8483598bffcea93af7c' },
];

const sha256 = (buf) => createHash('sha256').update(buf).digest('hex');

export function depPath(dep) {
  return join(DEPS_DIR, dep.group, dep.file);
}

/** Pinned deps that are absent or do not match their hash. */
export function missingDeps(group) {
  return DEPS.filter((d) => (!group || d.group === group))
    .filter((d) => !existsSync(depPath(d)) || sha256(readFileSync(depPath(d))) !== d.sha256);
}

async function fetchDep(dep) {
  const res = await fetch(dep.url);
  if (!res.ok) throw new Error(`${dep.url}: HTTP ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  const got = sha256(buf);
  if (got !== dep.sha256) throw new Error(`${dep.file}: SHA-256 ${got}, expected ${dep.sha256}`);
  const out = depPath(dep);
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out + '.tmp', buf);
  renameSync(out + '.tmp', out);
}

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (isMain) {
  const missing = missingDeps();
  if (process.argv.includes('--check')) {
    for (const d of missing) console.error(`missing: ${depPath(d)}`);
    process.exit(missing.length ? 1 : 0);
  }
  for (const d of missing) {
    process.stdout.write(`fetching ${d.file} ... `);
    await fetchDep(d);
    console.log('ok');
  }
  console.log(`compile deps ready in ${DEPS_DIR} (${DEPS.length} files)`);
}
