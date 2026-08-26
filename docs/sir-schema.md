# Speckl Structured Intermediate Representation (SIR) — Schema Design

## Overview

The SIR is the central data structure in the Speckl pipeline. It bridges chaotic human/agent conversation and deterministic compilation:

```
Chaotic Conversation → [Extraction Layer] → SIR → [Validation Layer] → [Compilation Layer]
```

Everything flows through the SIR. It is the single source of truth — the document being edited by conversation and compiled into artifacts.

### Design Principles

1. **Domain-agnostic core, domain-specific leaves.** The SIR has a universal structure (elements, constraints, provenance) with domain-specific element types and validators.
2. **Provenance is first-class.** Every element, every property, every constraint traces back to the conversation turn that produced it. Nothing is untraceable.
3. **Confidence is quantified.** Every element carries a confidence score. Compilation can be gated on confidence thresholds.
4. **Content-addressed, not clock-addressed.** The SIR is versioned by content hash, not timestamps. Determinism depends on this.
5. **Incrementally updateable.** The SIR is a mutable document that conversation refines over time, with full diff tracking.
6. **Wire-friendly.** JSON as the primary serialization format with a defined schema.

---

## 1. Core Structure

### 1.1 The SIR Document

```typescript
interface SIRDocument {
  // Identity
  sirId: string;                   // UUID, stable for the lifetime of this specification
  sirVersion: number;              // Monotonic counter, incremented on every mutation
  sirHash: string;                 // sha256 of the canonical JSON (computed on save)

  // Declaration
  schemaVersion: "1.0.0";         // SIR schema version (not the spec version)
  domain: DomainDeclaration;

  // Content
  elements: Record<string, SIRElement>;  // elementId → element
  constraints: SIRConstraint[];          // cross-element constraints
  composition: CompositionRule[];        // how elements compose

  // Metadata
  metadata: SIRMetadata;
}

interface SIRMetadata {
  title: string;                   // Human-readable name: "Login Flow", "User Profile Schema"
  description: string;             // Free-text description of what this spec defines
  tags: string[];                  // For searchability: ["auth", "security", "login"]
  createdAt: number;               // Unix ms
  updatedAt: number;               // Unix ms
  createdBy: string;               // agentId or "human"
  conversationId?: string;         // Link to the conversation that produced this
  readiness: ReadinessLevel;
}

type ReadinessLevel = "draft" | "functional" | "validated" | "locked";
```

### 1.2 Concrete JSON Example — Empty SIR

```json
{
  "sirId": "b8d4f3a2-1c6e-4f89-a3e7-2b1c5d9f0a4e",
  "sirVersion": 1,
  "sirHash": "sha256:e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
  "schemaVersion": "1.0.0",
  "domain": {
    "primary": "state-machine",
    "version": "1.0.0",
    "secondary": []
  },
  "elements": {},
  "constraints": [],
  "composition": [],
  "metadata": {
    "title": "Untitled Specification",
    "description": "",
    "tags": [],
    "createdAt": 1778392000000,
    "updatedAt": 1778392000000,
    "createdBy": "agent-engineering",
    "readiness": "draft"
  }
}
```

---

## 2. Element Model

### 2.1 What Is a Specification Element?

A specification element is a typed, identified node in the SIR graph. Every element has a common header and domain-specific properties. Elements reference each other, forming a directed graph.

### 2.2 The Common Header

```typescript
interface SIRElement {
  // Identity
  id: string;                      // UUID, stable across revisions
  elementType: string;             // Domain-specific type: "state", "transition", "table", "step", etc.

  // Lifecycle
  status: ElementStatus;
  version: number;                 // Monotonic counter for this element

  // Provenance
  provenance: ProvenanceChain;

  // Content
  label: string;                   // Human-readable: "Logged Out", "User Table"
  description: string;             // Natural language: what is this, why does it exist
  properties: Record<string, PropertyValue>;  // Typed key-value store

  // Relationships
  references: ElementReference[];  // What this element points to
  subElements: string[];           // Child element IDs (composition)

  // Confidence
  confidence: number;              // 0.0 – 1.0
  confidenceBreakdown: ConfidenceBreakdown;

  // Flags
  flags: ElementFlags;

  // Timestamps
  createdAt: number;
  updatedAt: number;
}

type ElementStatus =
  | "proposed"       // Extracted from conversation, not yet confirmed
  | "draft"          // Confirmed but incomplete
  | "validated"      // Passed validation
  | "locked"         // Cannot be modified (compiled artifact references this)
  | "deprecated"     // Superseded by newer element
  | "rejected";      // Human explicitly rejected this extraction
```

### 2.3 Property Values

Properties are typed so validators and compilers can reason about them:

```typescript
type PropertyValue =
  | { type: "string"; value: string }
  | { type: "number"; value: number }
  | { type: "boolean"; value: boolean }
  | { type: "enum"; value: string; allowedValues: string[] }
  | { type: "reference"; value: string; targetType: string }
  | { type: "array"; value: PropertyValue[]; itemType: string }
  | { type: "code"; value: string; language: string }
  | { type: "expression"; value: string; expressionType: string };

// Each property value includes its own provenance, confidence, and flags
interface PropertyValue {
  type: PropertyType;
  value: any;
  confidence: number;
  provenance: ProvenanceChain;      // Who set this value, when
  flags: { tentative: boolean; needsReview: boolean };
}
```

### 2.4 Element References

References form the graph:

```typescript
interface ElementReference {
  refId: string;                    // Target element ID
  refType: string;                  // What kind of reference: "target", "parent", "depends_on", "implements"
  label: string;                    // Human-readable: "goes to", "belongs to", "validates"
  cardinality: string;              // "1", "0..1", "1..n", "0..n"
  conditions?: string;              // When this reference is active: "when guard evaluates true"
  confidence: number;
  provenance: ProvenanceChain;
}
```

### 2.5 ElementFlags

```typescript
interface ElementFlags {
  needsReview: boolean;
  isAmbiguous: boolean;
  isTentative: boolean;
  isContradicted: boolean;
  sourceIsExplicit: boolean;
  hasGaps: boolean;                 // Missing required properties
}
```

### 2.6 Confidence Breakdown

Confidence isn't just a single number — it decomposes:

```typescript
interface ConfidenceBreakdown {
  overall: number;
  factors: {
    explicitMarker: number;         // 0–1: strength of explicit extraction cues
    structuralPattern: number;      // 0–1: how well the text matches known patterns
    consistency: number;            // 0–1: consistency with rest of SIR
    speakerAuthority: number;       // 0–1: human (0.9) vs agent (0.6) vs debated (0.4)
    repetition: number;             // 0–1: mentioned across multiple turns
  };
  lastEvaluated: number;            // Unix ms
}
```

### 2.7 Concrete JSON Example — State Machine Elements

A login flow with states, transitions, and guards:

```json
{
  "state-logged-out": {
    "id": "state-logged-out",
    "elementType": "state",
    "status": "validated",
    "version": 1,
    "provenance": {
      "entries": [
        {
          "turnId": "turn-3",
          "action": "extracted",
          "agentId": "agent-engineering",
          "humanConfirmed": true,
          "timestamp": 1778392100000,
          "confidenceAtTime": 0.92,
          "extractionRationale": "Explicit state declaration with spec: prefix"
        }
      ]
    },
    "label": "Logged Out",
    "description": "User is not authenticated. Entry point for the login flow.",
    "properties": {
      "isInitial": { "type": "boolean", "value": true },
      "isTerminal": { "type": "boolean", "value": false }
    },
    "references": [
      { "refId": "transition-login-submit", "refType": "outgoing", "label": "on submit", "cardinality": "1" }
    ],
    "subElements": [],
    "confidence": 0.92,
    "confidenceBreakdown": {
      "overall": 0.92,
      "factors": {
        "explicitMarker": 1.0,
        "structuralPattern": 0.95,
        "consistency": 0.90,
        "speakerAuthority": 0.90,
        "repetition": 0.85
      },
      "lastEvaluated": 1778392100000
    },
    "flags": {
      "needsReview": false,
      "isAmbiguous": false,
      "isTentative": false,
      "isContradicted": false,
      "sourceIsExplicit": true,
      "hasGaps": false
    },
    "createdAt": 1778392100000,
    "updatedAt": 1778392100000
  },

  "state-logging-in": {
    "id": "state-logging-in",
    "elementType": "state",
    "status": "validated",
    "version": 1,
    "provenance": {
      "entries": [
        {
          "turnId": "turn-5",
          "action": "extracted",
          "agentId": "agent-engineering",
          "humanConfirmed": false,
          "timestamp": 1778392150000,
          "confidenceAtTime": 0.78,
          "extractionRationale": "Implicit from 'while the credentials are being checked' description"
        }
      ]
    },
    "label": "Logging In",
    "description": "Credentials submitted, awaiting authentication result.",
    "properties": {
      "isInitial": { "type": "boolean", "value": false },
      "isTerminal": { "type": "boolean", "value": false },
      "timeout": { "type": "number", "value": 30000 },
      "timeoutAction": { "type": "string", "value": "return error to user" }
    },
    "references": [
      { "refId": "transition-credential-check", "refType": "incoming", "label": "entered from", "cardinality": "1" },
      { "refId": "transition-auth-success", "refType": "outgoing", "label": "on success", "cardinality": "1" },
      { "refId": "transition-auth-failure", "refType": "outgoing", "label": "on failure", "cardinality": "1" },
      { "refId": "transition-auth-timeout", "refType": "outgoing", "label": "on timeout", "cardinality": "0..1" }
    ],
    "subElements": [],
    "confidence": 0.78,
    "confidenceBreakdown": {
      "overall": 0.78,
      "factors": {
        "explicitMarker": 0.30,
        "structuralPattern": 0.80,
        "consistency": 0.90,
        "speakerAuthority": 0.90,
        "repetition": 0.60
      },
      "lastEvaluated": 1778392150000
    },
    "flags": {
      "needsReview": true,
      "isAmbiguous": false,
      "isTentative": true,
      "isContradicted": false,
      "sourceIsExplicit": false,
      "hasGaps": false
    },
    "createdAt": 1778392150000,
    "updatedAt": 1778392150000
  },

  "state-authenticated": {
    "id": "state-authenticated",
    "elementType": "state",
    "status": "validated",
    "version": 1,
    "provenance": {
      "entries": [
        {
          "turnId": "turn-3",
          "action": "extracted",
          "agentId": "agent-engineering",
          "humanConfirmed": true,
          "timestamp": 1778392100000,
          "confidenceAtTime": 0.95,
          "extractionRationale": "Explicit state declaration with spec: prefix"
        }
      ]
    },
    "label": "Authenticated",
    "description": "User has valid session. The 'inside' state for the application.",
    "properties": {
      "isInitial": { "type": "boolean", "value": false },
      "isTerminal": { "type": "boolean", "value": false },
      "sessionDuration": { "type": "number", "value": 3600000 },
      "onEntry": { "type": "code", "value": "createSession(user); redirect('/dashboard')", "language": "pseudocode" }
    },
    "references": [
      { "refId": "transition-auth-success", "refType": "incoming", "label": "entered via", "cardinality": "1" },
      { "refId": "transition-logout", "refType": "outgoing", "label": "on logout", "cardinality": "1" },
      { "refId": "transition-session-expire", "refType": "outgoing", "label": "on expiry", "cardinality": "1" }
    ],
    "subElements": [],
    "confidence": 0.95,
    "confidenceBreakdown": {
      "overall": 0.95,
      "factors": {
        "explicitMarker": 1.0,
        "structuralPattern": 0.95,
        "consistency": 0.95,
        "speakerAuthority": 0.90,
        "repetition": 0.90
      },
      "lastEvaluated": 1778392100000
    },
    "flags": {
      "needsReview": false,
      "isAmbiguous": false,
      "isTentative": false,
      "isContradicted": false,
      "sourceIsExplicit": true,
      "hasGaps": false
    },
    "createdAt": 1778392100000,
    "updatedAt": 1778392100000
  },

  "state-locked-out": {
    "id": "state-locked-out",
    "elementType": "state",
    "status": "validated",
    "version": 1,
    "provenance": {
      "entries": [
        {
          "turnId": "turn-8",
          "action": "extracted",
          "agentId": "agent-engineering",
          "humanConfirmed": true,
          "timestamp": 1778392250000,
          "confidenceAtTime": 0.88,
          "extractionRationale": "Extracted from 'after 3 failed attempts, lock the account for 15 minutes'"
        }
      ]
    },
    "label": "Locked Out",
    "description": "Account temporarily locked after too many failed attempts.",
    "properties": {
      "isInitial": { "type": "boolean", "value": false },
      "isTerminal": { "type": "boolean", "value": false },
      "lockDuration": { "type": "number", "value": 900000 },
      "maxAttempts": { "type": "number", "value": 3 }
    },
    "references": [
      { "refId": "transition-auth-failure", "refType": "incoming", "label": "entered via", "cardinality": "1" },
      { "refId": "transition-lock-expire", "refType": "outgoing", "label": "on expiry", "cardinality": "1" }
    ],
    "subElements": [],
    "confidence": 0.88,
    "confidenceBreakdown": {
      "overall": 0.88,
      "factors": {
        "explicitMarker": 0.60,
        "structuralPattern": 0.90,
        "consistency": 0.90,
        "speakerAuthority": 0.90,
        "repetition": 0.75
      },
      "lastEvaluated": 1778392250000
    },
    "flags": {
      "needsReview": false,
      "isAmbiguous": false,
      "isTentative": false,
      "isContradicted": false,
      "sourceIsExplicit": false,
      "hasGaps": false
    },
    "createdAt": 1778392250000,
    "updatedAt": 1778392250000
  },

  "transition-login-submit": {
    "id": "transition-login-submit",
    "elementType": "transition",
    "status": "validated",
    "version": 1,
    "provenance": {
      "entries": [
        {
          "turnId": "turn-4",
          "action": "extracted",
          "agentId": "agent-engineering",
          "humanConfirmed": true,
          "timestamp": 1778392120000,
          "confidenceAtTime": 0.94,
          "extractionRationale": "Explicit transition declared: 'when user submits credentials, transition to logging-in'"
        }
      ]
    },
    "label": "Submit Credentials",
    "description": "User submits username/password from login form.",
    "properties": {
      "trigger": { "type": "string", "value": "form_submit" },
      "from": { "type": "reference", "value": "state-logged-out", "targetType": "state" },
      "to": { "type": "reference", "value": "state-logging-in", "targetType": "state" }
    },
    "references": [],
    "subElements": ["guard-validate-input"],
    "confidence": 0.94,
    "confidenceBreakdown": {
      "overall": 0.94,
      "factors": {
        "explicitMarker": 1.0,
        "structuralPattern": 0.95,
        "consistency": 0.95,
        "speakerAuthority": 0.90,
        "repetition": 0.90
      },
      "lastEvaluated": 1778392120000
    },
    "flags": {
      "needsReview": false,
      "isAmbiguous": false,
      "isTentative": false,
      "isContradicted": false,
      "sourceIsExplicit": true,
      "hasGaps": false
    },
    "createdAt": 1778392120000,
    "updatedAt": 1778392120000
  },

  "transition-credential-check": {
    "id": "transition-credential-check",
    "elementType": "transition",
    "status": "validated",
    "version": 1,
    "provenance": {
      "entries": [
        {
          "turnId": "turn-5",
          "action": "extracted",
          "agentId": "agent-engineering",
          "humanConfirmed": false,
          "timestamp": 1778392150000,
          "confidenceAtTime": 0.65,
          "extractionRationale": "Inferred intermediate step between submit and auth result"
        }
      ]
    },
    "label": "Check Credentials",
    "description": "System validates credentials against auth provider.",
    "properties": {
      "trigger": { "type": "string", "value": "internal" },
      "from": { "type": "reference", "value": "state-logging-in", "targetType": "state" },
      "action": { "type": "code", "value": "authProvider.verify(username, password)", "language": "pseudocode" }
    },
    "references": [],
    "subElements": [],
    "confidence": 0.65,
    "confidenceBreakdown": {
      "overall": 0.65,
      "factors": {
        "explicitMarker": 0.10,
        "structuralPattern": 0.70,
        "consistency": 0.80,
        "speakerAuthority": 0.60,
        "repetition": 0.30
      },
      "lastEvaluated": 1778392150000
    },
    "flags": {
      "needsReview": true,
      "isAmbiguous": false,
      "isTentative": true,
      "isContradicted": false,
      "sourceIsExplicit": false,
      "hasGaps": true
    },
    "createdAt": 1778392150000,
    "updatedAt": 1778392150000
  },

  "transition-auth-success": {
    "id": "transition-auth-success",
    "elementType": "transition",
    "status": "validated",
    "version": 1,
    "provenance": {
      "entries": [
        {
          "turnId": "turn-6",
          "action": "extracted",
          "agentId": "agent-engineering",
          "humanConfirmed": true,
          "timestamp": 1778392180000,
          "confidenceAtTime": 0.96,
          "extractionRationale": "Explicit: 'if credentials valid, go to authenticated'"
        }
      ]
    },
    "label": "Auth Success",
    "description": "Credentials are valid. Transition to authenticated state.",
    "properties": {
      "trigger": { "type": "string", "value": "auth_success" },
      "from": { "type": "reference", "value": "state-logging-in", "targetType": "state" },
      "to": { "type": "reference", "value": "state-authenticated", "targetType": "state" }
    },
    "references": [],
    "subElements": ["guard-credentials-valid"],
    "confidence": 0.96,
    "confidenceBreakdown": {
      "overall": 0.96,
      "factors": {
        "explicitMarker": 1.0,
        "structuralPattern": 0.95,
        "consistency": 0.95,
        "speakerAuthority": 0.90,
        "repetition": 0.95
      },
      "lastEvaluated": 1778392180000
    },
    "flags": {
      "needsReview": false,
      "isAmbiguous": false,
      "isTentative": false,
      "isContradicted": false,
      "sourceIsExplicit": true,
      "hasGaps": false
    },
    "createdAt": 1778392180000,
    "updatedAt": 1778392180000
  },

  "guard-credentials-valid": {
    "id": "guard-credentials-valid",
    "elementType": "guard",
    "status": "validated",
    "version": 1,
    "provenance": {
      "entries": [
        {
          "turnId": "turn-6",
          "action": "extracted",
          "agentId": "agent-engineering",
          "humanConfirmed": true,
          "timestamp": 1778392180000,
          "confidenceAtTime": 0.96,
          "extractionRationale": "Guard condition: credentials valid"
        }
      ]
    },
    "label": "Credentials Valid",
    "description": "Username exists and password hash matches.",
    "properties": {
      "condition": { "type": "expression", "value": "user.exists AND password.hash == stored.hash", "expressionType": "boolean" }
    },
    "references": [
      { "refId": "transition-auth-success", "refType": "guards", "label": "guards transition", "cardinality": "1" }
    ],
    "subElements": [],
    "confidence": 0.96,
    "confidenceBreakdown": {
      "overall": 0.96,
      "factors": {
        "explicitMarker": 1.0,
        "structuralPattern": 0.95,
        "consistency": 0.95,
        "speakerAuthority": 0.90,
        "repetition": 0.90
      },
      "lastEvaluated": 1778392180000
    },
    "flags": {
      "needsReview": false,
      "isAmbiguous": false,
      "isTentative": false,
      "isContradicted": false,
      "sourceIsExplicit": true,
      "hasGaps": false
    },
    "createdAt": 1778392180000,
    "updatedAt": 1778392180000
  }
}
```

---

## 3. Domain System

### 3.1 Domain Declaration

Every SIR declares its domain. A domain defines what element types, constraints, and composition rules are valid.

```typescript
interface DomainDeclaration {
  primary: string;                  // "state-machine", "data-schema", "workflow", "protocol"
  version: string;                  // Domain schema version: "1.0.0"
  secondary: string[];              // Cross-reference domains: ["api-interface"]
}
```

### 3.2 Domain Primitives

Each domain defines its element types, their required properties, and their semantics:

**State Machine Domain (`state-machine@1.0.0`):**

| Element Type | Description | Required Properties |
|---|---|---|
| `state` | A distinct condition or mode the system can be in | `isInitial`, `isTerminal` |
| `transition` | A directed edge between states, triggered by an event | `from`, `to`, `trigger` |
| `guard` | A boolean condition evaluated before taking a transition | `condition` |
| `event` | An external or internal occurrence that may trigger transitions | `type`, `payload` |
| `action` | A side effect executed on entry, exit, or during a transition | `phase` (entry/exit/during), `code` |
| `invariant` | A condition that must always hold in a given state | `expression` |

**Data Schema Domain (`data-schema@1.0.0`):**

| Element Type | Description | Required Properties |
|---|---|---|
| `entity` | A structured data type (table, document, object) | `name` |
| `field` | A named property within an entity | `name`, `type`, `nullable` |
| `relation` | A relationship between entities | `from`, `to`, `kind` (one-to-one/one-to-many/many-to-many) |
| `index` | A search/ordering structure on fields | `fields`, `unique` |
| `constraint` | A data integrity rule | `expression`, `kind` (check/unique/foreign-key) |
| `enum` | A constrained set of values | `name`, `values` |

**Workflow Domain (`workflow@1.0.0`):**

| Element Type | Description | Required Properties |
|---|---|---|
| `step` | A unit of work in a process | `name`, `actor` (human/system/both) |
| `decision` | A branching point | `condition`, `branches` |
| `fork` | Parallel execution split | `branches` |
| `join` | Parallel execution merge | `incoming` |
| `event` | A signal within the workflow | `type` (start/end/message/timer/error) |

### 3.3 Domain Versioning

When a domain schema changes (e.g., `state-machine@1.0.0` → `state-machine@1.1.0`), existing SIRs carry their declared domain version. The compiler resolves the appropriate domain validator and compiler plugins for that version.

```json
{
  "domain": {
    "primary": "state-machine",
    "version": "1.0.0"
  }
}
```

A migration path exists when a domain upgrades:

```typescript
interface DomainUpgradePath {
  from: string;          // "state-machine@1.0.0"
  to: string;            // "state-machine@1.1.0"
  migration: (sir: SIRDocument) => SIRDocument;  // Transform function
  breakingChanges: string[];
}
```

### 3.4 Multi-Domain SIR

A SIR can declare secondary domains for cross-domain references:

```json
{
  "domain": {
    "primary": "state-machine",
    "version": "1.0.0",
    "secondary": ["api-interface@1.0.0"]
  }
}
```

This allows a state machine to reference an API endpoint specification for its actions, or a workflow to reference a data schema for its payload types. Cross-domain references carry an explicit domain prefix:

```json
{
  "id": "some-action",
  "elementType": "action",
  "references": [
    {
      "refId": "api-interface:endpoint-create-session",
      "refType": "calls",
      "label": "creates session via",
      "cardinality": "1"
    }
  ]
}
```

---

## 4. Constraint Model

### 4.1 Constraint Types

Constraints encode the formal rules the specification must satisfy:

```typescript
type SIRConstraint =
  | TypeConstraint
  | ReferenceConstraint
  | InvariantConstraint
  | TemporalConstraint
  | RelationalConstraint;

// "field 'email' must be a valid email string"
interface TypeConstraint {
  kind: "type";
  target: string;                  // Element or property path: "entity-user.field-email"
  check: string;                   // Expression: "matches(email_pattern)"
}

// "transition 'auth-success' must have a target state"
interface ReferenceConstraint {
  kind: "reference";
  source: string;                  // Element ID
  refType: string;                 // Which reference: "to", "from"
  mustExist: boolean;
  mustBeType?: string;             // Optional: reference must point to this type
}

// "user.email must be unique across all users"
interface InvariantConstraint {
  kind: "invariant";
  target: string;                  // Element or element set
  expression: string;              // Formal expression: "forall u1,u2: u1.id != u2.id => u1.email != u2.email"
  language: "speckl-expr" | "fol";
}

// "after 'payment-submitted' state, eventually 'payment-confirmed'"
interface TemporalConstraint {
  kind: "temporal";
  formula: string;                 // "G(payment-submitted => F payment-confirmed)"
  logic: "LTL" | "CTL";
}

// "field-email must be indexed if entity-user has more than N records"
interface RelationalConstraint {
  kind: "relational";
  expression: string;              // "entity-user.cardinality > 1000000 => exists(index-email)"
}
```

### 4.2 Constraint Expression Language

Constraints use a readable expression language that maps to formal verification:

```
Expression → Comparison | Logical | Quantified | Reference

Comparison → value OPERATOR value
  OPERATOR → == | != | < | > | <= | >= | matches | contains

Logical → expr AND expr | expr OR expr | NOT expr

Quantified → forall VAR in SET: expr | exists VAR in SET: expr

Reference → elementId.property | elementId (boolean, exists check)
```

Examples:
```
"state-logging-in.isInitial == false"
"transition-auth-success.to exists AND transition-auth-success.to == state-authenticated"
"forall t in transitions: t.from exists AND t.to exists"
"not exists s1,s2 in states: s1.isInitial == true AND s2.isInitial == true"   // exactly one initial state
```

### 4.3 Constraint Attachment

Every constraint carries provenance and confidence:

```typescript
interface SIRConstraint {
  id: string;
  kind: string;
  // ... type-specific fields ...

  // Metadata
  severity: "error" | "warning" | "info";
  confidence: number;
  provenance: ProvenanceChain;
  humanConfirmed: boolean;

  // Resolution
  resolved: boolean;               // True if validation passes
  resolvedAt?: number;
  resolutionNote?: string;
}
```

### 4.4 Constraint Composition

When elements compose (e.g., a state machine contains sub-state-machines), constraints compose hierarchically:

- A constraint on a parent element implies constraints on all children
- A constraint satisfied at the child level satisfies it at the parent level (if the constraint is existential)
- Conflicting constraints at different levels produce a validation error

```typescript
interface CompositionRule {
  kind: "contains" | "requires" | "excludes" | "parallel-to" | "sequence-of";
  parent: string;                  // Parent element ID
  children: string[];              // Child element IDs
  constraints: SIRConstraint[];    // Constraints on this composition
  provenance: ProvenanceChain;
}
```

---

## 5. Provenance Model

### 5.1 ProvenanceChain

Every element, every property, every constraint has a provenance chain. This is the foundation of NIST SA-11 traceability:

```typescript
interface ProvenanceChain {
  entries: ProvenanceEntry[];
}

interface ProvenanceEntry {
  turnId: string;                  // ConversationTurn UUID that produced this
  action: ProvenanceAction;
  agentId?: string;                // Which agent performed the action (or "human")
  humanConfirmed: boolean;         // Did the human explicitly sign off?
  timestamp: number;               // Unix ms
  confidenceAtTime: number;        // Confidence snapshot at this entry
  extractionRationale?: string;    // Why was this extracted/modified?
  diff?: SIRDiff;                  // For refined/updated actions: what changed
}

type ProvenanceAction =
  | "extracted"                    // First created from conversation
  | "refined"                      // Incremental update, same element
  | "confirmed"                    // Human explicitly confirmed
  | "deprecated"                   // No longer valid, superseded
  | "rejected"                     // Human said this extraction was wrong
  | "merged"                       // Result of merging two SIR versions
  | "imported";                    // Imported from external source
```

### 5.2 Provenance Chains

Elements refined across multiple turns accumulate a chain:

```json
{
  "id": "state-logging-in",
  "provenance": {
    "entries": [
      {
        "turnId": "turn-5",
        "action": "extracted",
        "agentId": "agent-engineering",
        "humanConfirmed": false,
        "timestamp": 1778392150000,
        "confidenceAtTime": 0.45,
        "extractionRationale": "Detected 'while checking credentials' as an implicit intermediate state"
      },
      {
        "turnId": "turn-7",
        "action": "refined",
        "agentId": "human",
        "humanConfirmed": true,
        "timestamp": 1778392220000,
        "confidenceAtTime": 0.85,
        "diff": {
          "changedProperties": ["timeout", "timeoutAction"],
          "addedReferences": ["transition-auth-timeout"]
        },
        "extractionRationale": "Scott: 'Add a 30-second timeout to the logging-in state, show an error if it fires'"
      },
      {
        "turnId": "turn-12",
        "action": "confirmed",
        "agentId": "human",
        "humanConfirmed": true,
        "timestamp": 1778392400000,
        "confidenceAtTime": 1.0,
        "extractionRationale": "Scott: 'Yeah, the login flow looks right now.'"
      }
    ]
  }
}
```

### 5.3 Confidence Tracking

Confidence is tracked both at the element level and at the property level. A low-confidence property on a high-confidence element is flagged:

```json
{
  "id": "state-logging-in",
  "confidence": 0.85,
  "properties": {
    "timeout": {
      "type": "number",
      "value": 30000,
      "confidence": 0.60,
      "provenance": {
        "entries": [{
          "turnId": "turn-7",
          "action": "extracted",
          "agentId": "agent-engineering",
          "humanConfirmed": false,
          "extractionRationale": "Implicit: Scott mentioned '30 seconds' — extracted as ms"
        }]
      }
    }
  }
}
```

---

## 6. Versioning and Diffing

### 6.1 SIR Versioning

The SIR version is a content-hash-based identifier for integrity, plus a monotonic counter for human convenience:

```
sirVersion: 14          // Monotonic, incremented on every save
sirHash: "sha256:a7f3..." // Content hash of the canonical JSON
```

The `sirHash` is computed over the canonical JSON with all elements sorted by ID, minus the `sirHash` field itself and any timestamps (which are informational, not deterministic inputs).

### 6.2 Element-Level Diffs

```typescript
interface SIRDiff {
  // What changed
  addedElements: string[];            // Element IDs
  removedElements: string[];
  modifiedElements: Record<string, {
    changedProperties: string[];      // Property keys
    addedReferences: string[];
    removedReferences: string[];
    changedConstraints: string[];
    confidenceDelta: number;          // +0.15 or -0.10
  }>;
  reorderedElements: { before: string[]; after: string[] };

  // Metadata
  fromSirVersion: number;
  toSirVersion: number;
  fromSirHash: string;
  toSirHash: string;
  timestamp: number;
}
```

### 6.3 Merge Semantics

Two SIR versions can be merged when they derive from a common ancestor. Conflicts arise when both branches modify the same element property:

```typescript
interface SIRMergeResult {
  success: boolean;
  merged: SIRDocument;
  conflicts: SIRMergeConflict[];
}

interface SIRMergeConflict {
  elementId: string;
  property: string;
  branchA: PropertyValue;            // Value from first branch
  branchB: PropertyValue;            // Value from second branch
  ancestor: PropertyValue;           // Original value before branching
  resolution?: PropertyValue;        // Human-chosen resolution
}
```

Conflicts are represented directly in the SIR so conversation can resolve them — the agent surfaces the conflict and asks the human which value is correct.

---

## 7. Serialization

### 7.1 Primary Format: JSON

The canonical serialization is JSON with a fixed key ordering for deterministic hashing:

```json
{
  "sirId": "",
  "sirVersion": 0,
  "sirHash": "",
  "schemaVersion": "",
  "domain": {},
  "elements": {},
  "constraints": [],
  "composition": [],
  "metadata": {}
}
```

Elements within `elements` are keyed by their stable ID. Constraints and composition rules are arrays ordered by ID.

### 7.2 Binary Format (Optional)

For large SIRs, a CBOR-based binary format can be used for transmission. The canonical representation for hashing is always JSON.

### 7.3 Human-Readable Summary

For display in conversation, the SIR can render as a summary:

```
📋 **Login Flow** (state-machine@1.0.0) · v14 · sha256:a7f3...

**States (4):**
🟢 Logged Out (initial) · confidence 0.92 ✅
🔄 Logging In · confidence 0.85 ⚠️
🔒 Authenticated · confidence 0.95 ✅
🚫 Locked Out · confidence 0.88 ✅

**Transitions (5):**
→ Submit Credentials: logged-out → logging-in [trigger: form_submit]
→ Check Credentials: logging-in → (internal) [needs target] ⚠️
→ Auth Success: logging-in → authenticated [guard: credentials-valid]
→ Auth Failure: logging-in → locked-out [missing guard] ⚠️
→ Logout: authenticated → logged-out [missing] ❌

**Gaps: 2 warnings, 1 error**
```

This format is generated by the extraction layer for inline conversation display without showing raw JSON.

### 7.4 Size Considerations

For large specifications (hundreds of elements), the SIR can be chunked:

- Elements stored in a content-addressed element store
- SIR document holds references (hashes) rather than inline elements
- Fetch-on-demand for large specs

```typescript
interface SIRElementRef {
  ref: string;  // content hash of the serialized element
}

// elements: Record<string, SIRElementRef>
// Resolution: fetch element by hash from store, assemble full graph in memory
```

---

## 8. Data Schema Domain — Complete Example

### 8.1 User Profile Data Schema

```json
{
  "sirId": "c3d4e5f6-7a8b-4c9d-a0e1-2f3a4b5c6d7e",
  "sirVersion": 3,
  "sirHash": "sha256:9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08",
  "schemaVersion": "1.0.0",
  "domain": {
    "primary": "data-schema",
    "version": "1.0.0",
    "secondary": []
  },
  "elements": {
    "entity-user": {
      "id": "entity-user",
      "elementType": "entity",
      "status": "validated",
      "version": 3,
      "label": "User",
      "description": "Core user profile entity. Every authenticated user has exactly one User record.",
      "properties": {
        "name": { "type": "string", "value": "users" },
        "storageEngine": { "type": "enum", "value": "postgresql", "allowedValues": ["postgresql", "sqlite", "mongodb"] },
        "softDelete": { "type": "boolean", "value": true }
      },
      "references": [],
      "subElements": ["field-id", "field-email", "field-name", "field-created-at", "field-updated-at", "field-deleted-at"],
      "confidence": 0.95,
      "flags": { "needsReview": false, "isAmbiguous": false, "isTentative": false, "isContradicted": false, "sourceIsExplicit": true, "hasGaps": false },
      "createdAt": 1778392300000,
      "updatedAt": 1778392350000,
      "provenance": {
        "entries": [{
          "turnId": "turn-15",
          "action": "extracted",
          "agentId": "agent-engineering",
          "humanConfirmed": true,
          "timestamp": 1778392300000,
          "confidenceAtTime": 0.95
        }]
      },
      "confidenceBreakdown": {
        "overall": 0.95,
        "factors": { "explicitMarker": 1.0, "structuralPattern": 0.95, "consistency": 0.95, "speakerAuthority": 0.90, "repetition": 0.90 }
      }
    },

    "field-id": {
      "id": "field-id",
      "elementType": "field",
      "status": "validated",
      "version": 1,
      "label": "ID",
      "description": "Primary key, auto-generated UUID.",
      "properties": {
        "name": { "type": "string", "value": "id" },
        "type": { "type": "enum", "value": "uuid", "allowedValues": ["uuid", "integer", "string", "boolean", "timestamp", "jsonb"] },
        "nullable": { "type": "boolean", "value": false },
        "primaryKey": { "type": "boolean", "value": true },
        "defaultValue": { "type": "expression", "value": "gen_random_uuid()", "expressionType": "sql" }
      },
      "references": [],
      "subElements": [],
      "confidence": 0.98,
      "flags": { "needsReview": false, "isAmbiguous": false, "isTentative": false, "isContradicted": false, "sourceIsExplicit": true, "hasGaps": false },
      "createdAt": 1778392310000,
      "updatedAt": 1778392310000,
      "provenance": {
        "entries": [{
          "turnId": "turn-15",
          "action": "extracted",
          "agentId": "agent-engineering",
          "humanConfirmed": true,
          "timestamp": 1778392310000,
          "confidenceAtTime": 0.98
        }]
      },
      "confidenceBreakdown": {
        "overall": 0.98,
        "factors": { "explicitMarker": 1.0, "structuralPattern": 0.98, "consistency": 0.98, "speakerAuthority": 0.90, "repetition": 0.95 }
      }
    },

    "field-email": {
      "id": "field-email",
      "elementType": "field",
      "status": "validated",
      "version": 2,
      "label": "Email",
      "description": "User email address. Must be unique and valid format.",
      "properties": {
        "name": { "type": "string", "value": "email" },
        "type": { "type": "enum", "value": "string", "allowedValues": ["uuid", "integer", "string", "boolean", "timestamp", "jsonb"] },
        "nullable": { "type": "boolean", "value": false },
        "maxLength": { "type": "number", "value": 254 },
        "unique": { "type": "boolean", "value": true }
      },
      "references": [],
      "subElements": [],
      "confidence": 0.96,
      "flags": { "needsReview": false, "isAmbiguous": false, "isTentative": false, "isContradicted": false, "sourceIsExplicit": true, "hasGaps": false },
      "createdAt": 1778392310000,
      "updatedAt": 1778392340000,
      "provenance": {
        "entries": [
          {
            "turnId": "turn-15",
            "action": "extracted",
            "agentId": "agent-engineering",
            "humanConfirmed": false,
            "timestamp": 1778392310000,
            "confidenceAtTime": 0.90
          },
          {
            "turnId": "turn-17",
            "action": "refined",
            "agentId": "human",
            "humanConfirmed": true,
            "timestamp": 1778392340000,
            "confidenceAtTime": 0.96,
            "diff": { "changedProperties": ["unique", "maxLength"] }
          }
        ]
      },
      "confidenceBreakdown": {
        "overall": 0.96,
        "factors": { "explicitMarker": 1.0, "structuralPattern": 0.95, "consistency": 0.95, "speakerAuthority": 0.90, "repetition": 0.90 }
      }
    },

    "field-name": {
      "id": "field-name",
      "elementType": "field",
      "status": "validated",
      "version": 1,
      "label": "Name",
      "description": "User's display name.",
      "properties": {
        "name": { "type": "string", "value": "display_name" },
        "type": { "type": "enum", "value": "string", "allowedValues": ["uuid", "integer", "string", "boolean", "timestamp", "jsonb"] },
        "nullable": { "type": "boolean", "value": false },
        "maxLength": { "type": "number", "value": 100 }
      },
      "references": [],
      "subElements": [],
      "confidence": 0.95,
      "flags": { "needsReview": false, "isAmbiguous": false, "isTentative": false, "isContradicted": false, "sourceIsExplicit": true, "hasGaps": false },
      "createdAt": 1778392310000,
      "updatedAt": 1778392310000,
      "provenance": {
        "entries": [{
          "turnId": "turn-15",
          "action": "extracted",
          "agentId": "agent-engineering",
          "humanConfirmed": true,
          "timestamp": 1778392310000,
          "confidenceAtTime": 0.95
        }]
      },
      "confidenceBreakdown": {
        "overall": 0.95,
        "factors": { "explicitMarker": 1.0, "structuralPattern": 0.95, "consistency": 0.95, "speakerAuthority": 0.90, "repetition": 0.90 }
      }
    }
  },
  "constraints": [
    {
      "id": "constraint-email-unique",
      "kind": "invariant",
      "target": "field-email",
      "expression": "forall u1,u2 in entity-user: u1.id != u2.id => u1.email != u2.email",
      "language": "speckl-expr",
      "severity": "error",
      "confidence": 1.0,
      "humanConfirmed": true,
      "resolved": true,
      "provenance": {
        "entries": [{
          "turnId": "turn-17",
          "action": "extracted",
          "agentId": "agent-engineering",
          "humanConfirmed": true,
          "timestamp": 1778392340000,
          "confidenceAtTime": 1.0
        }]
      }
    },
    {
      "id": "constraint-email-format",
      "kind": "type",
      "target": "field-email",
      "check": "value matches email_pattern",
      "severity": "error",
      "confidence": 0.95,
      "humanConfirmed": true,
      "resolved": true,
      "provenance": {
        "entries": [{
          "turnId": "turn-17",
          "action": "extracted",
          "agentId": "agent-engineering",
          "humanConfirmed": true,
          "timestamp": 1778392340000,
          "confidenceAtTime": 0.95
        }]
      }
    }
  ],
  "composition": [],
  "metadata": {
    "title": "User Profile Schema",
    "description": "Core user entity with auth-critical fields",
    "tags": ["users", "auth", "profile", "database"],
    "createdAt": 1778392300000,
    "updatedAt": 1778392350000,
    "createdBy": "agent-engineering",
    "readiness": "validated"
  }
}
```

---

## 9. Refinement Example — Before and After

### 9.1 Before Refinement (Turn 5 — Initial Extraction)

The login flow SIR after first extraction, before Scott refines it:

```json
{
  "state-logged-out": {
    "id": "state-logged-out",
    "elementType": "state",
    "status": "proposed",
    "version": 1,
    "label": "Logged Out",
    "description": "User is not authenticated.",
    "properties": {
      "isInitial": { "type": "boolean", "value": true },
      "isTerminal": { "type": "boolean", "value": false }
    },
    "references": [
      { "refId": "transition-login-submit", "refType": "outgoing", "label": "on submit", "cardinality": "1" }
    ],
    "subElements": [],
    "confidence": 0.92,
    "flags": { "needsReview": false, "isAmbiguous": false, "isTentative": false, "isContradicted": false, "sourceIsExplicit": true, "hasGaps": false },
    "createdAt": 1778392100000,
    "updatedAt": 1778392100000,
    "provenance": {
      "entries": [{
        "turnId": "turn-3",
        "action": "extracted",
        "agentId": "agent-engineering",
        "humanConfirmed": false,
        "timestamp": 1778392100000,
        "confidenceAtTime": 0.92
      }]
    }
  },
  "state-authenticated": {
    "id": "state-authenticated",
    "elementType": "state",
    "status": "proposed",
    "version": 1,
    "label": "Authenticated",
    "description": "User has valid session.",
    "properties": {
      "isInitial": { "type": "boolean", "value": false },
      "isTerminal": { "type": "boolean", "value": false }
    },
    "references": [
      { "refId": "transition-auth-success", "refType": "incoming", "label": "entered via", "cardinality": "1" }
    ],
    "subElements": [],
    "confidence": 0.95,
    "flags": { "needsReview": false, "isAmbiguous": false, "isTentative": false, "isContradicted": false, "sourceIsExplicit": true, "hasGaps": false },
    "createdAt": 1778392100000,
    "updatedAt": 1778392100000,
    "provenance": {
      "entries": [{
        "turnId": "turn-3",
        "action": "extracted",
        "agentId": "agent-engineering",
        "humanConfirmed": false,
        "timestamp": 1778392100000,
        "confidenceAtTime": 0.95
      }]
    }
  }
}
```

**Gaps at this stage:**
- Missing: `state-locked-out`, `state-logging-in` (not yet mentioned in conversation)
- Missing: logout transition, lockout guard, timeout behavior
- All elements status: "proposed" (not confirmed)
- `state-authenticated` has no outgoing transitions

### 9.2 After Refinement (Turn 12 — Scott Confirms)

The SIR from Section 2.7 shows the final state. Key changes:

**Element-level changes:**
- `state-logged-out`: status `proposed` → `validated`; confidence 0.92 (unchanged)
- `state-authenticated`: added `sessionDuration`, `onEntry`, `transition-logout`, `transition-session-expire`; confidence 0.95 (unchanged); status → `validated`
- `state-logging-in`: ADDED — confidence 0.78 → 0.85 after refinement
- `state-locked-out`: ADDED — confidence 0.88
- `transition-credential-check`: ADDED — low confidence 0.65, tentative, flagged
- `transition-auth-failure`: ADDED (not shown in full above but referenced)
- `guard-credentials-valid`: ADDED — confidence 0.96

**Provenance chain for `state-logging-in`:**
```
turn-5: extracted (confidence 0.45, proposed)
turn-7: refined — added timeout, timeoutAction (confidence 0.85)
turn-12: confirmed by Scott (confidence 1.0, validated)
```

**The diff** (computed by SIRDiff):
```json
{
  "addedElements": ["state-logging-in", "state-locked-out", "transition-credential-check", "transition-auth-success", "transition-auth-failure", "transition-auth-timeout", "transition-logout", "transition-session-expire", "transition-lock-expire", "guard-credentials-valid", "guard-max-attempts", "guard-lock-timer"],
  "removedElements": [],
  "modifiedElements": {
    "state-authenticated": {
      "changedProperties": ["sessionDuration", "onEntry"],
      "addedReferences": ["transition-logout", "transition-session-expire"],
      "changedConstraints": [],
      "confidenceDelta": 0.0
    }
  }
}
```

---

## 10. Summary — The SIR Contract

The SIR makes these guarantees to the layers above and below:

### To the Extraction Layer:
- **Write**: accept any well-formed element, regardless of completeness; confidence and status fields accommodate uncertainty
- **Incremental**: support partial updates, property-level diffs, version tracking
- **Provenance storage**: preserve every extraction event without loss

### To the Validation Layer:
- **Query**: give a complete typed graph with references, properties, constraints
- **Locate**: every element has a stable ID, every property has a path for precise error reporting
- **Confidence**: per-element and per-property scores available for gating decisions

### To the Compilation Layer:
- **Deterministic hash**: content-addressable with fixed serialization order
- **Stable references**: element IDs never change; references are resolvable
- **Gap transparency**: flags and confidence scores indicate where compilation should insert stubs
- **Readiness**: graduated readiness levels for partial → full compilation

---

## Open Questions

1. **Sub-SIR granularity**: Should sub-state-machines be inline elements or referenced by content hash? Inline is simpler; hashed references scale better.
2. **Constraint expression evaluator**: How much of the constraint language should be evaluable in-process vs. delegated to external solvers (Z3, Alloy)?
3. **Real-time SIR sync**: For collaborative editing (multiple agents talking to the same human simultaneously), do we need CRDT semantics or is append-only log sufficient?
4. **Domain schema registry**: Where do domain definitions live? Inline in the SIR, in a registry service, or loaded from filesystem?
5. **Property type extensibility**: Should custom domain backends be able to define new `PropertyValue` types beyond the six built-in types?
