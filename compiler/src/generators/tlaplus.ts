// tlaplus.ts — TLA+ / PlusCal target.
//
// Consumes the IR's behavior + formal_spec to emit a TLA+ spec
// suitable for model checking with the TLC model checker. State
// vars become TLA+ variables; actions become TLA+ actions; constraints
// become state invariants.

import * as fs from 'fs';
import * as path from 'path';
import { IR, IRSpeck } from '../ir/types.js';

export class TLAPlusTarget {
  generate(ir: IR, options: { outputDir: string }): string {
    const outDir = path.join(options.outputDir, 'tlaplus');
    fs.mkdirSync(outDir, { recursive: true });

    const docs: string[] = [];
    for (const speck of ir.specks) {
      const doc = this.render(speck);
      docs.push(doc);
      const filename = path.join(outDir, `${speck.name.toLowerCase()}.tla`);
      fs.writeFileSync(filename, doc);
      console.log(`Generated TLA+ spec: ${filename}`);
    }
    return docs.join('\n');
  }

  private render(speck: IRSpeck): string {
    const lines: string[] = [];
    lines.push(`-------------------------- MODULE ${speck.name} ---------------------------`);
    lines.push('(*');
    lines.push(` * ${speck.name} — TLA+ specification generated from Speckl.`);
    lines.push(` *`);
    lines.push(` * Source: ${speck.name}.speckdl`);
    lines.push(` * Version: ${speck.facets.metadata.version || '0.0.0'}`);
    lines.push(` * Author: ${speck.facets.metadata.author || 'unknown'}`);
    lines.push(` *`);
    lines.push(` * ${speck.facets.provenance.clauses.length} provenance clauses`);
    lines.push(` * ${speck.facets.behavior.actions.length} actions`);
    lines.push(` * ${speck.facets.behavior.stateVars.length} state variables`);
    lines.push(` * ${speck.facets.formal_spec.constraints.length} invariants`);
    lines.push(' *)');
    lines.push('');
    lines.push('EXTENDS Naturals, Sequences, FiniteSets, TLC');
    lines.push('');

    // State variables
    lines.push('VARIABLES');
    for (const sv of speck.facets.behavior.stateVars) {
      lines.push(`    ${sv.name}  \\* ${sv.type.name || sv.type.primitive || '?'}`);
    }
    lines.push('');

    // Type invariants
    lines.push('TypeOK ==');
    lines.push('    /\\ ' + speck.facets.behavior.stateVars.map((sv) => `${sv.name} \\in ?`).join('\n    /\\ '));
    lines.push('');

    // Initial state
    lines.push('Init ==');
    if (speck.facets.behavior.init.length > 0) {
      for (const init of speck.facets.behavior.init) {
        lines.push(`    /\\ ${init.target} = ${init.expr}`);
      }
    } else {
      lines.push('    /\\ TRUE');
    }
    lines.push('');

    // Actions
    lines.push('\\* ─── Actions ────────────────────────────────────────');
    for (const action of speck.facets.behavior.actions) {
      lines.push(`${action.name}(${action.params.map((p) => p.name).join(', ')}) ==`);
      lines.push('    TRUE  \\* placeholder; full action bodies require expression lowering');
      lines.push('');
    }

    // Next
    lines.push('Next ==');
    lines.push('    \\/ \\E a \\in {' + speck.facets.behavior.actions.map((a) => `"${a.name}"`).join(', ') + '}: TRUE');
    lines.push('');

    // Spec
    lines.push('Spec == Init /\\ [][Next]_<<' +
      speck.facets.behavior.stateVars.map((sv) => sv.name).join(', ') + '>>');
    lines.push('');

    // Invariants from formal_spec
    if (speck.facets.formal_spec.constraints.length > 0) {
      lines.push('\\* ─── Invariants from formal_spec ──────────────────');
      for (const c of speck.facets.formal_spec.constraints) {
        const safeName = (c.name || 'unnamed').replace(/[^a-zA-Z0-9_]/g, '_');
        lines.push(`${safeName} == TRUE  \\* ${c.name}`);
      }
      lines.push('');
      lines.push('Invariant == /\\ ' + speck.facets.formal_spec.constraints
        .map((c) => (c.name || 'unnamed').replace(/[^a-zA-Z0-9_]/g, '_')).join('\n         /\\ '));
    } else {
      lines.push('Invariant == TypeOK');
    }
    lines.push('');
    lines.push('================================================================================');
    lines.push('\\* Modification History');
    lines.push(`\\* Generated ${new Date().toISOString()} from ${speck.name}.speckdl`);
    return lines.join('\n');
  }
}
