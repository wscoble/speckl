// Compile test: every example's generated .proto file compiles with protoc.
// See helpers/toolchains.ts.
import { dirname, join } from 'node:path';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { filesUnder, generate, probe, run, targetSuite } from './helpers/toolchains.js';

targetSuite({
  target: 'protobuf',
  name: 'protoc: generated .proto files',
  toolchain: probe('protoc', ['--version']),
  check: (example) => {
    const protos = filesUnder(generate(example, 'protobuf'), '.proto');
    if (protos.length === 0) return { ok: false, output: 'no .proto output' };
    const set = join(mkdtempSync(join(tmpdir(), 'speckl-protoc-')), 'out.pb');
    return run('protoc', [`-I${dirname(protos[0])}`, `--descriptor_set_out=${set}`, ...protos]);
  },
});
