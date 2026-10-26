// Fill gaps in the global `process` the compiler calls (`cwd`, `execPath`)
// without replacing Node's process when this bundle is loaded under Node.
// `buffer` is the browser polyfill; memfs and a few emitters read it as a global.
import { Buffer } from 'buffer';

const g = globalThis as {
  Buffer?: typeof Buffer;
  global?: typeof globalThis;
  process?: { cwd?: () => string; execPath?: string; env?: Record<string, string | undefined>; argv?: string[]; pid?: number; exit?: (code?: number) => void };
};

if (!g.Buffer) g.Buffer = Buffer;
if (!g.global) g.global = globalThis;

if (!g.process) g.process = {};
const proc = g.process;
if (typeof proc.cwd !== 'function') proc.cwd = () => '/';
if (!proc.execPath) proc.execPath = 'node';
if (!proc.env) proc.env = {};
if (!proc.argv) proc.argv = [];
if (proc.pid == null) proc.pid = 1;
if (typeof proc.exit !== 'function') proc.exit = () => {};
