// openapi.ts — OpenAPI 3.1 target.
//
// Consumes the IR's typed_schema + service + validation facets
// to emit an OpenAPI 3.1 specification. Each service in the spec
// becomes a `paths` entry; each type becomes a `components.schemas`
// entry; field validation becomes JSON Schema constraints.

import * as fs from 'fs';
import * as path from 'path';
import { IR, IRRecordType, IRFieldDef, IRTypeRef, IRSpeck, IREnumType, IRService } from '../ir/types.js';

export class OpenAPITarget {
  generate(ir: IR, options: { outputDir: string }): string {
    const outDir = path.join(options.outputDir, 'openapi');
    fs.mkdirSync(outDir, { recursive: true });

    const docs: string[] = [];
    for (const speck of ir.specks) {
      const doc = this.renderSpec(speck);
      docs.push(doc);
      const filename = path.join(outDir, `${speck.name.toLowerCase()}.openapi.json`);
      fs.writeFileSync(filename, JSON.stringify(doc, null, 2));
      console.log(`Generated OpenAPI spec: ${filename}`);
    }
    return docs.join('\n');
  }

  private renderSpec(speck: IRSpeck): any {
    const types = speck.facets.typed_schema.types;
    const components: Record<string, any> = {};
    for (const [name, type] of types.entries()) {
      if (type.kind === 'record') {
        components[name] = this.recordToSchema(speck, type as IRRecordType);
      } else if (type.kind === 'enum') {
        components[name] = {
          type: 'string',
          enum: (type as IREnumType).variants,
        };
      }
    }

    const paths: Record<string, any> = {};
    for (const service of speck.facets.typed_schema.services) {
      for (const method of service.methods) {
        const path_ = `/${method.name.toLowerCase()}`;
        paths[path_] = {
          post: {
            summary: method.name,
            operationId: `${service.name}_${method.name}`,
            requestBody: {
              required: true,
              content: {
                'application/json': {
                  schema: { '$ref': `#/components/schemas/${method.requestType}` },
                },
              },
            },
            responses: {
              '200': {
                description: 'Success',
                content: {
                  'application/json': {
                    schema: { '$ref': `#/components/schemas/${method.responseType}` },
                  },
                },
              },
            },
          },
        };
      }
    }

    return {
      openapi: '3.1.0',
      info: {
        title: speck.name,
        version: speck.facets.metadata.version || '0.0.0',
        description: this.firstDesignDecision(speck),
        'x-speckl-source': speck.name,
        'x-speckl-version': speck.facets.metadata.version,
      },
      paths,
      components: { schemas: components },
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
    let schema: any;
    if (typeRef.kind === 'primitive') {
      schema = this.primitiveToSchema(typeRef.primitive || 'string');
    } else if (typeRef.kind === 'list' || typeRef.kind === 'set') {
      schema = { type: 'array', items: this.typeRefToSchema(speck, typeRef.elementType!, field) };
    } else if (typeRef.kind === 'map') {
      schema = { type: 'object', additionalProperties: this.typeRefToSchema(speck, typeRef.valueType!, field) };
    } else if (typeRef.kind === 'ident') {
      const namedType = speck.facets.typed_schema.types.get(typeRef.name || '');
      if (namedType?.kind === 'enum') {
        schema = { type: 'string', enum: (namedType as IREnumType).variants };
      } else if (namedType?.kind === 'record') {
        schema = { '$ref': `#/components/schemas/${typeRef.name}` };
      } else {
        schema = { type: 'object' };
      }
    } else {
      schema = { type: 'object' };
    }
    // OpenAPI 3.1 supports null via JSON Schema's `type: ['T', 'null']` form.
    if (typeRef.nullable && schema.type) {
      schema = { ...schema, type: Array.isArray(schema.type) ? [...schema.type, 'null'] : [schema.type, 'null'] };
    }
    return schema;
  }

  private primitiveToSchema(prim: string): any {
    switch (prim) {
      case 'String': return { type: 'string' };
      case 'Nat':
      case 'Int': return { type: 'integer', format: 'int64' };
      case 'Real': return { type: 'number' };
      case 'Bool': return { type: 'boolean' };
      case 'Date': return { type: 'string', format: 'date-time' };
      case 'Bytes': return { type: 'string', format: 'byte' };
      default: return { type: 'string' };
    }
  }

  private firstDesignDecision(speck: IRSpeck): string | undefined {
    const dd = speck.facets.provenance.clauses
      .find((c: any) => c.kind === 'design_decision' || c.type === 'design_decision');
    return dd ? (dd as any).value : undefined;
  }
}
