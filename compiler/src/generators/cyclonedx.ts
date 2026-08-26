import { AST, BOMNode } from '../parser.js';
import fs from 'fs';
import path from 'path';

/**
 * Generate CycloneDX v1.6 JSON for a Speck
 */
export function generateCycloneDX(ast: AST, outputDir: string): void {
  for (const speck of ast.specks) {
    const bom = createCycloneDXBOM(speck);
    
    // Write the CycloneDX file
    const filename = `${speck.name}.specbom.cdx.json`;
    const filepath = path.join(outputDir, filename);
    fs.writeFileSync(filepath, JSON.stringify(bom, null, 2));
    
    console.log(`Generated CycloneDX BOM: ${filepath}`);
  }
}

function createCycloneDXBOM(speck: any): any {
  const bom: any = {
    bomFormat: 'CycloneDX',
    specVersion: '1.6',
    components: [],
    metadata: {
      tools: [],
      component: {
        type: 'application',
        name: speck.name,
        version: '0.2.0'
      }
    },
    annotations: []
  };
  
  // Add toolchain from bom block
  for (const member of speck.members) {
    if (member.type === 'bom') {
      if (member.compiler) {
        bom.metadata.tools.push({
          vendor: 'Speckl',
          name: member.compiler.name,
          version: member.compiler.version || '0.2.0'
        });
        // Issue #59: populate components[] from bom block — compiler is a component
        bom.components.push({
          type: 'application',
          name: member.compiler.name,
          version: member.compiler.version || '0.2.0',
          bomRef: `compiler:${member.compiler.name}`,
        });
      }
      
      if (member.solver) {
        bom.metadata.tools.push({
          vendor: 'Microsoft',
          name: member.solver.name,
          version: member.solver.version || '4.12.5'
        });
        // Issue #59: solver is a component
        bom.components.push({
          type: 'application',
          name: member.solver.name,
          version: member.solver.version || '4.12.5',
          bomRef: `solver:${member.solver.name}`,
        });
      }
      
      if (member.runtime) {
        bom.metadata.tools.push({
          vendor: 'WebAssembly',
          name: member.runtime.name,
          version: member.runtime.version || '1.0.0'
        });
        // Issue #59: runtime is a component
        bom.components.push({
          type: 'application',
          name: member.runtime.name,
          version: member.runtime.version || '1.0.0',
          bomRef: `runtime:${member.runtime.name}`,
        });
      }
      
      if (member.license) {
        bom.metadata.component.licenses = [
          { license: { id: member.license } }
        ];
      }
      
      if (member.hash) {
        // Parse hash format: sha256:hashvalue
        const hashParts = member.hash.split(':');
        if (hashParts.length === 2) {
          bom.metadata.component.hashes = [
            {
              algorithm: `SHA-${hashParts[0].replace('sha', '')}`,
              value: hashParts[1]
            }
          ];
        }
      }
    }
    
    // Add author as annotation
    if (member.type === 'author') {
      bom.annotations.push({
        subject: `speck:${speck.name}`,
        annotations: [
          {
            type: 'tag',
            value: 'provenanceType',
            text: 'author'
          }
        ],
        author: {
          name: member.name,
          email: member.email
        },
        timestamp: new Date().toISOString()
      });
    }
    
    // Add source as annotation
    if (member.type === 'source') {
      bom.annotations.push({
        subject: `speck:${speck.name}`,
        annotations: [
          {
            type: 'tag',
            value: 'provenanceType',
            text: 'source'
          }
        ],
        author: {
          name: 'Speckl Compiler',
          email: 'compiler@speckl.scoble.me'
        },
        timestamp: new Date().toISOString()
      });
    }
    
    // Add review annotation
    if (member.type === 'review') {
      bom.annotations.push({
        subject: `speck:${speck.name}`,
        annotations: [
          {
            type: 'tag',
            value: 'reviewType',
            text: member.kind
          }
        ],
        author: {
          name: 'Speckl Compiler',
          email: 'compiler@speckl.scoble.me'
        },
        timestamp: new Date().toISOString()
      });
    }
    
    // Add provenance annotations
    if (member.type === 'provenance') {
      for (const clause of member.clauses) {
        if (clause.type === 'regulation') {
          bom.annotations.push({
            subject: `speck:${speck.name}`,
            annotations: [
              {
                type: 'tag',
                value: 'provenanceType',
                text: 'regulation'
              }
            ],
            author: {
              name: 'Speckl Compiler',
              email: 'compiler@speckl.scoble.me'
            },
            timestamp: new Date().toISOString()
          });
        }
      }
    }
  }
  
  // Add derives/satisfies as properties
  bom.metadata.component.properties = [];
  for (const member of speck.members) {
    if (member.type === 'derives') {
      bom.metadata.component.properties.push({
        name: 'speckl:derivesFrom',
        value: member.from
      });
    }
    
    if (member.type === 'satisfies') {
      const value = member.clause ? `${member.requirement} clause ${member.clause}` : member.requirement;
      bom.metadata.component.properties.push({
        name: 'speckl:satisfies',
        value
      });
    }
  }
  
  return bom;
}
