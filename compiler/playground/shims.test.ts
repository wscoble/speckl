import { createHash as nodeHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { spawnSync, syntaxCheck } from './shims/child_process.js';
import { createHash } from './shims/crypto.js';
import memfs from './shims/fs.js';

describe('browser shims', () => {
  it('matches Node sha256 and parses generated-module syntax', () => {
    const hex = createHash('sha256').update('Deploy').update('Gate').digest('hex');
    expect(hex).toBe(nodeHash('sha256').update('DeployGate').digest('hex'));
    expect(() => createHash('md5')).toThrow(/sha256/);
    expect(syntaxCheck('#!/usr/bin/env node\nexport const a = 1;\n').ok).toBe(true);
    expect(syntaxCheck('export const a =\n').ok).toBe(false);
    const dir = memfs.mkdtempSync('/tmp/speckl-syntax-');
    memfs.writeFileSync(dir + '/ok.mjs', 'export const a = 1;\n');
    memfs.writeFileSync(dir + '/bad.mjs', 'export const =\n');
    expect(spawnSync('node', ['--check', dir + '/ok.mjs']).status).toBe(0);
    expect(spawnSync('node', ['--check', dir + '/bad.mjs']).status).toBe(1);
    expect(spawnSync('node', ['--check', dir + '/missing.mjs']).status).toBe(1);
    expect(spawnSync('node', ['--version']).status).toBe(0);
  });
});
