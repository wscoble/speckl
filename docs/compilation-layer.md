# Speckl Compilation Backend Architecture

## Overview

The Compilation Layer is Speckl's superpower: it takes a validated SIR (Speckl Intermediate Representation) and produces **deterministic, verifiable artifacts** across multiple target formats. The pipeline:

```
Chaotic Conversation → [Extraction Layer] → [Validation Layer] → [Compilation Layer] → Artifacts
```

While the conversation is chaotic, the output is **guaranteed deterministic**. Same SIR + same compiler version = same artifact bytes, every time.

---

## 1. Compilation Model

### Pure Functional Core

```
compile: SIR × TargetConfig × CompilerVersion → CompilationResult
```

No side effects. No network calls. No file system dependency. No randomness. The entire compilation is a pure function — this is what makes determinism possible.

```typescript
interface CompilationResult {
  // The compiled artifact
  artifact: Artifact;

  // Cryptographic proof of what was compiled
  manifest: CompilationManifest;

  // What the compiler couldn't compile
  gaps: CompilationGap[];

  // Readiness assessment
  readiness: ReadinessLevel;
}

interface Artifact {
  format: TargetFormat;         // "cyclonedx", "prov-o", "spdx", "wasm"
  mimeType: string;             // "application/json", "application/wasm"
  content: Buffer | string;     // The actual artifact bytes
  contentHash: string;          // sha256 of content
  size: number;                 // byte count
}
```

### The Compilation Manifest

Every compilation produces a manifest — a cryptographic record of provenance:

```typescript
interface CompilationManifest {
  manifestVersion: "1.0.0";

  // What went in
  inputs: {
    sirHash: string;            // sha256 of the SIR
    sirVersion: number;         // SIR version counter
    sirId: string;              // UUID of the SIR
  };

  // What compiled it
  compiler: {
    name: "speckl-compiler";
    version: string;            // "2.3.1"
    targets: string[];          // ["cyclonedx@1.5", "spdx@3.0"]
    hash: string;               // sha256 of compiler binary/config
  };

  // What came out
  outputs: Record<TargetFormat, {
    hash: string;               // sha256 of the artifact
    size: number;
    timestamp: string;          // ISO 8601, for humans only (not deterministic input)
  }>;

  // Integrity chain
  manifestHash: string;         // sha256 of this manifest (self-referential, computed last)
}
```

### Hash-Locking for Determinism

Determinism is guaranteed through content-addressing:

1. **SIR is hash-addressed**: Every SIR gets a `sha256` hash on validation
2. **Compiler is version-pinned**: Target compilers declare their exact version in the SIR
3. **No ambient state**: Compilation reads nothing from the environment — no `Date.now()`, no `Math.random()`, no OS locale
4. **Result verification**: The manifest's output hash must match `sha256(artifact.content)` — mismatch = compilation error

```typescript
async function verifyReproducibility(
  sir: SIR,
  target: TargetConfig,
  previousManifest: CompilationManifest
): Promise<VerificationResult> {
  const result = await compile(sir, target);
  const newHash = result.manifest.outputs[target.format].hash;
  const oldHash = previousManifest.outputs[target.format].hash;

  if (newHash !== oldHash) {
    return {
      reproducible: false,
      expected: oldHash,
      actual: newHash,
      // The diff between SIR versions may explain this
      sirChange: diffSir(previousManifest.inputs.sirHash, sir.hash),
    };
  }

  return { reproducible: true };
}
```

### The Dual BOM Pattern (Existing Speckl Convention)

Speckl already compiles state machines to dual BOMs: CycloneDX (SBOM) + PROV-O (provenance). The compilation layer generalizes this:

```
StateMachine SIR → compileToCycloneDX → CycloneDX 1.5 JSON
StateMachine SIR → compileToPROV-O    → PROV-O RDF/Turtle
StateMachine SIR → compileToWASM      → WASM binary
         ↑
    One SIR, three targets, single compilation run
```

---

## 2. Target Abstraction

### What Is a Compilation Target?

A compilation target consumes an SIR and produces an artifact in a specific format. It's an abstract interface that every target implements:

```typescript
interface CompilerTarget {
  // Identity
  readonly id: TargetId;              // "cyclonedx", "openapi", "terraform"
  readonly version: string;           // "1.5.0"
  readonly format: TargetFormat;      // "cyclonedx"
  readonly mimeType: string;          // "application/json"

  // What domains of SIR can this target handle?
  readonly supportedDomains: SIRDomain[];

  // What does this target REQUIRE from the SIR?
  readonly requirements: TargetRequirements;

  // Compilation entry point
  compile(sir: SIR, config: TargetConfig, context: CompilationContext): CompileOutput;

  // Does this SIR have enough info for this target?
  assessReadiness(sir: SIR): ReadinessAssessment;

  // Generate stubs for missing information
  generateStubs(gaps: CompilationGap[], sir: SIR): StubResult;
}

interface TargetRequirements {
  // Required SIR sections
  requiredSections: string[];         // ["entities", "transitions", "states"]
  // Required entity types
  requiredEntityTypes: string[];      // ["software-component", "process"]
  // Required relationship types
  requiredRelationshipTypes: string[];
  // Minimum completeness threshold (0-1)
  minCompletenessScore: number;       // e.g., 0.8 = 80% of required fields present
}
```

### Example Target Implementations

**State Machine Targets** (current):
- `cyclonedx` — SBOM from state transitions
- `prov-o` — Provenance ontology from state history
- `spdx` — License compliance from component states
- `wasm` — Executable state machine runtime

**Future Targets**:
- `openapi` — API specification from interface SIR
- `json-schema` — Data validation schemas
- `cloudformation` / `terraform` — Infrastructure as code from deployment SIR
- `kubernetes-crd` — Custom resource definitions
- `solana-program` / `evm-contract` — Smart contracts from protocol SIR
- `github-actions` — CI/CD pipelines from workflow SIR
- `opa-rego` — Policy rules from constraint SIR
- `protobuf` — Protocol buffer definitions from data SIR

### Target Registration

Targets register with the compiler via a plugin system:

```typescript
class CompilerRegistry {
  private targets: Map<TargetId, CompilerTarget> = new Map();

  register(target: CompilerTarget): void {
    const key = `${target.id}@${target.version}`;
    if (this.targets.has(key)) {
      throw new Error(`Target ${key} already registered`);
    }
    this.targets.set(key, target);
  }

  getTarget(id: TargetId, version?: string): CompilerTarget {
    if (version) {
      return this.targets.get(`${id}@${version}`)
        ?? this.throwNotFound(id, version);
    }
    // Return latest version
    const versions = Array.from(this.targets.keys())
      .filter(k => k.startsWith(`${id}@`))
      .sort(semverDesc);
    return this.targets.get(versions[0])
      ?? this.throwNotFound(id);
  }

  listTargetsForDomain(domain: SIRDomain): CompilerTarget[] {
    return Array.from(this.targets.values())
      .filter(t => t.supportedDomains.includes(domain));
  }
}
```

### Target-Specific Configuration

```typescript
interface TargetConfig {
  format: TargetFormat;
  version?: string;              // Pin to specific target version
  options?: Record<string, unknown>;  // Target-specific options
  dialect?: string;              // "cyclonedx:1.5" vs "cyclonedx:1.4"
}

// Example: CycloneDX with custom options
const cyclonedxConfig: TargetConfig = {
  format: "cyclonedx",
  version: "1.5.0",
  options: {
    serialNumber: "urn:uuid:3e56b1dc-...",  // deterministic UUID
    includeVulnerabilities: true,
    componentTypes: ["application", "library", "container"],
  },
  dialect: "cyclonedx:1.5",
};
```

---

## 3. Domain-to-Target Mapping

### Domain Capabilities

Not every SIR can compile to every target. The SIR has a **domain** that determines its capabilities:

```typescript
enum SIRDomain {
  StateMachine = "state-machine",
  DataSchema = "data-schema",
  APIInterface = "api-interface",
  Deployment = "deployment",
  Workflow = "workflow",
  Protocol = "protocol",
  Constraint = "constraint",
  ServiceTopology = "service-topology",
  LicenseCompliance = "license-compliance",
}
```

Each domain has a set of **capabilities** — the types of information it can encode:

| Domain | Encodes | Capabilities |
|---|---|---|
| `state-machine` | States, transitions, guards, actions | Entity lifecycle, event sequences, invariants |
| `data-schema` | Types, fields, constraints, relations | Data shape, validation rules, serialization |
| `api-interface` | Endpoints, methods, params, responses | HTTP contracts, auth schemes, error models |
| `deployment` | Resources, dependencies, configs | Infrastructure topology, scaling, networking |
| `workflow` | Steps, triggers, conditions, artifacts | CI/CD graphs, automation pipelines |
| `protocol` | Messages, participants, invariants | Communication contracts, consensus rules |
| `constraint` | Rules, subjects, effects | Policy definitions, access control |
| `service-topology` | Services, ports, dependencies | System architecture, fault domains |
| `license-compliance` | Components, licenses, obligations | SBOM data, license compatibility |

### Target Requirements

Each target declares what it needs from an SIR to produce a valid artifact:

```typescript
// A CycloneDX target needs entity information
const cyclonedxRequirements: TargetRequirements = {
  requiredSections: ["entities", "relationships"],
  requiredEntityTypes: ["software-component"],
  minCompletenessScore: 0.6,  // Can produce partial BOM from 60% complete SIR
};

// A Terraform target needs resource definitions
const terraformRequirements: TargetRequirements = {
  requiredSections: ["entities", "dependencies", "configurations"],
  requiredEntityTypes: ["compute-resource", "network-resource"],
  requiredRelationshipTypes: ["depends-on", "exposes"],
  minCompletenessScore: 0.8,  // Need 80% for valid Terraform
};

// An OPA/Rego target needs rules
const opaRegoRequirements: TargetRequirements = {
  requiredSections: ["rules", "subjects", "effects"],
  requiredEntityTypes: ["policy-subject", "policy-action"],
  minCompletenessScore: 0.7,
};
```

### Compatibility Matrix

```
Domain → Target Mapping:
╔══════════════════════╦═════════╦══════════╦═══════════╦════════╦═════════════╗
║ Target               ║ SM      ║ Schema   ║ API       ║ Deploy ║ Workflow    ║
╠══════════════════════╬═════════╬══════════╬═══════════╬════════╬═════════════╣
║ cyclonedx            ║    ✓    ║    ✗     ║     ✗     ║    ✗   ║     ✗       ║
║ prov-o               ║    ✓    ║    ✗     ║     ✗     ║    ✗   ║     ✗       ║
║ spdx                 ║    ✓    ║    ✗     ║     ✗     ║    ✗   ║     ✗       ║
║ wasm                 ║    ✓    ║    ✗     ║     ✗     ║    ✗   ║     ✗       ║
║ openapi              ║    ✗    ║    ✗     ║     ✓     ║    ✗   ║     ✗       ║
║ json-schema          ║    ✗    ║    ✓     ║     ✓     ║    ✗   ║     ✗       ║
║ cloudformation       ║    ✗    ║    ✗     ║     ✗     ║    ✓   ║     ✗       ║
║ terraform            ║    ✗    ║    ✗     ║     ✗     ║    ✓   ║     ✗       ║
║ kubernetes-crd       ║    ✗    ║    ✗     ║     ✗     ║    ✓   ║     ✗       ║
║ evm-contract         ║    ✓    ║    ✗     ║     ✗     ║    ✗   ║     ✗       ║
║ github-actions       ║    ✗    ║    ✗     ║     ✗     ║    ✗   ║     ✓       ║
║ opa-rego             ║    ✗    ║    ✗     ║     ✗     ║    ✗   ║     ✗       ║
║ protobuf             ║    ✗    ║    ✓     ║     ✓     ║    ✗   ║     ✗       ║
╚══════════════════════╩═════════╩══════════╩═══════════╩════════╩═════════════╝
```

The compiler validates compatibility before starting:

```typescript
function validateTargetCompatibility(sir: SIR, target: CompilerTarget): CompatibilityResult {
  if (!target.supportedDomains.includes(sir.domain)) {
    return {
      compatible: false,
      reason: `Target ${target.id} does not support SIR domain "${sir.domain}"`,
    };
  }

  const missingRequirements = target.requirements.requiredSections
    .filter(section => !sir.sections.has(section));

  if (missingRequirements.length > 0) {
    return {
      compatible: false,
      reason: `SIR missing required sections: ${missingRequirements.join(", ")}`,
    };
  }

  // Check completeness threshold
  const score = assessCompleteness(sir, target);
  if (score < target.requirements.minCompletenessScore) {
    return {
      compatible: false,
      reason: `SIR completeness (${score}) below target minimum (${target.requirements.minCompletenessScore})`,
    };
  }

  return { compatible: true };
}
```

---

## 4. Incremental Compilation

### Change Detection

When a conversation evolves, the SIR gets a new version. We need to know **exactly what changed** to avoid recompiling everything:

```typescript
interface SIRDiff {
  fromVersion: number;
  toVersion: number;
  fromHash: string;
  toHash: string;

  // What changed at each layer
  sections: {
    added: string[];
    removed: string[];
    modified: string[];
  };
  entities: {
    added: EntityId[];
    removed: EntityId[];
    modified: EntityId[];     // Entity existed before, fields changed
  };
  transitions: {
    added: TransitionId[];
    removed: TransitionId[];
    modified: TransitionId[];
  };
  // Affected targets: which targets need recompilation?
  affectedTargets: TargetId[];
}

function diffSir(v1: SIR, v2: SIR): SIRDiff {
  // Content-addressed comparison
  const sectionDiff = {
    added: [...v2.sections.keys()].filter(k => !v1.sections.has(k)),
    removed: [...v1.sections.keys()].filter(k => !v2.sections.has(k)),
    modified: [...v2.sections.keys()].filter(k =>
      v1.sections.has(k) &&
      hashSection(v1.sections.get(k)) !== hashSection(v2.sections.get(k))
    ),
  };

  // Entities: O(n) comparison with hash maps
  const v1EntityHashes = new Map(
    v1.entities.map(e => [e.id, hashEntity(e)])
  );
  const v2EntityHashes = new Map(
    v2.entities.map(e => [e.id, hashEntity(e)])
  );

  const entityDiff = {
    added: [...v2EntityHashes.keys()].filter(id => !v1EntityHashes.has(id)),
    removed: [...v1EntityHashes.keys()].filter(id => !v2EntityHashes.has(id)),
    modified: [...v2EntityHashes.keys()].filter(id =>
      v1EntityHashes.has(id) &&
      v1EntityHashes.get(id) !== v2EntityHashes.get(id)
    ),
  };

  // Determine which targets are affected
  const affectedTargets = determineAffectedTargets(sectionDiff, entityDiff);

  return {
    fromVersion: v1.version,
    toVersion: v2.version,
    fromHash: v1.hash,
    toHash: v2.hash,
    sections: sectionDiff,
    entities: entityDiff,
    transitions: computeTransitionDiff(v1, v2),
    affectedTargets,
  };
}
```

### Partial Compilation

Instead of recompiling everything, only recompile the changed portions:

```typescript
async function incrementalCompile(
  sirV2: SIR,
  sirV1: SIR,
  previousResults: Map<TargetId, CompilationResult>,
  targets: TargetConfig[]
): Promise<Map<TargetId, CompilationResult>> {
  const diff = diffSir(sirV1, sirV2);
  const results = new Map(previousResults);

  for (const target of targets) {
    if (!diff.affectedTargets.includes(target.format)) {
      // Target unaffected — reuse previous result
      continue;
    }

    if (isTargetAdditiveOnly(diff, target)) {
      // Only new entities added — merge, don't rebuild
      const merged = await mergeCompilation(
        previousResults.get(target.format)!,
        sirV2,
        diff.entities.added,
        target
      );
      results.set(target.format, merged);
    } else {
      // Structural changes — full recompile for this target
      const result = await compile(sirV2, target);
      results.set(target.format, result);
    }
  }

  return results;
}
```

### Incremental Compilation Cache

```typescript
interface CompilationCache {
  // Content-addressed cache: hash(sir, target, version) → result
  entries: Map<string, CompilationResult>;

  // Dependency tracking: which SIR entities feed which target output sections
  dependencyMap: Map<TargetId, Map<EntityId, OutputSection[]>>;

  lookup(sir: SIR, target: TargetConfig): CompilationResult | null;
  store(sir: SIR, target: TargetConfig, result: CompilationResult): void;
  invalidate(sir: SIR, entities: EntityId[]): TargetId[];
}
```

---

## 5. Artifact Versioning and Integrity

### Content-Addressable Artifacts

Every artifact is identified by its content hash, not a version number:

```
sir:abc123 → compile → artifact:def456 (sha256)
sir:abc123 → compile → artifact:def456 (same, always)
sir:abc124 → compile → artifact:789abc (different, because SIR changed)
```

### Reproducibility Guarantee

The formal guarantee:

> For any validated SIR `S` and compiler version `C`, `compile(S, C)` always produces exactly the same bytes. This holds across machines, time, and operating systems.

Implementation contract:

```typescript
// Compiler test suite includes reproducibility check
test("compilation is deterministic across runs", () => {
  const sir = loadSir("test-fixtures/state-machine/order-processing.sir.json");
  const runs = Array.from({ length: 100 }, () => compile(sir, cyclonedxConfig));

  const hashes = runs.map(r => r.manifest.outputs["cyclonedx"].hash);
  const uniqueHashes = new Set(hashes);

  expect(uniqueHashes.size).toBe(1);  // All 100 runs produce identical output
});

test("compilation is deterministic across platforms", async () => {
  // Artifacts committed to repo, verified in CI on Linux, macOS, Windows
  const sir = loadSir("test-fixtures/state-machine/payment-flow.sir.json");
  const { stdout } = await exec("speckl compile --target cyclonedx");

  expect(stdout.trim()).toBe(
    fs.readFileSync("test-fixtures/expected/payment-flow.cdx.json", "utf-8").trim()
  );
});
```

### Manifest Verification

```typescript
class ArtifactVerifier {
  verify(manifest: CompilationManifest, artifact: Artifact): VerificationResult {
    // 1. Hash check: does the artifact match its claimed hash?
    const actualHash = sha256(artifact.content);
    const claimedHash = manifest.outputs[artifact.format]?.hash;

    if (actualHash !== claimedHash) {
      return {
        valid: false,
        error: `Hash mismatch: claimed ${claimedHash}, actual ${actualHash}`,
      };
    }

    // 2. Manifest self-consistency
    const computedManifestHash = computeManifestHash(manifest);
    if (computedManifestHash !== manifest.manifestHash) {
      return {
        valid: false,
        error: "Manifest hash mismatch — manifest has been tampered with",
      };
    }

    // 3. Compiler version is known and valid
    if (!isKnownCompilerVersion(manifest.compiler.version)) {
      return {
        valid: false,
        error: `Unknown compiler version: ${manifest.compiler.version}`,
      };
    }

    return { valid: true };
  }

  // Can we verify an artifact was compiled from SIR X?
  verifyProvenance(manifest: CompilationManifest, sir: SIR): boolean {
    return manifest.inputs.sirHash === sir.hash;
  }
}
```

---

## 6. Compilation with Gaps

### The Gap Problem

Conversations are chaotic. The SIR will have gaps — missing fields, unspecified transitions, incomplete entity definitions. The compilation layer must handle this gracefully.

```typescript
interface CompilationGap {
  id: string;
  severity: "error" | "warning" | "info";
  location: {
    section: string;
    entity?: EntityId;
    transition?: TransitionId;
    field?: string;
  };
  description: string;
  // What would fill this gap?
  requiredInformation: string;
  // What stub was generated in its place
  stubGenerated: StubDescription;
  // How this affects the compiled output
  impact: GapImpact;
}

interface GapImpact {
  // The artifact section(s) affected
  affectedArtifactSections: string[];
  // Is this a blocking gap?
  blocksValidArtifact: boolean;
  // Human-readable description of the impact
  description: string;
}
```

### Stub Generation

When information is missing, generate clear stubs with markers:

```typescript
// Example: SIR has a state "processing" but no transition from "processing" to "shipped"
// The CycloneDX target generates:

// In compiled CycloneDX JSON:
{
  "components": [
    {
      "name": "order-service",
      "type": "application",
      "bom-ref": "entity:order-service"
    }
  ],
  "dependencies": [
    {
      "ref": "entity:order-service",
      "dependsOn": [
        // ⚠️ STUB: Gap #GAP-42
        "__speckl_stub__gap_GAP-42_missing_transition"
      ]
    }
  ],
  "metadata": {
    "tools": [
      {
        "vendor": "Speckl",
        "name": "Speckl Compiler",
        "version": "2.3.1"
      }
    ],
    // ⚠️ SPECIFICATION DEBT
    "properties": [
      {
        "name": "speckl:specification-debt",
        "value": JSON.stringify([
          {
            "gapId": "GAP-42",
            "severity": "error",
            "description": "Missing transition: processing → shipped",
            "requiredInformation": "Define what triggers the transition from 'processing' to 'shipped' and any guard conditions",
            "blocksValid: true
          }
        ])
      }
    ]
  }
}
```

### Graduated Compilation Levels

Artifacts have a **readiness level** distinct from the SIR's completeness:

```typescript
enum ReadinessLevel {
  Draft = "draft",           // < 40%: Conceptual, mostly stubs
  Partial = "partial",       // 40-60%: Key entities present, many stubs
  Beta = "beta",             // 60-80%: Usable for review, few stubs
  Production = "production", // 80-95%: Valid artifact, minimal stubs
  Complete = "complete",     // 95%+: No gaps, fully valid
}

interface ReadinessAssessment {
  level: ReadinessLevel;
  score: number;              // 0.0 - 1.0
  gapCount: {
    errors: number;
    warnings: number;
    info: number;
  };
  // Can this artifact be used for its intended purpose?
  usability: {
    canReview: boolean;       // Is it readable by humans?
    canValidate: boolean;     // Passes format-specific validation?
    canDeploy: boolean;       // Could be deployed to production?
    canAudit: boolean;        // Would pass a compliance audit?
  };
}
```

### Specification Debt Tracking

"Specification debt" is tracked persistently in the compiled output:

```json
{
  "speckl:specification-debt": {
    "totalGaps": 7,
    "errors": 3,
    "warnings": 4,
    "readiness": "beta",
    "debtItems": [
      {
        "id": "GAP-42",
        "since": "2026-05-01T12:00:00Z",
        "description": "Missing transition: processing → shipped",
        "affects": ["cyclonedx:dependencies", "prov-o:wasGeneratedBy"],
        "resolution": "Define the shipping trigger and guard conditions in the conversation"
      }
    ]
  }
}
```

---

## 7. Compiler Plugin Architecture

### The `CompilerTarget` Interface (Full)

```typescript
// Each target is a self-contained module implementing this interface
interface CompilerTarget {
  // === Identity ===
  readonly id: TargetId;
  readonly version: string;
  readonly format: TargetFormat;
  readonly mimeType: string;
  readonly displayName: string;
  readonly description: string;

  // === Domain Compatibility ===
  readonly supportedDomains: SIRDomain[];
  readonly requirements: TargetRequirements;

  // === Primary Entry Points ===
  compile(sir: SIR, config: TargetConfig, context: CompilationContext): CompileOutput;
  assessReadiness(sir: SIR): ReadinessAssessment;
  generateStubs(gaps: CompilationGap[], sir: SIR): StubResult;

  // === Incremental Compilation ===
  canIncrementalMerge(diff: SIRDiff): boolean;
  mergeIncremental(previous: CompileOutput, diff: SIRDiff, sir: SIR): CompileOutput;

  // === Validation ===
  validateArtifact(artifact: Artifact): ValidationResult;
}

interface CompilationContext {
  compilerVersion: string;
  compilerHash: string;
  sirHash: string;
  timestamp: string;         // For manifest only, NOT used in compilation
  logger: CompilationLogger; // Structured logging, no side effects on artifact
}

interface CompileOutput {
  artifact: Artifact;
  manifest: CompilationManifest;
  gaps: CompilationGap[];
  readiness: ReadinessAssessment;
  // Target-specific metadata for incremental merging
  sections: Map<string, { inputEntities: EntityId[]; hash: string }>;
}
```

### Target Registration and Discovery

Targets are discovered from the filesystem or loaded dynamically:

```typescript
// File: targets/cyclonedx/index.ts
import { CompilerTarget, CompileOutput, CompilationContext } from "@speckl/compiler";

export const cyclonedxTarget: CompilerTarget = {
  id: "cyclonedx",
  version: "1.5.0",
  format: "cyclonedx",
  mimeType: "application/json",
  displayName: "CycloneDX",
  description: "OWASP CycloneDX Software Bill of Materials",
  supportedDomains: [SIRDomain.StateMachine, SIRDomain.LicenseCompliance],
  requirements: {
    requiredSections: ["entities", "relationships"],
    requiredEntityTypes: ["software-component"],
    minCompletenessScore: 0.6,
  },

  compile(sir: SIR, config: TargetConfig, context: CompilationContext): CompileOutput {
    // 1. Extract components from SIR entities
    const components = sir.entities
      .filter(e => e.type === "software-component")
      .map(entityToComponent);

    // 2. Extract dependencies from SIR relationships
    const dependencies = sir.relationships
      .filter(r => r.type === "depends-on")
      .map(relationshipToDependency);

    // 3. Map state transitions to lifecycle phases
    const lifecyclePhases = sir.transitions?.map(transitionToLifecyclePhase) ?? [];

    // 4. Build the CycloneDX document
    const bom = buildCycloneDX15({
      bomFormat: "CycloneDX",
      specVersion: "1.5",
      serialNumber: config.options?.serialNumber as string ?? generateDeterministicUUID(sir.hash, "cyclonedx-serial"),
      version: 1,
      components,
      dependencies,
      metadata: {
        tools: [{
          vendor: "Speckl",
          name: "Speckl Compiler",
          version: context.compilerVersion,
        }],
        properties: lifecyclePhases.map(phase => ({
          name: `speckl:lifecycle:${phase.state}`,
          value: JSON.stringify(phase),
        })),
      },
    });

    // 5. Identify gaps
    const gaps = identifyGaps(sir, components, dependencies);

    // 6. Generate stubs for gaps
    if (gaps.length > 0) {
      this.injectStubs(bom, gaps);
    }

    // 7. Compute artifact
    const content = JSON.stringify(bom, null, 2);
    const artifact: Artifact = {
      format: "cyclonedx",
      mimeType: "application/json",
      content,
      contentHash: sha256(content),
      size: content.length,
    };

    // 8. Build manifest
    const manifest = buildManifest(context, artifact, "cyclonedx");

    // 9. Assess readiness
    const readiness = assessReadinessFromGaps(gaps);

    return {
      artifact,
      manifest,
      gaps,
      readiness,
      sections: trackSections(sir, components, dependencies),
    };
  },

  assessReadiness(sir: SIR): ReadinessAssessment { /* ... */ },
  generateStubs: generateCycloneDXStubs,
  canIncrementalMerge(diff: SIRDiff): boolean { /* ... */ },
  mergeIncremental(prev, diff, sir) { /* ... */ },
  validateArtifact: validateCycloneDX,
};

// Register
compilerRegistry.register(cyclonedxTarget);
```

### Full CycloneDX Target Example

```typescript
// Complete example: State Machine SIR → CycloneDX 1.5 JSON

// INPUT SIR (simplified):
const orderProcessingSIR: SIR = {
  id: "sir:order-processing-v3",
  version: 3,
  hash: "sha256:abc123...",
  domain: SIRDomain.StateMachine,
  entities: [
    {
      id: "entity:order-api",
      type: "software-component",
      name: "Order API",
      version: "2.1.0",
      properties: {
        language: "TypeScript",
        framework: "Express",
        license: "MIT",
      },
    },
    {
      id: "entity:payment-service",
      type: "software-component",
      name: "Payment Service",
      version: "1.8.3",
      properties: {
        language: "Rust",
        license: "Apache-2.0",
        piiScope: "processes-credit-cards",  // GAP: needs documentation
      },
    },
    {
      id: "entity:shipping-worker",
      type: "software-component",
      name: "Shipping Worker",
      version: "0.9.0",
      properties: {
        language: "Go",
        license: "MIT",
      },
    },
  ],
  relationships: [
    {
      id: "rel:order-to-payment",
      type: "depends-on",
      source: "entity:order-api",
      target: "entity:payment-service",
    },
    {
      id: "rel:order-to-shipping",
      type: "depends-on",
      source: "entity:order-api",
      target: "entity:shipping-worker",
    },
  ],
  transitions: [
    {
      id: "trans:created-to-paid",
      from: "created",
      to: "paid",
      trigger: "payment-received",
      guard: "payment.amount >= order.total",
    },
    {
      id: "trans:paid-to-shipped",
      from: "paid",
      to: "shipped",
      trigger: "shipping-label-created",
      // GUARD MISSING — this is a gap
    },
  ],
  states: [
    { id: "created", initial: true },
    { id: "paid" },
    { id: "shipped", final: true },
  ],
};

// OUTPUT: CycloneDX 1.5 JSON
const compiledOutput = {
  bomFormat: "CycloneDX",
  specVersion: "1.5",
  serialNumber: "urn:uuid:d5a7b3c1-e8f2-4a9d-b6c0-123456789abc",
  version: 1,
  metadata: {
    timestamp: "2026-05-09T22:57:00Z",
    tools: [{
      vendor: "Speckl",
      name: "Speckl Compiler",
      version: "2.3.1",
    }],
    properties: [
      {
        name: "speckl:lifecycle:paid",
        value: JSON.stringify({
          transition: "trans:created-to-paid",
          trigger: "payment-received",
          guard: "payment.amount >= order.total",
        }),
      },
      {
        name: "speckl:lifecycle:shipped",
        value: JSON.stringify({
          transition: "trans:paid-to-shipped",
          trigger: "shipping-label-created",
          guard: "__speckl_stub__gap_GAP-001_missing_guard",
          gapRef: "GAP-001",
        }),
      },
      {
        name: "speckl:specification-debt",
        value: JSON.stringify({
          totalGaps: 2,
          errors: 1,
          warnings: 1,
          readiness: "beta",
          debtItems: [
            {
              id: "GAP-001",
              severity: "error",
              description: "Missing guard condition on transition paid → shipped",
              requiredInformation: "What condition must be true for an order to ship? (e.g., payment settled, inventory confirmed)",
              blocksValid: false,
            },
            {
              id: "GAP-002",
              severity: "warning",
              description: "Payment Service processes PII — needs documentation",
              requiredInformation: "Document PII scope: what data, retention, encryption, access controls",
              blocksValid: false,
            },
          ],
        }),
      },
    ],
  },
  components: [
    {
      type: "application",
      name: "Order API",
      version: "2.1.0",
      "bom-ref": "entity:order-api",
      properties: [
        { name: "speckl:language", value: "TypeScript" },
        { name: "speckl:framework", value: "Express" },
      ],
    },
    {
      type: "application",
      name: "Payment Service",
      version: "1.8.3",
      "bom-ref": "entity:payment-service",
      properties: [
        { name: "speckl:language", value: "Rust" },
        { name: "speckl:pii-scope", value: "processes-credit-cards" },
        { name: "speckl:gap-ref", value: "GAP-002" },
      ],
    },
    {
      type: "application",
      name: "Shipping Worker",
      version: "0.9.0",
      "bom-ref": "entity:shipping-worker",
      properties: [
        { name: "speckl:language", value: "Go" },
      ],
    },
    // STUB: generated for the missing guard
    {
      type: "application",
      name: "__speckl_stub__gap_GAP-001_missing_guard",
      "bom-ref": "__speckl_stub__gap_GAP-001_missing_guard",
      properties: [
        { name: "speckl:stub", value: "true" },
        { name: "speckl:gap-ref", value: "GAP-001" },
      ],
    },
  ],
  dependencies: [
    {
      ref: "entity:order-api",
      dependsOn: ["entity:payment-service", "entity:shipping-worker"],
    },
    {
      ref: "entity:payment-service",
      dependsOn: [
        "__speckl_stub__gap_GAP-001_missing_guard",  // Linked to stub
      ],
    },
  ],
};
```

### Manifest for this compilation:

```json
{
  "manifestVersion": "1.0.0",
  "inputs": {
    "sirHash": "sha256:abc123def456...",
    "sirVersion": 3,
    "sirId": "sir:order-processing-v3"
  },
  "compiler": {
    "name": "speckl-compiler",
    "version": "2.3.1",
    "targets": ["cyclonedx@1.5"],
    "hash": "sha256:compiler-v2.3.1-hash..."
  },
  "outputs": {
    "cyclonedx": {
      "hash": "sha256:789fedcba...",
      "size": 4521,
      "timestamp": "2026-05-09T22:57:00Z"
    }
  },
  "manifestHash": "sha256:manifest-hash..."
}
```

---

## 8. Output Formats and Packaging

### Single Artifact vs. Bundle

Compilation can produce a single artifact or a bundle:

```typescript
interface ArtifactBundle {
  // Bundle metadata
  bundleId: string;
  bundleHash: string;

  // The SIR this was compiled from
  sir: {
    id: string;
    version: number;
    hash: string;
  };

  // Compiler info
  compiler: {
    version: string;
    hash: string;
  };

  // All compiled artifacts
  artifacts: Record<TargetFormat, Artifact>;

  // Shared manifest
  manifest: CompilationManifest;

  // Packaging metadata
  created: string;  // ISO 8601, for information only
  format: "speckl-bundle@1.0";
}
```

### Provenance Embedding

Every artifact embeds its own provenance. For formats that support metadata (CycloneDX, SPDX, PROV-O), the compilation manifest is embedded directly. For formats that don't (plain JSON, WASM), a sidecar manifest is generated:

```
output/
├── order-processing.cdx.json          # CycloneDX with embedded provenance
├── order-processing.cdx.manifest.json # Standalone manifest
├── order-processing.wasm              # WASM binary
├── order-processing.wasm.manifest.json # Sidecar manifest
└── order-processing.bundle.json        # Full bundle with all artifacts
```

### WASM as Universal Runtime Format

Speckl's current path compiles state machines to WASM, enabling:

1. **Cross-platform execution**: The same state machine runs in browser, server, edge
2. **Deterministic execution**: WASM is deterministic by design (no floats with NaN boxing)
3. **Compact**: Binary format, suitable for on-chain / embedded use
4. **Sandboxed**: Safe to execute untrusted state machines

```typescript
// WASM compilation target
const wasmTarget: CompilerTarget = {
  id: "wasm",
  version: "1.0.0",
  format: "wasm",
  mimeType: "application/wasm",
  supportedDomains: [SIRDomain.StateMachine],
  requirements: {
    requiredSections: ["states", "transitions"],
    minCompletenessScore: 0.5,
  },

  compile(sir: SIR, config: TargetConfig, context: CompilationContext): CompileOutput {
    // Generate a deterministic WASM module that:
    // 1. Exports a state machine execution function
    // 2. Accepts events as input
    // 3. Returns new state + actions

    const wasmModule = generateWasmStateMachine({
      states: sir.states,
      transitions: sir.transitions.map(t => ({
        from: t.from,
        to: t.to,
        trigger: t.trigger,
        guard: t.guard ? compileGuardToWasm(t.guard) : null,
        actions: (t.actions ?? []).map(compileActionToWasm),
      })),
      // Embed SIR hash for verification
      metadata: {
        sirHash: context.sirHash,
        compilerVersion: context.compilerVersion,
      },
    });

    const content = wasmModule.toBytes();
    return {
      artifact: {
        format: "wasm",
        mimeType: "application/wasm",
        content,
        contentHash: sha256(content),
        size: content.length,
      },
      // ... manifest, gaps, readiness
    };
  },
};
```

### Self-Describing Artifacts

Can you reconstruct the SIR from the compiled artifact? Generally **no** — it's a lossy transformation. But some targets are more lossy than others:

| Target | Reversibility | Notes |
|---|---|---|
| CycloneDX | Partial | Entities and dependencies survive; state transitions lose semantics |
| PROV-O | High | Designed for provenance — much of the SIR structure survives |
| WASM | Low | Compiled to instructions; reconstruction is decompilation, not guaranteed |
| OpenAPI | Partial | Endpoint structure survives; validation layer intent doesn't |
| Terraform | Low | HCL is declarative; can infer resources but not the SIR abstractions |

The compilation manifest fills the gap — it records the SIR hash, so you can always look up the exact SIR that produced a given artifact. The bundle includes both, so nothing is lost.

```typescript
function reconstructFromBundle(bundle: ArtifactBundle): {
  sir: SIR;           // Loaded from the SIR hash reference
  artifacts: Record<TargetFormat, Artifact>;
  manifest: CompilationManifest;
} {
  // The bundle doesn't contain the SIR itself (that's stored separately)
  // But it references it by hash — load it from the SIR store
  const sir = sirStore.lookup(bundle.sir.hash);
  if (!sir) {
    throw new Error(`SIR ${bundle.sir.hash} not found in store`);
  }

  // Verify: does this SIR's hash match what the manifest says?
  if (sir.hash !== bundle.inputs.sirHash) {
    throw new Error("SIR hash mismatch — possible tampering");
  }

  return { sir, artifacts: bundle.artifacts, manifest: bundle.manifest };
}
```

---

## Architecture Summary

```
┌─────────────────────────────────────────────────────────────┐
│                    Compilation Layer                         │
│                                                              │
│  ┌──────────────────────────────────────────────────────┐   │
│  │              Compiler Orchestrator                     │   │
│  │  - Validates SIR × target compatibility               │   │
│  │  - Manages incremental compilation cache              │   │
│  │  - Coordinates multi-target compilation               │   │
│  │  - Builds the compilation manifest                    │   │
│  └────────────────────┬─────────────────────────────────┘   │
│                       │                                      │
│         ┌─────────────┼─────────────┐                       │
│         ▼             ▼             ▼                       │
│  ┌──────────┐  ┌──────────┐  ┌──────────┐                  │
│  │CycloneDX │  │ PROV-O   │  │  WASM    │  ...             │
│  │ Target   │  │ Target   │  │  Target  │                  │
│  └──────────┘  └──────────┘  └──────────┘                  │
│         │             │             │                       │
│         ▼             ▼             ▼                       │
│  ┌──────────────────────────────────────────────────────┐   │
│  │              Artifact Assembler                       │   │
│  │  - Bundles artifacts + manifest                      │   │
│  │  - Embeds provenance in output formats               │   │
│  │  - Generates sidecar manifests when needed            │   │
│  │  - Signs bundles (future: sigstore/cosign)           │   │
│  └──────────────────────────────────────────────────────┘   │
│                                                              │
│  Invariants:                                                 │
│  ✓ Pure functional — no side effects                        │
│  ✓ Content-addressed — every artifact has a hash            │
│  ✓ Reproducible — same SIR → same artifact, always          │
│  ✓ Gap-tolerant — compiles what it can, marks the rest      │
└─────────────────────────────────────────────────────────────┘
```

## Key Design Decisions

1. **Pure functional compilation**: The compiler is a function `(SIR, TargetConfig) → CompilationResult`. No side effects guarantee determinism.

2. **Content-addressing over versioning**: Artifacts aren't "version 1.2.3" — they're `sha256:abc123...`. You know exactly what you have.

3. **Gap-tolerant by design**: The compiler handles incomplete SIRs gracefully with stubs, debt tracking, and readiness levels. Works from conversation day 1.

4. **Plugin architecture for targets**: New targets are standalone modules. The compiler core doesn't know about CycloneDX or Terraform — it knows about the `CompilerTarget` interface.

5. **Manifest as proof**: Every compilation produces cryptographic proof of what was compiled, by whom, from what. The manifest is the chain of custody.

6. **Incremental over rebuild**: Large SIRs with many entities benefit from partial recompilation. The dependency map enables surgical updates.

7. **Bundle as distribution unit**: A `.speckl.bundle.json` contains all artifacts and the manifest. Self-contained, verifiable, distributable.
