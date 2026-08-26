import { describe, it, expect, beforeAll } from 'vitest';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { execSync } from 'child_process';
import { parseSpeckFile } from '../parser.js';
import { lower } from '../ir/lower.js';
import { generateProvenanceFromIR } from '../generators/provenance-from-ir.js';
import { generateCycloneDX } from '../generators/cyclonedx.js';
import { generateSPDX } from '../generators/spdx.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

describe('Compiler E2E', () => {
  let ast: any;
  let ir: any;
  const testOutputDir = './test-output';

  beforeAll(() => {
    // Create test output directory
    if (!fs.existsSync(testOutputDir)) {
      fs.mkdirSync(testOutputDir);
    }
  });

  it('should parse RetryHandler.speckdl', () => {
    const specPath = path.join(__dirname, '..', '..', '..', 'examples', 'RetryHandler.speckdl');
    ast = parseSpeckFile(specPath);

    expect(ast).toBeDefined();
    expect(ast.specks).toBeDefined();
    expect(ast.specks.length).toBeGreaterThan(0);

    const speck = ast.specks[0];
    expect(speck.name).toBe('RetryHandler');
    expect(speck.type).toBe('speck');
    expect(speck.members.length).toBeGreaterThan(0);

    // Lower to IR — the IR is the source of truth for the provenance generator
    ir = lower(ast, { filePath: specPath, resolveImports: false });
    expect(ir.specks[0].facets.provenance).toBeDefined();
  });

  it('should generate provenance graph from IR', () => {
    generateProvenanceFromIR(ir, testOutputDir);

    const provFile = path.join(testOutputDir, 'RetryHandler.prov.jsonld');
    expect(fs.existsSync(provFile)).toBe(true);

    const content = fs.readFileSync(provFile, 'utf-8');
    const provGraph = JSON.parse(content);

    expect(provGraph['@context']).toBeDefined();
    expect(provGraph['@graph']).toBeDefined();
    // The IR-driven graph includes the synthesized flag, review policy,
    // authors as agents, and clauses as separate entities.
    const root = provGraph['@graph'].find((e: any) => e['@id'] === 'speck:RetryHandler');
    expect(root).toBeDefined();
    expect(root).toHaveProperty('speckl:synthesized');
    expect(root).toHaveProperty('speckl:review');
  });

  it('should generate CycloneDX BOM', () => {
    generateCycloneDX(ast, testOutputDir);
    
    const cdxFile = path.join(testOutputDir, 'RetryHandler.specbom.cdx.json');
    expect(fs.existsSync(cdxFile)).toBe(true);
    
    const content = fs.readFileSync(cdxFile, 'utf-8');
    const cdx = JSON.parse(content);
    
    expect(cdx.bomFormat).toBe('CycloneDX');
    expect(cdx.specVersion).toBe('1.6');
    expect(cdx.components).toBeDefined();
  });

  it('should generate SPDX BOM', () => {
    generateSPDX(ast, testOutputDir);
    
    const spdxFile = path.join(testOutputDir, 'RetryHandler.specbom.spdx.json');
    expect(fs.existsSync(spdxFile)).toBe(true);
    
    const content = fs.readFileSync(spdxFile, 'utf-8');
    const spdx = JSON.parse(content);
    
    expect(spdx['@context']).toBeDefined();
    expect(spdx.spdx).toBeDefined();
  });
});
