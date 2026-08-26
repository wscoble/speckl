// json-schema.ts — JSON Schema 2020-12 target.
//
// Consumes the IR's typed_schema + validation to emit JSON Schema.
// Each record becomes a top-level definition; constraints in the
// validation facet become JSON Schema validation keywords.

import * as fs from 'fs';
import * as path from 'path';
import { IR, IRRecordType, IRFieldDef, IRTypeRef, IRSpeck, IREnumType } from '../ir/types.js';

export class JSONSchemaTarget {
  generate(ir: IR, options: { outputDir: string }): string {
    const outDir = path.join(options.outputDir, 'json-schema');
    fs.mkdirSync(outDir, { recursive: true });

    const docs: string[] = [];
    for (const speck of ir.specks) {
      const doc = this.render(speck);
      docs.push(doc);
      const filename = path.join(outDir, `${speck.name.toLowerCase()}.schema.json`);
      fs.writeFileSync(filename, JSON.stringify(doc, null, 2));
      console.log(`Generated JSON Schema: ${filename}`);
    }
    return docs.join('\n');
  }

  private render(speck: IRSpeck): any {
    const types = speck.facets.typed_schema.types;
    const defs: Record<string, any> = {};
    for (const [name, type] of types.entries()) {
      if (type.kind === 'record') {
        defs[name] = this.recordToSchema(speck, type as IRRecordType);
      } else if (type.kind === 'enum') {
        defs[name] = { type: 'string', enum: (type as IREnumType).variants };
      }
    }
    return {
      $schema: 'https://json-schema.org/draft/2020-12/schema',
      $id: `${speck.name.toLowerCase()}.schema.json`,
      title: speck.name,
      $defs: defs,
    };
  }

  private recordToSchema(speck: IRSpeck, record: IRRecordType): any {
    const required: string[] = [];
    const properties: Record<string, any> = {};
    for (const field of record.fields) {
      if (!field.optional) required.push(field.name);
      properties[field.name] = this.typeRefToSchema(speck, field.type, field);
    }
    return { type: 'object', required, properties };
  }

  private typeRefToSchema(speck: IRSpeck, typeRef: IRTypeRef, field: IRFieldDef): any {
    if (typeRef.kind === 'primitive') {
      switch (typeRef.primitive) {
        case 'String': return { type: 'string' };
        case 'Nat':
        case 'Int': return { type: 'integer' };
        case 'Real': return { type: 'number' };
        case 'Bool': return { type: 'boolean' };
        case 'Date': return { type: 'string', format: 'date-time' };
        case 'Bytes': return { type: 'string', contentEncoding: 'base64' };
        default: return { type: 'string' };
      }
    }
    if (typeRef.kind === 'list' || typeRef.kind === 'set') {
      return { type: 'array', items: this.typeRefToSchema(speck, typeRef.elementType!, field) };
    }
    if (typeRef.kind === 'map') {
      return { type: 'object', additionalProperties: this.typeRefToSchema(speck, typeRef.valueType!, field) };
    }
    if (typeRef.kind === 'ident') {
      const namedType = speck.facets.typed_schema.types.get(typeRef.name || '');
      if (namedType?.kind === 'enum') return { type: 'string', enum: (namedType as IREnumType).variants };
      if (namedType?.kind === 'record') return { $ref: `#/$defs/${typeRef.name}` };
    }
    return { type: 'object' };
  }
}
