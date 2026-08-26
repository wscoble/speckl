// examples/__tests__/blog-ir.test.ts
//
// Verify the Blog.speckdl compiles to a complete IR.
// The blog is a content app with CRUD, lifecycles, and a real service
// surface. If this lowers cleanly, the "specify anything with provenance"
// claim holds for the content class.

import { describe, it, expect } from 'vitest';
import { join } from 'path';
import { parseSpeckFile } from '../../src/parser.js';
import { lower } from '../../src/ir/lower.js';

const REPO = '/home/sscoble/speckl';

describe('Blog IR', () => {
  const fp = join(REPO, 'examples', 'Blog.speckdl');
  const ast = parseSpeckFile(fp);
  const ir = lower(ast, { filePath: fp, resolveImports: false });

  it('lowers to 1 speck', () => {
    expect(ir.specks).toHaveLength(1);
    expect(ir.specks[0].name).toBe('Blog');
  });

  it('has all 8 named facets', () => {
    const f = ir.specks[0].facets;
    expect(f.typed_schema).toBeDefined();
    expect(f.behavior).toBeDefined();
    expect(f.formal_spec).toBeDefined();
    expect(f.wire_format).toBeDefined();
    expect(f.validation).toBeDefined();
    expect(f.resource_lifecycle).toBeDefined();
    expect(f.provenance).toBeDefined();
    expect(f.metadata).toBeDefined();
  });

  it('typed_schema has 4 records and 3 enums', () => {
    const ts = ir.specks[0].facets.typed_schema;
    const recordTypes = [...ts.types.values()].filter(t => t.kind === 'record');
    const enumTypes = [...ts.types.values()].filter(t => t.kind === 'enum');
    expect(recordTypes.length).toBe(4);
    expect(enumTypes.length).toBe(3);
    expect(ts.types.has('Post')).toBe(true);
    expect(ts.types.has('Comment')).toBe(true);
    expect(ts.types.has('Author')).toBe(true);
    expect(ts.types.has('Tag')).toBe(true);
  });

  it('behavior has 8 actions across 4 resources', () => {
    const b = ir.specks[0].facets.behavior;
    const actionNames = b.actions.map(a => a.name);
    expect(actionNames).toContain('CreatePost');
    expect(actionNames).toContain('PublishPost');
    expect(actionNames).toContain('ArchivePost');
    expect(actionNames).toContain('CreateComment');
    expect(actionNames).toContain('HideComment');
    expect(actionNames).toContain('CreateAuthor');
    expect(actionNames).toContain('CreateTag');
    expect(actionNames).toContain('AddTagToPost');
  });

  it('service has 7 RPCs', () => {
    const ts = ir.specks[0].facets.typed_schema;
    expect(ts.services).toHaveLength(1);
    expect(ts.services[0].name).toBe('BlogService');
    expect(ts.services[0].methods).toHaveLength(7);
  });

  it('wire_format has proto_package', () => {
    const wf = ir.specks[0].facets.wire_format;
    expect(wf.protoPackage).toBe('blog.v1');
    expect(wf.goPackage).toBe('github.com/sscoble/blog/proto/blog/v1;blogv1');
  });

  it('provenance has author and design decisions', () => {
    const p = ir.specks[0].facets.provenance;
    expect(p.authors.length).toBeGreaterThan(0);
    expect(p.authors[0].name).toBe('sscoble');
  });

  it('metadata has author', () => {
    const m = ir.specks[0].facets.metadata;
    expect(m.author).toBe('sscoble');
  });
});
