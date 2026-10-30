// A record swapped for a symlink after readdir must not be followed.
import { it, expect, vi } from 'vitest';
import * as realFs from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';

const state: { armed?: { file: string; target: string } } = {};

vi.mock('node:fs', async (orig) => {
  const actual = await orig<typeof import('node:fs')>();
  return {
    ...actual,
    readdirSync: ((dir: string, options: unknown) => {
      const entries = (actual.readdirSync as (dir: string, options: unknown) => unknown)(dir, options);
      if (state.armed) {
        actual.rmSync(state.armed.file);
        actual.symlinkSync(state.armed.target, state.armed.file);
        state.armed = undefined;
      }
      return entries;
    }) as typeof actual.readdirSync,
  };
});

const { filesystemBackend } = await import('../index.js');

it('does not follow a record swapped for a symlink after the directory listing', () => {
  const dir = realFs.mkdtempSync(path.join(realFs.realpathSync(tmpdir()), 'toc-'));
  realFs.mkdirSync(path.join(dir, 'root'));
  realFs.mkdirSync(path.join(dir, 'outside'));
  realFs.writeFileSync(path.join(dir, 'root/r.md'), '---\nid: inside\nmeasurement_class: c\n---\n');
  realFs.writeFileSync(
    path.join(dir, 'outside/secret.md'),
    '---\nid: outside-secret\nmeasurement_class: c\nsecret: s3cr3t\n---\n',
  );
  state.armed = { file: path.join(dir, 'root/r.md'), target: path.join(dir, 'outside/secret.md') };
  let loaded: string[] = [];
  try {
    const backend = filesystemBackend(path.join(dir, 'root'));
    loaded = ['inside', 'outside-secret'].filter((id) => backend.exists(id));
  } catch (err) {
    loaded = [`threw:${(err as Error).message.slice(0, 80)}`];
  }
  expect(loaded).not.toContain('outside-secret');
});
