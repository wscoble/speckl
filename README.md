# Speckl

A compiler for SpeckDL — a specification language for state machines. Write what your system should do. Get TypeScript, Z3 verification output, and provenance artifacts from a single source.

## What It Does

```
.speckdl spec ──→ TypeScript          ← typed, importable state machine classes
              ├── Z3 SMT-LIB2         ← formal verification (bounded model checking)
              ├── Rust                ← state machine structs and enums
              ├── Protobuf            ← message definitions
              ├── K8s CRDs            ← Kubernetes custom resources
              ├── OpenAPI 3.1         ← REST API surface
              ├── PROV-O (RDF)         ← W3C provenance standard
              ├── CycloneDX SBOM       ← OWASP software bill of materials
              └── SPDX SBOM            ← Linux Foundation SBOM standard
```

No LLMs in the compilation path. Same spec, same output, every time.

## Quick Start

```bash
git clone https://github.com/wscoble/speckl.git
cd speckl/compiler
npm install
npm test

# Compile a spec
node dist/index.js ../examples/ToggleSwitch.speckdl -o out/switch
ls out/switch/
```

## Examples

31 specs from a toggle switch through Raft consensus:

| Example | What it demonstrates |
|---------|----------------------|
| ToggleSwitch | Basic states, actions, invariants |
| TwoPhaseCommit | Distributed transaction coordinator |
| Paxos | Consensus with 3 safety invariants |
| Raft | Leader election, log replication |
| KafkaKRaft | KRaft consensus with Z3 verification |
| TigerBeetleLedger | Financial ledger with debit/credit |
| OAuth2AuthorizationCode | OAuth 2.0 flow with PKCE |
| SQLitePager | SQLite page cache state machine |
| Marketplace | Two-sided marketplace with payments |

Browse all 31 in [examples/](examples/).

## Documentation

- [Whitepaper](docs/whitepaper-v2.md) — language design, compiler architecture, provenance model
- [Speckl by Example](docs/speckl-by-example.md) — guided tutorial from ToggleSwitch through Raft
- [SpeckDL Language Spec](speckdl/SPEC.md) — syntax and semantics
- [Kafka KRaft Reference](docs/kraft-protocol-reference.md) — protocol reference for the KRaft example

## Status

- 163 tests passing, CI green
- Tested backends: TypeScript, Z3, Rust, Protobuf, K8s CRDs, OpenAPI, CycloneDX, SPDX, PROV-O
- 31 example specs including TLA+ ports (Two-Phase Commit, Paxos, Raft)

## License

MIT