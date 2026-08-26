import { describe, it, expect } from 'vitest';
import path from 'path';
import { fileURLToPath } from 'url';
import { parseSpeckContent, parseSpeckFile } from '../src/parser.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

describe('SpeckDL Parser', () => {
  describe('parseSpeckContent', () => {
    it('should parse a minimal speck definition with name', () => {
      const content = `speck Minimal {
  input: Nat
  output: Bool
}`;
      const ast = parseSpeckContent(content);
      expect(ast.specks).toHaveLength(1);
      expect(ast.specks[0].name).toBe('Minimal');
    });

    it('should parse multiple speck definitions in one file', () => {
      const content = `speck First {
  input: Nat
  output: Bool
}

speck Second {
  input: String
  output: Nat
}`;
      const ast = parseSpeckContent(content);
      expect(ast.specks).toHaveLength(2);
      expect(ast.specks[0].name).toBe('First');
      expect(ast.specks[1].name).toBe('Second');
    });

    it('should return empty specks array for empty content', () => {
      const ast = parseSpeckContent('');
      expect(ast.specks).toHaveLength(0);
    });

    it('should return empty specks array for comment-only content', () => {
      const ast = parseSpeckContent('// This is a comment\n/* block comment */\n');
      expect(ast.specks).toHaveLength(0);
    });

    it('should skip comments inside speck blocks', () => {
      const content = `speck WithComments {
  // This is a comment
  input: Nat
  /* block comment */
  output: String
}`;
      const ast = parseSpeckContent(content);
      expect(ast.specks).toHaveLength(1);
      expect(ast.specks[0].members).toHaveLength(2);
    });

    it('should parse speck name with hyphenated names', () => {
      const content = `speck My-Service-Handler {
  input: Nat
  output: Bool
}`;
      const ast = parseSpeckContent(content);
      expect(ast.specks).toHaveLength(1);
      expect(ast.specks[0].name).toBe('My-Service-Handler');
    });
  });

  describe('member parsing - inputs and outputs', () => {
    it('should parse input with primitive type', () => {
      const content = `speck Test {
  input: Nat
}`;
      const ast = parseSpeckContent(content);
      const members = ast.specks[0].members;
      expect(members).toHaveLength(1);
      expect(members[0].type).toBe('input');
      if (members[0].type === 'input') {
        expect(members[0].typeExpr.type).toBe('primitive');
        expect(members[0].typeExpr.name).toBe('Nat');
      }
    });

    it('should parse output with primitive type', () => {
      const content = `speck Test {
  output: Bool
}`;
      const ast = parseSpeckContent(content);
      expect(ast.specks[0].members[0].type).toBe('output');
    });

    it('should parse input with record type', () => {
      const content = `speck Test {
  input: { name: String, age: Nat }
}`;
      const ast = parseSpeckContent(content);
      const input = ast.specks[0].members[0];
      expect(input.type).toBe('input');
      if (input.type === 'input') {
        expect(input.typeExpr.type).toBe('record');
        expect(input.typeExpr.fields).toHaveLength(2);
        expect(input.typeExpr.fields![0].name).toBe('name');
        expect(input.typeExpr.fields![1].name).toBe('age');
      }
    });

    it('should parse input with multi-line record type (speckl#57)', () => {
      const content = `speck Test {
  input: {
    operation: Operation,
    maxRetries: Nat,
    initialDelay: Real,
    maxDelay: Real
  }
  output: {
    success: Bool,
    finalResult: String,
    attemptCount: Nat,
    totalDelay: Real
  }
}`;
      const ast = parseSpeckContent(content);
      const input = ast.specks[0].members[0];
      const output = ast.specks[0].members[1];
      expect(input.type).toBe('input');
      expect(output.type).toBe('output');
      if (input.type === 'input') {
        expect(input.typeExpr.type).toBe('record');
        expect(input.typeExpr.fields).toHaveLength(4);
        expect(input.typeExpr.fields![0].name).toBe('operation');
        expect(input.typeExpr.fields![3].name).toBe('maxDelay');
      }
      if (output.type === 'output') {
        expect(output.typeExpr.type).toBe('record');
        expect(output.typeExpr.fields).toHaveLength(4);
        expect(output.typeExpr.fields![0].name).toBe('success');
        expect(output.typeExpr.fields![3].name).toBe('totalDelay');
      }
    });

    it('should parse input with multi-line record type, comments inside (speckl#57)', () => {
      // Edge case: line comments inside the block
      const content = `speck Test {
  input: {
    // the operation to retry
    operation: Operation,
    // max number of retry attempts
    retries: Nat
  }
}`;
      const ast = parseSpeckContent(content);
      const input = ast.specks[0].members[0];
      if (input.type === 'input') {
        expect(input.typeExpr.type).toBe('record');
        expect(input.typeExpr.fields).toHaveLength(2);
        expect(input.typeExpr.fields![0].name).toBe('operation');
        expect(input.typeExpr.fields![1].name).toBe('retries');
      }
    });

    it('should parse input with list type', () => {
      const content = `speck Test {
  input: [Nat]
}`;
      const ast = parseSpeckContent(content);
      const input = ast.specks[0].members[0];
      if (input.type === 'input') {
        expect(input.typeExpr.type).toBe('list');
        expect(input.typeExpr.elementType?.type).toBe('primitive');
        expect(input.typeExpr.elementType?.name).toBe('Nat');
      }
    });

    it('should parse all supported primitive types', () => {
      const primitives = ['Nat', 'Int', 'Real', 'Bool', 'String', 'Bytes'];
      for (const prim of primitives) {
        const content = `speck Test {
  input: ${prim}
}`;
        const ast = parseSpeckContent(content);
        const input = ast.specks[0].members[0];
        if (input.type === 'input') {
          expect(input.typeExpr.name).toBe(prim);
        }
      }
    });
  });

  describe('member parsing - constraints', () => {
    it('should parse simple constraints', () => {
      const content = `speck Test {
  input: Nat
  constraint: x > 0
  constraint: y <= 100
}`;
      const ast = parseSpeckContent(content);
      const constraints = ast.specks[0].members.filter(m => m.type === 'constraint');
      expect(constraints).toHaveLength(2);
      if (constraints[0].type === 'constraint') {
        expect(constraints[0].expr).toBe('x > 0');
      }
      if (constraints[1].type === 'constraint') {
        expect(constraints[1].expr).toBe('y <= 100');
      }
    });

    it('should parse complex constraint expressions', () => {
      const content = `speck Test {
  input: Nat
  constraint: implies(safe, volume >= minDose / drugConcentration)
}`;
      const ast = parseSpeckContent(content);
      const constraint = ast.specks[0].members.find(m => m.type === 'constraint');
      expect(constraint).toBeDefined();
      if (constraint?.type === 'constraint') {
        expect(constraint.expr).toContain('implies');
        expect(constraint.expr).toContain('volume');
      }
    });
  });

  describe('member parsing - verify', () => {
    it('should parse verify statements', () => {
      const content = `speck Test {
  input: Nat
  verify: always(implies(attempt > 1, delay > 0))
}`;
      const ast = parseSpeckContent(content);
      const verify = ast.specks[0].members.find(m => m.type === 'verify');
      expect(verify).toBeDefined();
      if (verify?.type === 'verify') {
        expect(verify.temporalExpr).toContain('always');
        expect(verify.temporalExpr).toContain('implies');
      }
    });
  });

  describe('member parsing - review', () => {
    it('should parse manual review', () => {
      const content = `speck Test {
  input: Nat
  review: manual
}`;
      const ast = parseSpeckContent(content);
      const review = ast.specks[0].members.find(m => m.type === 'review');
      expect(review).toBeDefined();
      if (review?.type === 'review') {
        expect(review.kind).toBe('manual');
      }
    });

    it('should parse auto review', () => {
      const content = `speck Test {
  input: Nat
  review: auto
}`;
      const ast = parseSpeckContent(content);
      const review = ast.specks[0].members.find(m => m.type === 'review');
      if (review?.type === 'review') {
        expect(review.kind).toBe('auto');
      }
    });

    it('should parse hybrid review', () => {
      const content = `speck Test {
  input: Nat
  review: hybrid
}`;
      const ast = parseSpeckContent(content);
      const review = ast.specks[0].members.find(m => m.type === 'review');
      if (review?.type === 'review') {
        expect(review.kind).toBe('hybrid');
      }
    });
  });

  describe('member parsing - derives and satisfies', () => {
    it('should parse derives from with via rationale', () => {
      const content = `speck Test {
  input: Nat
  derives from ParentSpeck via "specialization"
}`;
      const ast = parseSpeckContent(content);
      const derives = ast.specks[0].members.find(m => m.type === 'derives');
      expect(derives).toBeDefined();
      if (derives?.type === 'derives') {
        expect(derives.from).toBe('ParentSpeck');
        expect(derives.via).toBe('specialization');
      }
    });

    it('should parse derives from without via', () => {
      const content = `speck Test {
  input: Nat
  derives from BaseComponent
}`;
      const ast = parseSpeckContent(content);
      const derives = ast.specks[0].members.find(m => m.type === 'derives');
      if (derives?.type === 'derives') {
        expect(derives.from).toBe('BaseComponent');
        expect(derives.via).toBeUndefined();
      }
    });

    it('should parse satisfies with clause', () => {
      const content = `speck Test {
  input: Nat
  satisfies REQ-01 clause "3.1.2"
}`;
      const ast = parseSpeckContent(content);
      const satisfies = ast.specks[0].members.find(m => m.type === 'satisfies');
      expect(satisfies).toBeDefined();
      if (satisfies?.type === 'satisfies') {
        expect(satisfies.requirement).toBe('REQ-01');
        expect(satisfies.clause).toBe('3.1.2');
      }
    });

    it('should parse satisfies without clause', () => {
      const content = `speck Test {
  input: Nat
  satisfies RESILIENCE-REQ-02
}`;
      const ast = parseSpeckContent(content);
      const satisfies = ast.specks[0].members.find(m => m.type === 'satisfies');
      if (satisfies?.type === 'satisfies') {
        expect(satisfies.requirement).toBe('RESILIENCE-REQ-02');
        expect(satisfies.clause).toBeUndefined();
      }
    });
  });

  describe('member parsing - author', () => {
    it('should parse author with name and email', () => {
      const content = `speck Test {
  input: Nat
  author: "Scott Scoble" <"scott@scoble.me">
}`;
      const ast = parseSpeckContent(content);
      const author = ast.specks[0].members.find(m => m.type === 'author');
      expect(author).toBeDefined();
      if (author?.type === 'author') {
        expect(author.name).toBe('Scott Scoble');
        expect(author.email).toBe('scott@scoble.me');
      }
    });
  });

  describe('member parsing - source', () => {
    it('should parse source with kind and ref', () => {
      const content = `speck Test {
  input: Nat
  source: architecture_review ref "AR-2024-0215"
}`;
      const ast = parseSpeckContent(content);
      const source = ast.specks[0].members.find(m => m.type === 'source');
      expect(source).toBeDefined();
      if (source?.type === 'source') {
        expect(source.kind).toBe('architecture_review');
        expect(source.ref).toBe('AR-2024-0215');
      }
    });

    it('should parse source without ref', () => {
      const content = `speck Test {
  input: Nat
  source: meeting
}`;
      const ast = parseSpeckContent(content);
      const source = ast.specks[0].members.find(m => m.type === 'source');
      if (source?.type === 'source') {
        expect(source.kind).toBe('meeting');
      }
    });
  });

  describe('member parsing - events', () => {
    it('should parse event definitions', () => {
      const content = `speck Test {
  input: Nat
  event RetryAttempted {
    attemptNumber: Nat,
    delay: Real
  }
}`;
      const ast = parseSpeckContent(content);
      const event = ast.specks[0].members.find(m => m.type === 'event');
      expect(event).toBeDefined();
    });
  });

  describe('member parsing - bom', () => {
    it('should parse bom declaration', () => {
      const content = `speck Test {
  input: Nat
  bom {
    compiler: "speckl-compile" version "0.2.0"
    license: "MIT"
  }
}`;
      const ast = parseSpeckContent(content);
      const bom = ast.specks[0].members.find(m => m.type === 'bom');
      expect(bom).toBeDefined();
    });
  });

  describe('real-world examples', () => {
    it('should parse RetryHandler-style speck with full annotations', () => {
      const content = `speck RetryHandler {
  bom {
    compiler: "speckl-compile" version "0.2.0"
    solver: "z3" version "4.12.5"
  }
  provenance {
    design_decision: "ADR-0021"
  }
  derives from FaultHandler via "specialization"
  satisfies RESILIENCE-REQ-01 clause "3.1.2"
  author: "Scott Scoble" <"scott@scoble.me">
  source: architecture_review ref "AR-2024-0215"
  review: manual
  input: { operation: Operation, maxRetries: Nat }
  output: { success: Bool }
  constraint: maxRetries <= 10
  constraint: maxRetries >= 0
  verify: always(implies(attempt > 1, delay > 0))
}`;
      const ast = parseSpeckContent(content);
      expect(ast.specks).toHaveLength(1);
      const speck = ast.specks[0];
      expect(speck.name).toBe('RetryHandler');
      
      // Should parse all member types
      const types = speck.members.map(m => m.type);
      expect(types).toContain('bom');
      expect(types).toContain('provenance');
      expect(types).toContain('derives');
      expect(types).toContain('satisfies');
      expect(types).toContain('author');
      expect(types).toContain('source');
      expect(types).toContain('review');
      expect(types).toContain('input');
      expect(types).toContain('output');
      expect(types).toContain('constraint');
      expect(types).toContain('verify');
    });
  });

  describe('member parsing - state machine', () => {
    it('should parse state block with primitive variables', () => {
      const content = `speck ToggleSwitch {
  state: {
    on: Bool := false
    toggleCount: Nat := 0
  }
}`;
      const ast = parseSpeckContent(content);
      const state = ast.specks[0].members.find(m => m.type === 'state');
      expect(state).toBeDefined();
      if (state?.type === 'state') {
        expect(state.variables).toHaveLength(2);
        expect(state.variables[0].name).toBe('on');
        expect(state.variables[0].typeExpr.type).toBe('primitive');
        expect(state.variables[0].typeExpr.name).toBe('Bool');
        expect(state.variables[0].defaultInit).toBe('false');
        expect(state.variables[1].name).toBe('toggleCount');
        expect(state.variables[1].defaultInit).toBe('0');
      }
    });

    it('should parse state block with Set and Map types', () => {
      const content = `speck AccountLedger {
  state: {
    balances: Map<Nat, Real>
    participants: Set<Nat>
  }
}`;
      const ast = parseSpeckContent(content);
      const state = ast.specks[0].members.find(m => m.type === 'state');
      if (state?.type === 'state') {
        expect(state.variables).toHaveLength(2);
        expect(state.variables[0].typeExpr.type).toBe('map');
        expect(state.variables[1].typeExpr.type).toBe('set');
      }
    });

    it('should parse init block', () => {
      const content = `speck Test {
  state: {
    x: Nat
  }
  init: {
    x := 0
  }
}`;
      const ast = parseSpeckContent(content);
      const init = ast.specks[0].members.find(m => m.type === 'init');
      expect(init).toBeDefined();
      if (init?.type === 'init') {
        expect(init.assignments).toHaveLength(1);
        expect(init.assignments[0].name).toBe('x');
        expect(init.assignments[0].expr).toBe('0');
      }
    });

    it('should parse action without parameters', () => {
      const content = `speck Test {
  action Toggle() {
    x := x + 1
  }
}`;
      const ast = parseSpeckContent(content);
      const action = ast.specks[0].members.find(m => m.type === 'action');
      expect(action).toBeDefined();
      if (action?.type === 'action') {
        expect(action.name).toBe('Toggle');
        expect(action.params).toHaveLength(0);
      }
    });

    it('should parse action with parameters', () => {
      const content = `speck Test {
  action Transfer(from: Nat, to: Nat, amount: Real) {
    require from in balances
    balances[from] := balances[from] - amount
  }
}`;
      const ast = parseSpeckContent(content);
      const action = ast.specks[0].members.find(m => m.type === 'action');
      if (action?.type === 'action') {
        expect(action.name).toBe('Transfer');
        expect(action.params).toHaveLength(3);
        expect(action.params[0].name).toBe('from');
        expect(action.params[0].type.type).toBe('primitive');
        expect(action.params[0].type.name).toBe('Nat');
      }
    });

    it('should parse full TigerBeetle speck from file', () => {
      const ast = parseSpeckFile(path.join(__dirname, 'tigerbeetle.speckdl'));
      expect(ast.specks).toHaveLength(1);

      const speck = ast.specks[0];
      expect(speck.name).toBe('TigerBeetle');

      const state = speck.members.find(m => m.type === 'state');
      const init = speck.members.find(m => m.type === 'init');
      const actions = speck.members.filter(m => m.type === 'action');
      const events = speck.members.filter(m => m.type === 'event');
      const constraints = speck.members.filter(m => m.type === 'constraint');
      const verifies = speck.members.filter(m => m.type === 'verify');

      expect(state).toBeDefined();
      expect(init).toBeDefined();
      expect(actions).toHaveLength(4);
      expect(events).toHaveLength(3);
      expect(constraints).toHaveLength(2);
      expect(verifies).toHaveLength(2);

      if (state?.type === 'state') {
        expect(state.variables).toHaveLength(4);
        expect(state.variables[0].name).toBe('nextId');
        expect(state.variables[1].typeExpr.type).toBe('map');
        expect(state.variables[2].typeExpr.type).toBe('set');
      }

      if (init?.type === 'init') {
        expect(init.assignments).toHaveLength(4);
      }

      const createAccount = actions.find(a => a.type === 'action' && a.name === 'CreateAccount');
      expect(createAccount).toBeDefined();
      if (createAccount?.type === 'action') {
        expect(createAccount.params).toHaveLength(1);
        expect(createAccount.statements.length).toBeGreaterThan(0);
      }

      const transfer = actions.find(a => a.type === 'action' && a.name === 'Transfer');
      expect(transfer).toBeDefined();
      if (transfer?.type === 'action') {
        expect(transfer.params).toHaveLength(3);
      }
    });
  });

  // Cycle 57: oneof syntax for proto wire-format discriminated unions.
  describe('oneof blocks (cycle 57)', () => {
    it('should parse a minimal oneof with two variants', () => {
      const content = `speck One {
  oneof Payload {
    create_group: CreateGroup
    add_steward: AddSteward
  }
}`;
      const ast = parseSpeckContent(content);
      const oneof = ast.specks[0].members.find(m => m.type === 'oneof');
      expect(oneof).toBeDefined();
      if (oneof?.type === 'oneof') {
        expect(oneof.name).toBe('Payload');
        expect(oneof.variants).toEqual([
          { fieldName: 'create_group', typeName: 'CreateGroup' },
          { fieldName: 'add_steward', typeName: 'AddSteward' },
        ]);
      }
    });

    it('should tolerate trailing commas / semicolons (proto-style)', () => {
      const content = `speck One {
  oneof Payload {
    create_group: CreateGroup,
    add_steward: AddSteward;
  }
}`;
      const ast = parseSpeckContent(content);
      const oneof = ast.specks[0].members.find(m => m.type === 'oneof');
      if (oneof?.type === 'oneof') {
        expect(oneof.variants).toHaveLength(2);
      }
    });

    it('should skip comments inside oneof blocks', () => {
      const content = `speck One {
  oneof Payload {
    // bootstrap variant
    create_group: CreateGroup
    /* member action */
    add_member: AddMember
  }
}`;
      const ast = parseSpeckContent(content);
      const oneof = ast.specks[0].members.find(m => m.type === 'oneof');
      if (oneof?.type === 'oneof') {
        expect(oneof.variants.map(v => v.fieldName)).toEqual(['create_group', 'add_member']);
      }
    });

    it('should coexist with interface and event blocks', () => {
      const content = `speck Mix {
  event CreateGroup { name: String }
  interface AddSteward { new_steward: String }
  oneof Payload {
    create_group: CreateGroup
    add_steward: AddSteward
  }
}`;
      const ast = parseSpeckContent(content);
      const members = ast.specks[0].members;
      expect(members.filter(m => m.type === 'event')).toHaveLength(1);
      expect(members.filter(m => m.type === 'interface')).toHaveLength(1);
      expect(members.filter(m => m.type === 'oneof')).toHaveLength(1);
    });
  });

  // Cycle 58: transition envelope — a proto message wrapping a oneof payload
  // plus metadata fields. Federated-meetup's `Transition` message is the
  // canonical example: prior_state, payload (oneof), steward_signatures,
  // hlc, branch_id, signed_at.
  describe('transition blocks (cycle 58)', () => {
    it('should parse a minimal transition with regular fields', () => {
      const content = `speck One {
  transition Transition {
    hlc: Bytes
    branch_id: Nat
  }
}`;
      const ast = parseSpeckContent(content);
      const t = ast.specks[0].members.find(m => m.type === 'transition');
      expect(t).toBeDefined();
      if (t?.type === 'transition') {
        expect(t.name).toBe('Transition');
        expect(t.fields.map(f => f.name)).toEqual(['hlc', 'branch_id']);
        expect(t.payloadOneof).toBeUndefined();
        expect(t.typeDiscriminator).toBeUndefined();
      }
    });

    it('should recognize payload: <OneofName> and record the reference', () => {
      const content = `speck One {
  oneof TransitionPayload {
    create_group: CreateGroupPayload
  }
  transition Transition {
    type: TransitionType
    payload: TransitionPayload
    hlc: Bytes
  }
}`;
      const ast = parseSpeckContent(content);
      const t = ast.specks[0].members.find(m => m.type === 'transition');
      if (t?.type === 'transition') {
        expect(t.payloadOneof).toBe('TransitionPayload');
        // payload must NOT appear in fields
        expect(t.fields.map(f => f.name)).toEqual(['hlc']);
        // type is a discriminator reference, not a regular field
        expect(t.typeDiscriminator).toBe('TransitionType');
        expect(t.fields.find(f => f.name === 'type')).toBeUndefined();
      }
    });

    it('should tolerate trailing commas and comments', () => {
      const content = `speck One {
  transition Transition {
    // timestamp from the signer
    signed_at: Timestamp,
    hlc: Bytes;
  }
}`;
      const ast = parseSpeckContent(content);
      const t = ast.specks[0].members.find(m => m.type === 'transition');
      if (t?.type === 'transition') {
        expect(t.fields.map(f => f.name)).toEqual(['signed_at', 'hlc']);
      }
    });
  });

  // Cycle 59: `state as <MessageName> { ... }` to override the
  // .proto generator's default `<SpeckName>State` message name.
  // This unblocks federated-meetup's proto migration: the consumer
  // Go code imports `pb.StateSnapshot`, not `pb.FederatedMeetupState`.
  describe('state as <Name> (cycle 59)', () => {
    it('should record messageName override on StateNode', () => {
      const content = `speck FederatedMeetup {
  state as StateSnapshot {
    branch_id: Nat,
    stewards: StringList
  }
}`;
      const ast = parseSpeckContent(content);
      const state = ast.specks[0].members.find(m => m.type === 'state');
      if (state?.type === 'state') {
        expect(state.messageName).toBe('StateSnapshot');
        expect(state.variables.map(v => v.name)).toEqual(['branch_id', 'stewards']);
      }
    });

    it('should leave messageName undefined when no `as` clause is present', () => {
      const content = `speck FederatedMeetup {
  state: {
    branch_id: Nat
  }
}`;
      const ast = parseSpeckContent(content);
      const state = ast.specks[0].members.find(m => m.type === 'state');
      if (state?.type === 'state') {
        expect(state.messageName).toBeUndefined();
      }
    });
  });

  // Cycle 60: enum interfaces (e.g. CustodyTier) parse as `kind: 'enum'`
  // and the .proto generator emits a real `enum X { ... }` block.
  describe('enum interfaces (cycle 60)', () => {
    it('should classify bare-identifier interfaces as enums', () => {
      const content = `speck FederatedMeetup {
  interface CustodyTier {
    ColdHardware
    HotSigning
    ThresholdSplit
    BackupOnly
    Compromised
  }
}`;
      const ast = parseSpeckContent(content);
      const tier = ast.specks[0].members.find(m => m.name === 'CustodyTier');
      if (tier?.type === 'interface') {
        expect(tier.kind).toBe('enum');
        expect(tier.methods.map(m => m.name)).toEqual([
          'ColdHardware', 'HotSigning', 'ThresholdSplit', 'BackupOnly', 'Compromised'
        ]);
      }
    });
  });

  // Cycle 61: top-of-file `event_suffix:` directive. When set, the .proto
  // generator appends the suffix to every event message name.
  describe('event_suffix directive (cycle 61)', () => {
    it('should record eventSuffix on the SpeckNode', () => {
      const content = `speck FederatedMeetup {
  event_suffix: "Payload"
  event CreateGroup { name: String }
}`;
      const ast = parseSpeckContent(content);
      expect(ast.specks[0].eventSuffix).toBe('Payload');
    });

    it('should leave eventSuffix undefined when not set', () => {
      const content = `speck FederatedMeetup {
  event CreateGroup { name: String }
}`;
      const ast = parseSpeckContent(content);
      expect(ast.specks[0].eventSuffix).toBeUndefined();
    });

    it('should tolerate quoted and bare values', () => {
      const a = parseSpeckContent('speck A {\n  event_suffix: "Payload"\n}');
      const b = parseSpeckContent('speck B {\n  event_suffix: Payload\n}');
      expect(a.specks[0].eventSuffix).toBe('Payload');
      expect(b.specks[0].eventSuffix).toBe('Payload');
    });
  });

  // Cycle 62: inline `//` comments on field declarations were bleeding
  // into the type expression. Real federated-meetup had:
  //   mesh_ip: Bytes   // 4 bytes (IPv4 overlay)
  // emitted as `Bytes   // 4 bytes (IPv4 overlay) mesh_ip = 2;` —
  // broken syntax. The fix strips the comment before parsing the type.
  describe('inline comment stripping (cycle 62)', () => {
    it('should strip inline // comments from event field types', () => {
      const content = `speck One {
  event InitialMeshPeer {
    host_wg_key: Bytes,  // 32 bytes
    mesh_ip: Bytes   // 4 bytes (IPv4 overlay)
  }
}`;
      const ast = parseSpeckContent(content);
      const ev = ast.specks[0].members.find(m => m.name === 'InitialMeshPeer');
      if (ev?.type === 'event') {
        const meshIp = ev.fields.find(f => f.name === 'mesh_ip');
        expect(meshIp?.type.name).toBe('Bytes');
        expect(meshIp?.type.name).not.toContain('IPv4');
      }
    });

    it('should strip inline // comments from interface field types', () => {
      const content = `speck One {
  interface InitialMeshPeer {
    host_wg_key: Bytes,  // X25519
    mesh_ip: Bytes   // 4 bytes (IPv4 overlay)
  }
}`;
      const ast = parseSpeckContent(content);
      const iface = ast.specks[0].members.find(m => m.name === 'InitialMeshPeer');
      if (iface?.type === 'interface') {
        const meshIp = iface.fields.find(f => f.name === 'mesh_ip');
        expect(meshIp?.type.name).toBe('Bytes');
        expect(meshIp?.type.name).not.toContain('IPv4');
      }
    });
  });

  // Cycle 63: 'state as <Name> { ... }' must dispatch through the
  // same parseStateBlockMultiline path as 'state: { ... }'. Cycle 59
  // added the parser-side extraction of the `as` clause; this test
  // confirms the block-dispatcher also routes the new header form.
  describe('state as <Name> dispatch (cycle 63)', () => {
    it('should dispatch state as StateSnapshot to parseStateBlockMultiline', () => {
      const content = `speck FederatedMeetup {
  state as StateSnapshot {
    branch_id: Nat
  }
}`;
      const ast = parseSpeckContent(content);
      const state = ast.specks[0].members.find(m => m.type === 'state');
      if (state?.type === 'state') {
        expect(state.messageName).toBe('StateSnapshot');
        expect(state.variables.map(v => v.name)).toEqual(['branch_id']);
      }
    });
  });

  // Cycle 65: default-value syntax `= <expr>` on event fields was
  // bleeding into the type expression. Real federated-meetup has
  //   initial_mesh_peers: List<InitialMeshPeer> = []
  // emitted as `List<InitialMeshPeer> = [] initial_mesh_peers = 1;`
  // which protoc rejects. The fix strips `= <expr>` from the type
  // before parsing (the default is a Speckl semantic; the .proto wire
  // format has no place for it).
  describe('default value stripping (cycle 65)', () => {
    it('should strip `= []` from event field type expressions', () => {
      const content = `speck One {
  event CreateGroup {
    initial_mesh_peers: List<InitialMeshPeer> = []
  }
}`;
      const ast = parseSpeckContent(content);
      const ev = ast.specks[0].members.find(m => m.name === 'CreateGroup');
      if (ev?.type === 'event') {
        const f = ev.fields[0];
        expect(f.name).toBe('initial_mesh_peers');
        expect(f.type.type).toBe('list');
        expect(f.type.elementType?.name).toBe('InitialMeshPeer');
        // The full type string should not contain '= []' anywhere — verify
        // via the elementType name and the parent's name (both undefined
        // for List, so we check the parser did not preserve the default
        // in any visible field).
        const asAny = f.type as any;
        expect(JSON.stringify(asAny)).not.toContain('= []');
      }
    });
  });

  // Cycle 73: List<T> fields in interface records must be preserved in the AST.
  // Previously the generator emitted empty type for these fields because
  // it called speckTypeToProto(f.type.name) which returns '' when .name is
  // undefined (List/Map/Set nodes use .elementType/.keyType/.valueType,
  // not .name). The generator was fixed, but this test locks in the parser
  // behavior so a regression is caught early.
  describe('List<T> in interface record fields (cycle 73)', () => {
    it('should parse List<T> fields in interface records', () => {
      const content = `speck One {
  interface Container {
    items: List<Ticket>,
    names: List<String>
  }
  interface Ticket {
    id: String
  }
}`;
      const ast = parseSpeckContent(content);
      const iface = ast.specks[0].members.find(m => m.name === 'Container');
      expect(iface).toBeDefined();
      if (iface?.type === 'interface') {
        expect(iface.fields).toBeDefined();
        expect(iface.fields.length).toBe(2);
        expect(iface.fields[0].name).toBe('items');
        expect(iface.fields[0].type.type).toBe('list');
        expect(iface.fields[0].type.elementType?.name).toBe('Ticket');
        expect(iface.fields[1].name).toBe('names');
        expect(iface.fields[1].type.type).toBe('list');
        expect(iface.fields[1].type.elementType?.name).toBe('String');
      }
    });
  });
});
