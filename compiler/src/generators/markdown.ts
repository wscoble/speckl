// markdown.ts — Markdown documentation target.
//
// Consumes the IR to emit human-readable documentation. Each section
// of the spec becomes a section in the markdown; provenance becomes
// a "Lineage" appendix; resource_lifecycle becomes a "Lifecycle"
// section.

import * as fs from 'fs';
import * as path from 'path';
import { IR, IRRecordType, IRFieldDef, IRTypeRef, IRSpeck, IREnumType } from '../ir/types.js';

export class MarkdownTarget {
  generate(ir: IR, options: { outputDir: string }): string {
    const outDir = path.join(options.outputDir, 'markdown');
    fs.mkdirSync(outDir, { recursive: true });

    const docs: string[] = [];
    for (const speck of ir.specks) {
      const doc = this.render(speck);
      docs.push(doc);
      const filename = path.join(outDir, `${speck.name.toLowerCase()}.md`);
      fs.writeFileSync(filename, doc);
      console.log(`Generated Markdown docs: ${filename}`);
    }
    return docs.join('\n');
  }

  private render(speck: IRSpeck): string {
    const lines: string[] = [];
    const meta = speck.facets.metadata;
    lines.push(`# ${speck.name}`);
    lines.push('');
    lines.push(`*Version ${meta.version || '0.0.0'} · ${meta.author || 'unknown'} · ${meta.license || 'unspecified'}*`);
    lines.push('');

    // Overview from first design decision
    const dd = speck.facets.provenance.clauses
      .find((c: any) => c.kind === 'design_decision' || c.type === 'design_decision');
    if (dd) {
      lines.push(`> ${(dd as any).value}`);
      lines.push('');
    }

    // Types
    lines.push('## Types');
    lines.push('');
    for (const [name, type] of speck.facets.typed_schema.types.entries()) {
      if (type.kind === 'record' && !name.endsWith('Spec') && !name.endsWith('Status')) {
        if (name === 'TypeMeta' || name === 'ObjectMeta' || name === 'ListMeta') continue;
        lines.push(this.recordToMarkdown(name, type as IRRecordType));
        lines.push('');
      } else if (type.kind === 'enum') {
        lines.push(`### enum ${name}`);
        lines.push('');
        for (const v of (type as IREnumType).variants) {
          lines.push(`- \`${v}\``);
        }
        lines.push('');
      }
    }

    // Services
    if (speck.facets.typed_schema.services.length > 0) {
      lines.push('## Services');
      lines.push('');
      for (const service of speck.facets.typed_schema.services) {
        lines.push(`### ${service.name}`);
        lines.push('');
        for (const method of service.methods) {
          lines.push(`- **${method.name}**(\`${method.requestType}\`) → \`${method.responseType}\``);
        }
        lines.push('');
      }
    }

    // Behavior (actions)
    const actions = speck.facets.behavior.actions;
    if (actions.length > 0) {
      lines.push('## Behavior');
      lines.push('');
      lines.push(`*${actions.length} actions*`);
      lines.push('');
      for (const action of actions) {
        const params = action.params.map((p) => `${p.name}: ${p.type.name || p.type.primitive || '?'}`).join(', ');
        lines.push(`- **${action.name}**(${params})`);
      }
      lines.push('');
    }

    // Resource lifecycle
    const rl = speck.facets.resource_lifecycle;
    if (rl.conditions.length > 0 || rl.finalizers.length > 0) {
      lines.push('## Lifecycle');
      lines.push('');
      if (rl.conditions.length > 0) {
        lines.push('**Conditions:**');
        for (const c of rl.conditions) lines.push(`- \`${c}\``);
        lines.push('');
      }
      if (rl.finalizers.length > 0) {
        lines.push('**Finalizers:**');
        for (const f of rl.finalizers) lines.push(`- \`${f}\``);
        lines.push('');
      }
    }

    // Formal spec
    const constraints = speck.facets.formal_spec.constraints;
    if (constraints.length > 0) {
      lines.push('## Invariants');
      lines.push('');
      for (const c of constraints) {
        lines.push(`- **${c.name}**`);
      }
      lines.push('');
    }

    // Provenance appendix
    lines.push('## Lineage');
    lines.push('');
    for (const clause of speck.facets.provenance.clauses) {
      const kind = (clause as any).kind || (clause as any).type;
      const value = (clause as any).value;
      const loc = (clause as any).location;
      if (loc) {
        lines.push(`- **${kind}**: ${value} — [source](${loc})`);
      } else {
        lines.push(`- **${kind}**: ${value}`);
      }
    }
    lines.push('');

    return lines.join('\n');
  }

  private recordToMarkdown(name: string, record: IRRecordType): string {
    const lines: string[] = [`### ${name}`];
    lines.push('');
    lines.push('| Field | Type | Required |');
    lines.push('|-------|------|----------|');
    for (const field of record.fields) {
      const type = this.fieldType(field);
      const required = field.optional ? 'no' : 'yes';
      lines.push(`| \`${field.name}\` | \`${type}\` | ${required} |`);
    }
    return lines.join('\n');
  }

  private fieldType(field: IRFieldDef): string {
    const t = field.type;
    if (t.kind === 'primitive') return t.primitive || 'unknown';
    if (t.kind === 'list') return `List<${this.fieldType({ ...field, type: t.elementType! } as any)}>`;
    if (t.kind === 'map') return `Map<${this.fieldType({ ...field, type: t.valueType! } as any)}>`;
    if (t.kind === 'ident') return t.name || 'unknown';
    return 'unknown';
  }
}
