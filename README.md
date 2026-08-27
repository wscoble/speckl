# Speckl

A compiler for SpeckDL — a specification language for state machines. Write what your system should do. Get TypeScript, Z3 verification output, and provenance artifacts from a single source.

## What It Does

```
.speckdl spec ──→ TypeScript          ← typed, importable state machine classes  ✓ tested
              ├── Z3 SMT-LIB2         ← formal verification (bounded model checking)  ✓ verified in CI
              ├── Rust                ← state machine structs and enums  ✓ generated (text-tested)
              ├── Protobuf            ← message definitions  ✓ tested
              ├── K8s CRDs            ← Kubernetes custom resources  ✓ tested
              ├── OpenAPI 3.1         ← REST API surface  ✓ tested
              ├── PROV-O (RDF)         ← W3C provenance standard  ✓ tested
              ├── CycloneDX SBOM       ← OWASP software bill of materials  ✓ tested
              └── SPDX SBOM            ← Linux Foundation SBOM standard  ✓ tested
```

No LLMs in the compilation path. Same spec, same output, every time.

## Verification

The Z3 backend emits SMT-LIB2 with bounded model checking, and CI runs a **real Z3 solver** over every example spec:

```bash
cd compiler
npm run build
npm run verify          # compiles examples, runs z3, checks solver results
```

Each generated `.smt2` file carries a `; speckl-expect:` marker declaring what the solver should return. When a property is violated, the verifier renders a human-readable counterexample — a per-step state trace from the solver model. Constructs the translators cannot yet handle are skipped with visible comments rather than emitted as invalid SMT.

Requires the `z3` binary (`pacman -S z3`, `apt-get install z3`, or set `Z3_BIN`).

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

Formal methods specs from a toggle switch through Raft consensus:

| Example | What it demonstrates |
|---------|----------------------|
| ToggleSwitch | Basic states, actions, invariants |
| AccountLedger | Banking ledger with debit/credit |
| TwoPhaseCommit | Distributed transaction coordinator |
| Paxos | Consensus with 3 safety invariants |
| Raft | Leader election, log replication |
| KafkaKRaft | KRaft consensus with Z3 verification |
| TigerBeetleLedger | Financial ledger (ports TigerBeetle core) |
| OAuth2AuthorizationCode | OAuth 2.0 flow with PKCE |
| RetryHandler | Error handling with backoff |
| SQLitePager | SQLite page cache state machine |
| SQLiteWAL | SQLite write-ahead log |
| tef | Complex product spec with K8s CRDs |

Browse all in [examples/](examples/).

## Documentation

- [Speckl by Example](docs/speckl-by-example.md) — guided tutorial from ToggleSwitch through Raft
- [SpeckDL Language Spec](speckdl/SPEC.md) — syntax and semantics

## Status

- 140 tests passing, CI green (incl. real-solver Z3 verification of all examples)
- Tested backends: TypeScript, Z3, Protobuf, K8s CRDs, OpenAPI, CycloneDX, SPDX, PROV-O, Rust (generated-text tested)
- Round-trip property tested: parse → print → parse is identity for all examples
- Known limitation: BMC over invariants using post-state notation (`x'`) degrades to a consistency check; quantifier sugar (`forall x in coll:`) is not yet lowered to Z3 — such constraints are skipped with visible comments
- TLA+ models: Two-Phase Commit, Paxos, and Raft are ported as `.speckdl` specs (inspired by the original TLA+ models, not TLA+ output)

## License

MIT