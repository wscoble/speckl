# Speckl

A compile-time provenance compiler for state machine specifications. Write what your system should do in SpeckDL. Get auditable code and provenance artifacts from a single source.

## What It Does

Speckl compiles SpeckDL specifications into multiple target representations:

```
.speckdl spec ──→ TypeScript             ← typed, importable state machine classes
              ├── Z3 SMT-LIB2            ← formal verification output
              ├── PROV-O (RDF)           ← W3C provenance standard
              ├── CycloneDX SBOM         ← OWASP software bill of materials
              ├── SPDX SBOM              ← Linux Foundation SBOM standard
              ├── Rust                   ← state machine structs and enums
              ├── TLA+                   ← formal specification output
              ├── OpenAPI                ← REST API surface
              ├── GraphQL                ← schema definition
              ├── Protobuf               ← message definitions
              ├── K8s CRDs               ← Kubernetes custom resources
              ├── Helm                    ← chart templates
              ├── JSON Schema            ← validation schemas
              ├── SQL                    ← table definitions
              └── Markdown               ← human-readable docs
```

No LLMs in the compilation path. Same spec, same output, every time.

## Quick Start

```bash
git clone https://github.com/wscoble/speckl.git
cd speckl/compiler
npm install
npm test

# Compile a spec
node dist/index.js ../examples/ToggleSwitch.speck -o out/switch
ls out/switch/
```

## Examples

14 specs from ToggleSwitch through Raft:

| Example | Lines | What it demonstrates |
|---------|-------|----------------------|
| ToggleSwitch | 20 | Basic states, actions, invariants |
| TwoPhaseCommit | 45 | Distributed transaction coordinator |
| Paxos | 120 | Consensus with 3 safety invariants |
| Raft | 230 | Leader election, log replication |
| KafkaKRaft | 141 | KRaft consensus with Z3 verification |
| TigerBeetleLedger | — | Financial ledger with debit/credit |
| OAuth2AuthorizationCode | — | OAuth 2.0 flow with PKCE |

Browse all 14 in [examples/](examples/).

## Documentation

- [Whitepaper v2](docs/whitepaper-v2.md) — language design, compiler architecture, provenance model, consensus protocol examples
- [Speckl by Example](docs/speckl-by-example.md) — guided tutorial from ToggleSwitch through Raft
- [SpeckDL Language Spec](speckdl/SPEC.md) — syntax and semantics
- [Kafka KRaft Reference](docs/kraft-protocol-reference.md) — protocol reference for the KRaft example

## Status

- TypeScript codegen: complete, type-safe state machine classes
- Z3 verification backend: `--target=z3` emits SMT-LIB2
- 14 example specs, 41 tests passing
- Rust, TLA+, OpenAPI, GraphQL, Protobuf, K8s CRD, Helm, JSON Schema, SQL, Markdown generators

## License

MIT