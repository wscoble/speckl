import { AST, MemberNode } from '../parser.js';
import fs from 'fs';
import path from 'path';

/**
 * Generate SPDX 3.0.1 JSON-LD for a Speck
 */
export function generateSPDX(ast: AST, outputDir: string): void {
  for (const speck of ast.specks) {
    const spdx = createSPDXDocument(speck);
    
    // Write the SPDX file
    const filename = `${speck.name}.specbom.spdx.json`;
    const filepath = path.join(outputDir, filename);
    fs.writeFileSync(filepath, JSON.stringify(spdx, null, 2));
    
    console.log(`Generated SPDX BOM: ${filepath}`);
  }
}

function createSPDXDocument(speck: any): any {
  const doc: any = {
    '@context': [
      'https://spdx.github.io/spdx-v3/spdx-context.jsonld',
      {
        speckl: 'https://speckl.scoble.me/ns/v0.2#'
      }
    ],
    '@type': 'spdx:Document',
    spdx: {
      '@id': `spdx:${speck.name}`,
      '@type': 'spdx:Snippet',
      name: speck.name,
      spdxVersion: '3.0.1',
      dataLicense: 'CC0-1.0',
      creationInfo: {
        created: new Date().toISOString(),
        createdBy: ['Organization: Speckl', 'tool: speckl-compile-0.2.0']
      }
    },
    builtBy: [],
    relationships: [],
    elements: []
  };
  
  // Add toolchain from bom block
  for (const member of speck.members) {
    if (member.type === 'bom') {
      // Issue #59: populate creationInfo.createdBy from bom block
      if (member.compiler) {
        doc.builtBy.push({
          '@type': 'spdx:Build',
          tool: [
            {
              name: member.compiler.name,
              version: member.compiler.version || '0.2.0'
            }
          ]
        });
        // Add compiler as a creator in creationInfo.createdBy
        if (!doc.spdx.creationInfo.createdBy.includes(`tool: ${member.compiler.name}-${member.compiler.version || '0.2.0'}`)) {
          doc.spdx.creationInfo.createdBy.push(`tool: ${member.compiler.name}-${member.compiler.version || '0.2.0'}`);
        }
      }
      
      if (member.solver) {
        doc.builtBy[0].tool.push({
          name: member.solver.name,
          version: member.solver.version || '4.12.5'
        });
        // Add solver as a creator in creationInfo.createdBy
        if (!doc.spdx.creationInfo.createdBy.includes(`tool: ${member.solver.name}-${member.solver.version || '4.12.5'}`)) {
          doc.spdx.creationInfo.createdBy.push(`tool: ${member.solver.name}-${member.solver.version || '4.12.5'}`);
        }
      }
      
      if (member.runtime) {
        doc.builtBy[0].tool.push({
          name: member.runtime.name,
          version: member.runtime.version || '1.0.0'
        });
        // Add runtime as a creator in creationInfo.createdBy
        if (!doc.spdx.creationInfo.createdBy.includes(`tool: ${member.runtime.name}-${member.runtime.version || '1.0.0'}`)) {
          doc.spdx.creationInfo.createdBy.push(`tool: ${member.runtime.name}-${member.runtime.version || '1.0.0'}`);
        }
      }
      
      if (member.license) {
        doc.spdx.spdxLicenseConcluded = member.license;
      }
      
      if (member.hash) {
        // Parse hash format: sha256:hashvalue
        const hashParts = member.hash.split(':');
        if (hashParts.length === 2) {
          doc.spdx.hash = [
            {
              algorithm: `spdx:sha${hashParts[0].replace('sha', '')}`,
              value: hashParts[1]
            }
          ];
        }
      }
    }
    
    // Add author relationship
    if (member.type === 'author') {
      const authorElement = {
        '@type': 'spdx:Person',
        '@id': `spdx:agent:${member.name}`,
        name: member.name,
        email: member.email
      };
      
      doc.elements.push(authorElement);
      
      doc.relationships.push({
        from: { '@id': `spdx:${speck.name}` },
        to: { '@id': authorElement['@id'] },
        relationshipType: 'spdx:wasAttributedTo'
      });
    }
    
    // Add source relationship
    if (member.type === 'source') {
      const sourceElement = {
        '@type': 'spdx:Activity',
        '@id': `spdx:source:${member.kind}:${member.ref || 'unknown'}`,
        name: `${member.kind} - ${member.ref || 'unknown'}`,
        type: member.kind
      };
      
      doc.elements.push(sourceElement);
      
      doc.relationships.push({
        from: { '@id': `spdx:${speck.name}` },
        to: { '@id': sourceElement['@id'] },
        relationshipType: 'spdx:wasInformedBy'
      });
    }
    
    // Add review annotation
    if (member.type === 'review') {
      doc.spdx.annotations = [
        {
          '@type': 'spdx:Annotation',
          annotationType: 'spdx:REVIEW',
          annotator: {
            '@type': 'spdx:Tool',
            name: 'speckl-compile'
          },
          timestamp: new Date().toISOString(),
          comment: `Review type: ${member.kind}`
        }
      ];
    }
    
    // Add provenance relationships
    if (member.type === 'provenance') {
      for (const clause of member.clauses) {
        if (clause.type === 'regulation') {
          const regulationElement = {
            '@type': 'spdx:Requirement',
            '@id': `spdx:regulation:${clause.value}`,
            name: clause.value
          };
          
          doc.elements.push(regulationElement);
          
          doc.relationships.push({
            from: { '@id': `spdx:${speck.name}` },
            to: { '@id': regulationElement['@id'] },
            relationshipType: 'speckl:regulationReference'
          });
        }
      }
    }
    
    // Add derives relationship
    if (member.type === 'derives') {
      doc.relationships.push({
        from: { '@id': `spdx:${speck.name}` },
        to: { '@id': `spdx:speck:${member.from}` },
        relationshipType: 'spdx:derivesFrom'
      });
    }
    
    // Add satisfies relationship
    if (member.type === 'satisfies') {
      doc.elements.push({
        '@type': 'spdx:Requirement',
        '@id': `spdx:requirement:${member.requirement}`,
        name: member.requirement
      });
      
      doc.relationships.push({
        from: { '@id': `spdx:${speck.name}` },
        to: { '@id': `spdx:requirement:${member.requirement}` },
        relationshipType: 'speckl:satisfies',
        additionalProperties: member.clause ? [
          {
            name: 'speckl:clause',
            value: member.clause
          }
        ] : undefined
      });
    }
  }
  
  return doc;
}
