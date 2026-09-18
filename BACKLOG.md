# Speckl Backlog

Work items for AI agents (and humans) to pick up. Each item is scoped to be
executable without tribal knowledge: context, tasks, and acceptance criteria
with concrete commands. An item is done when its acceptance criteria pass and
the work is committed.

**Ground rules for agents:**
- Work happens in `~/Work/speckl` (workspace); compiler changes land in `~/Projects/speckl` on branch `greybeard-platform`
- `~/Projects/speckl/compiler`: `npm test` (146 unit tests) and `npm run verify` (real-solver Z3 over all examples) must pass before any commit - current baseline 142/144, with the 2 known GreybeardCore failures tracked as B-06
- Push with `git -c credential.helper='!gh auth git-credential' push origin <branch>` (home-manager git config is read-only, so the credential helper is per-invocation)
- The studio at `~/Work/speckl/studio` runs locally via `npm start`; specs in `~/Work/speckl/specs/` are the review corpus - GreybeardConsole is fully proven (16/16) and serves as the regression showcase
- Never claim compile/verify results not observed from tool output; degraded/advisory results must be reported as such

---

## P0 - Verification depth (the core value proposition)

Speckl's differentiator is machine-checked behavior specs. Every check that
silently degrades to "consistency only" is a promise the product can't keep.

### B-01 · Typed lowering for post-state notation (`x'`)
Post-state invariants (`currentTerm' >= currentTerm`) currently fall back to
the legacy regex translator and degrade to consistency checks.
- Unroll post-state references per BMC step (`x'_i → x_{i+1}`) in the state-machine generator
- Remove the `'` guard in `translateInvariantExpr` (`src/generators/z3.ts`) once typed translation handles it
- Acceptance: KafkaKRaft's `TermMonotonicity` / `LeaderAppendOnly` emit real BMC checks (expect `unsat`) with zero `degraded: post-state` markers; `npm run verify` stays ≥142/144

### B-02 · Quantifier sugar lowering (`forall` / `exists`)
`forall x in coll: expr` is parsed but never lowered to SMT - invariants using
it silently degrade (`NoTokenLeakage` in OAuth2, half the interesting specs).
- Implement domain-sort inference over `coll.keys` / `coll.values` / ranges
- Lower to `(forall ((x S)) body)` with proper bound-variable handling in the typed path
- Remove the `forall|exists` sugar guard in `translateInvariantExpr` once typed lowering works
- Acceptance: an OAuth2-style spec with quantified invariants verifies non-degraded; GreybeardConsole stays 16/16

### B-03 · `let` bindings in expressions
`let x := expr` appears in invariants (OAuth2 uses it heavily). Same treatment
as B-02: typed lowering or explicit fallback with a diagnostic.

### B-04 · Retire the regex expression translator
`translateExpr` in `src/generators/z3.ts` is ~25 layered regex passes - the
source of the original mangling. Once B-01/B-02/B-03 land:
- Route every expression through the typed IR path; keep regex only as an
  explicitly-documented last resort, then delete it
- Delete `parseInvariantsFromSource` remnants and the `_invariants`/`_next`
  raw-source scraping (`next:` scraping is B-07)
- Acceptance: no callers of the regex translator outside the fallback shims; example suite unchanged or improved

### B-05 · Invariants in the IR formal-spec facet
Imperative-form invariants currently bypass the IR - `.ir.smt2` files only
consistency-check them, and `Always(Name)` there emits `(Always Name)` garbage.
- Lower invariant members into `formal_spec` as typed facts (mirror constraints)
- Implement `Always(Name)` BMC in `z3-from-ir.ts` (define per-step instances, assert negation) - the state-machine generator already has the reference implementation
- Acceptance: `.ir.smt2` files carry real BMC checks for imperative invariants; no `references undeclared identifier(s): Always, <name>` skips

### B-06 · Fix the 2 pre-existing GreybeardCore example failures
`npm run verify` → `invalid sort declaration, sort already declared/defined`
(line 7, both ast and ir variants). Pre-dates the proof work; likely a
duplicate `declare-sort` emitted by two generators colliding.

### B-07 · Parser: `next:` as a first-class member
`next: A | B` is still scraped from raw source (`parseNextFromSource`).
Parse it in `parseSpeck` (with line spans, like invariants) and retire the
scraping. Note: `verify` blocks currently must precede `next:` or the parse
corrupts (studio works around it) - fix the grammar so member order is free.

### B-08 · Single-line block degradation
`invariant X { p }` single-line form parses but degrades Z3 lowering to
advisory. Either lower it correctly or reject it at parse time with a clear
diagnostic pointing at the line. Same for single-line `constraint`/`event` if
they share the defect.

---

## P1 - Studio capability

### B-09 · Compile diagnostics with positions
Nothing downstream can highlight errors because the parser is lenient and
diagnostics carry no line info (it accepted visibly broken input with "parsed
successfully"). Add structured diagnostics `{ line, message, severity }` to
the parser for genuinely unparseable input, surfaced by the compiler CLI as
JSON (`--diagnostics` flag).

### B-10 · `speckl-lsp`
The planned language server. With line spans (landed) and B-09 diagnostics,
an LSP gives: red squiggles, hover docs for invariants/actions, completion for
keywords/fields. Server in the compiler package; studio switches from the
hand-rolled overlay to LSP-driven markers.

### B-11 · Incremental verification
The studio re-verifies the whole file per edit. Verify only the speck under
the cursor (compile once per file, per-speck Z3 sections already exist).
Acceptance: editing a 500-line suite re-verifies in <500ms.

### B-12 · Plugin/extension API (the stated product goal)
Extract the studio's tool contract - `write_spec` / `verify_spec` /
`read_example` / `list_examples` - into a versioned, documented HTTP/JSON-RPC
API (localhost, optional token) so external harnesses and GPTs can drive
spec development. Ship as `speckl-serve`. The conversation protocol in
`studio/server/prompt.ts` is the seed of the spec.

### B-13 · Multi-file specs and imports
`import "common.speckdl" as common` is specified but the studio is
single-file. Workspace model: multiple spec files per session, import
resolution in compile, cross-speck verification.

### B-14 · Studio polish
Model picker (env is `OLLAMA_MODEL` today), session export to markdown, spec
version diff view (sessions already store history), acknowledge-advisory
pill state.

---

## P2 - Distribution and docs

### B-15 · Publish `speckl-compile` to npm
Package is prep-publish-ready (`prepublishOnly` wired). Publish 0.3.2 with
the proof work; tag releases.

### B-16 · Docs catch-up
README/SPEC still describe the old limitations (pre-proof). Update: real BMC
proofs for imperative invariants, push/pop isolation, reserved-word renaming,
counterexample reporting, studio workflow + screenshots, GreybeardConsole as a
worked example.

### B-17 · CI hardening
Add `npm run verify` already runs in CI - extend with: studio headless smoke
test (the chromium-based checks used during development), a regression spec
corpus (`~/Work/speckl/specs/`) verified on every PR, and issue templates for
bug/proof-gap reports.

---

## Done (for context - do not redo)

- Parser: invariant blocks + line spans as first-class members
- Z3: typed IR translation, reserved-word renaming, push/pop isolation, sanitizer fixes
- Studio: CodeMirror editor (folding, line numbers), live inline verification,
  readable counterexamples, severity model, session persistence
- GreybeardConsole behavioral suite: 16/16 checks proven after the
  SignalBus drain-before-close fix