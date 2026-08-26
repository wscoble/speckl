# Show HN: Speckl — Spec-first development with compilable state machines (open source)

**Title (Show HN):** Show HN: Speckl — Write specs like TLA+, compile to runnable TypeScript and WASM

## Post Body

I built Speckl because I was tired of writing specifications that rot in a wiki while the code drifts in a different direction.

**What it is:** Speckl is a spec-first development tool. You write your system's behavior in SpeckDL (a lightweight specification language) and the compiler generates five artifacts:

1. **TypeScript** — Runnable state machine classes (passes `tsc --noEmit`)
2. **WASM** — WebAssembly modules with verified state transitions
3. **PROV-O** — Machine-readable provenance (audit trail)
4. **CycloneDX SBOM** — Software bill of materials
5. **SPDX SBOM** — Standardized license/supply chain manifest

**The key insight:** A spec shouldn't just describe what your system does — it should *compile into the thing that does it*. When the spec IS the source of truth, you can't have spec-code drift.

## How it works

Here's a simple toggle switch in SpeckDL:

```
spec ToggleSwitch
type State = enum { on, off }
state active: State = off

init
  active := off

action flip
  require active == off
  active := on

invariant Mutex
  active == on implies prev(active) == off
```

The compiler generates a TypeScript class with typed guards, a WASM module with verified state transitions, and provenance metadata proving where every line came from.

## Real specs that compile

The example suite covers:

- **ToggleSwitch** — State machines 101
- **AccountLedger** — Financial invariants, Map/Set types, audit trails  
- **TwoPhaseCommit** — Multi-role distributed protocols (direct TLA+ port)
- **Paxos** — Classic consensus with proposers/acceptors/learners
- **Raft** — Full Raft protocol: leader election, log replication, 3 safety invariants (Leader Completeness, Log Matching, Single Leader)
- **TigerBeetleLedger** — Naive port of TigerBeetle's core accounting engine

All 10 examples compile to all 5 artifacts. 41 tests, all passing.

## Why this matters

The gap between "what we specified" and "what we built" is where production bugs live. TLA+ is brilliant for formal verification, but it stops at the model. SpeckDL starts at the model and compiles forward into production code.

| TLA+ | SpeckDL |
|------|---------|
| Mathematical modeling | Compilable specifications |
| TLC model checker | WASM runtime verification |
| LaTeX pretty-printing | TypeScript production code |
| Academic/Amazon use | CI/CD integration target |

## Tech stack

- Parser: Custom recursive descent (TypeScript, ~800 lines)
- Generators: TypeScript state machine, WASM (WAT text format), PROV-O (RDF/Turtle), CycloneDX JSON, SPDX JSON
- Build: TypeScript → Node.js CLI, `tsc --noEmit` clean
- Tests: 41 unit tests via Node test runner
- License: MIT

## What's next

- Parser support for `precondition:` / `postcondition:` declarative assertions
- Record type emission for generated TypeScript
- Light JS API for WASM modules
- Self-spec: The Speckl compiler, specified in SpeckDL

## Try it

- **Repo:** https://os.scoble.me/forgejo/sscoble/speckl
- **Mirror:** https://codeberg.org/sscoble/speckl
- **Docs:** https://os.scoble.me/forgejo/sscoble/speckl/src/branch/main/docs/speckl-by-example.md
- **Website:** https://speckl.scoble.me

Open source (MIT). Looking for feedback, contributors, and early adopters who want to kill spec-code drift.

---

## Publishing notes

**Targets:**
1. Hacker News (Show HN) — primary
2. r/programming — secondary (link to HN discussion)
3. r/rust (TigerBeetle angle) — tertiary
4. Dev.to — cross-post with full tutorial content

**Best posting times (PT):**
- HN: Mon-Fri 7-9 AM or 12-2 PM PT
- Reddit: Tue-Wed 6-9 AM PT

**Posting tips:**
- Post on HN as "Show HN:" (triggers Show tab placement)
- First comment: Add context about why this exists + link to tutorial
- Keep title under 80 chars
- Don't ask for upvotes
- Reply to comments within first hour
