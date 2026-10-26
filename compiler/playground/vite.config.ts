import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig, type UserConfig } from 'vite';

const dir = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);

function shim(name: string): string {
  return path.join(dir, 'shims', name + '.ts');
}

function pkg(name: string): string {
  return require.resolve(name);
}

/** Node built-ins the compiler imports, pointed at browser shims. */
export function browserAliases(): { find: RegExp; replacement: string }[] {
  const pairs: [RegExp, string][] = [
    [/^node:fs$/, shim('fs')],
    [/^fs$/, shim('fs')],
    [/^node:path$/, shim('path')],
    [/^path$/, shim('path')],
    [/^node:os$/, shim('os')],
    [/^os$/, shim('os')],
    [/^node:crypto$/, shim('crypto')],
    [/^crypto$/, shim('crypto')],
    [/^node:child_process$/, shim('child_process')],
    [/^child_process$/, shim('child_process')],
    [/^node:url$/, shim('url')],
    [/^url$/, shim('url')],
    // memfs pulls these Node built-ins. Alias them to browser packages so
    // Vite does not replace them with empty browser-external stubs.
    [/^node:buffer$/, pkg('buffer')],
    [/^buffer$/, pkg('buffer')],
    [/^node:events$/, pkg('events')],
    [/^events$/, pkg('events')],
    [/^node:stream$/, pkg('stream-browserify')],
    [/^stream$/, pkg('stream-browserify')],
    [/^node:process$/, pkg('process/browser.js')],
    [/^process$/, pkg('process/browser.js')],
    [/^node:util$/, pkg('util')],
    [/^util$/, pkg('util')],
    [/^node:string_decoder$/, pkg('string_decoder')],
    [/^string_decoder$/, pkg('string_decoder')],
  ];
  return pairs.map(([find, replacement]) => ({ find, replacement }));
}

export function playgroundConfig(mode: 'app' | 'lib'): UserConfig {
  const aliases = browserAliases();
  const config: UserConfig = {
    root: dir,
    base: './',
    resolve: { alias: aliases },
    worker: { format: 'es' },
    build: {
      target: 'es2022',
      sourcemap: false,
      chunkSizeWarningLimit: 4000,
      emptyOutDir: true,
    },
  };
  if (mode === 'lib') {
    config.build = {
      ...config.build,
      lib: {
        entry: path.join(dir, 'src/bundle-entry.ts'),
        formats: ['es'],
        fileName: 'playground-compiler',
      },
      minify: false,
      rollupOptions: {
        external: [],
      },
    };
  } else {
    config.build = {
      ...config.build,
      outDir: 'dist',
    };
  }
  return config;
}

export default defineConfig(playgroundConfig('app'));
