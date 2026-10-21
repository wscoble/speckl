// parse → print → parse for member kinds no example uses. round-trip.test.ts
// covers the examples; these constructs only appear in other projects' specs
// (proto envelopes, BOM metadata), and two of them did not survive the trip:
// oneof variants printed in proto order (`Card card`, which the parser skips)
// and a transition's `type:` / `payload:` lines were dropped.
import { describe, it, expect, vi } from 'vitest';
import { parseSpeckContent } from '../parser.js';
import { printAST } from '../printer.js';

const SRC = `speck Envelope {
    license: "Apache-2.0"
    source: threat_model ref "TM-12"
    bom {
        compiler: "speckl" version "0.4.0"
        solver: "z3" version "4.13.0"
        runtime: "node" version "22"
        license: "MIT"
        hash: "sha256:def"
    }
    oneof Payload {
        card: Card
        bank: Bank
    }
    transition Move {
        type: MoveKind
        payload: Payload
        from: Nat
        to: Nat
    }
    state {
        tags: Set(String) | null
        owner: String | null
    }
}
`;

/** The AST without source positions, which printing does not preserve. */
const shape = (src: string) => JSON.parse(JSON.stringify(parseSpeckContent(src).specks[0],
  (k, v) => (k === 'startLine' || k === 'endLine' ? undefined : v)));

describe('printer round trip: metadata, proto envelope and nullable collections', () => {
  const printed = printAST(parseSpeckContent(SRC));

  it('parses back to the same AST', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(shape(printed)).toEqual(shape(SRC));
    vi.restoreAllMocks();
  });

  it('keeps oneof variants and the transition discriminator and payload', () => {
    const members = shape(printed).members;
    expect(members.find((m: any) => m.type === 'oneof').variants).toEqual([
      { fieldName: 'card', typeName: 'Card' }, { fieldName: 'bank', typeName: 'Bank' },
    ]);
    expect(members.find((m: any) => m.type === 'transition')).toMatchObject({ typeDiscriminator: 'MoveKind', payloadOneof: 'Payload' });
  });

  it('prints license, source ref and every bom entry', () => {
    expect(printed).toContain('license: "Apache-2.0"');
    expect(printed).toContain('source: threat_model ref "TM-12"');
    expect(printed).toContain('runtime: "node" version "22"');
    expect(printed).toContain('tags: Set(String) | null');
  });
});
