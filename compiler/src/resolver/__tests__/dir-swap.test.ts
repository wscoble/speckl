// A subdirectory swapped for a symlink after readdir must not be followed.
import { it, expect, vi } from 'vitest';
import * as realFs from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';

const state: { armed?: { dir: string; outside: string } } = {};

vi.mock('node:fs', async (orig) => {
  const actual = await orig<typeof import('node:fs')>();
  return {
    ...actual,
    readdirSync: ((dir: string, options: unknown) => {
      const entries = (actual.readdirSync as (dir: string, options: unknown) => unknown)(dir, options);
      if (state.armed && dir === state.armed.dir) {
        actual.rmSync(path.join(dir, 'sub'), { recursive: true });
        actual.symlinkSync(state.armed.outside, path.join(dir, 'sub'));
        state.armed = undefined;
      }
      return entries;
    }) as typeof actual.readdirSync,
  };
});

const { filesystemBackend } = await import('../index.js');

it('does not follow a subdirectory swapped for a symlink after the listing', () => {
  const dir = realFs.mkdtempSync(path.join(realFs.realpathSync(tmpdir()), 'dswap-'));
  const root = path.join(dir, 'root');
  const outside = path.join(dir, 'outside');
  realFs.mkdirSync(path.join(root, 'sub'), { recursive: true });
  realFs.mkdirSync(outside);
  realFs.writeFileSync(path.join(root, 'sub/r.md'), '---\nid: inside\nmeasurement_class: c\n---\n');
  realFs.writeFileSync(path.join(outside, 'r.md'), '---\nid: outside-secret\nmeasurement_class: c\n---\n');
  state.armed = { dir: root, outside };
  let loaded: string[] = [];
  try {
    const backend = filesystemBackend(root);
    loaded = ['inside', 'outside-secret'].filter((id) => backend.exists(id));
  } catch (err) {
    loaded = [`threw:${(err as Error).message.slice(0, 80)}`];
  }
  expect(loaded).not.toContain('outside-secret');
});
