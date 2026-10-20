// Validation test: every example's generated OpenAPI 3.1 document passes
// @apidevtools/swagger-parser (schema and $ref validation). The validator is
// a dev dependency, so this target never skips. See helpers/toolchains.ts.
import { createRequire } from 'node:module';
import { join } from 'node:path';
import SwaggerParser from '@apidevtools/swagger-parser';
import { filesUnder, generate, targetSuite } from './helpers/toolchains.js';

const require = createRequire(import.meta.url);
const version = require('@apidevtools/swagger-parser/package.json').version;

targetSuite({
  target: 'openapi',
  name: 'swagger-parser: generated OpenAPI documents',
  toolchain: { ok: true, version: `swagger-parser ${version}` },
  check: async (example) => {
    const docs = filesUnder(join(generate(example, 'openapi'), 'openapi'), '.json');
    if (docs.length === 0) return { ok: false, output: 'no OpenAPI output' };
    for (const doc of docs) {
      try {
        await SwaggerParser.validate(doc);
      } catch (e) {
        return { ok: false, output: `${doc}: ${(e as Error).message}` };
      }
    }
    return { ok: true, output: '' };
  },
});
