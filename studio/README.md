# speckl-studio

A local conversational studio for developing SpeckDL behavior specifications with an AI partner.

You describe a system's behavior in plain language. The assistant interviews you on edge
cases and failure modes, drafts a SpeckDL spec, compiles it with the real `speckl-compile`
toolchain, verifies it with a real Z3 solver, reports the verdict honestly (including
degraded/advisory checks), and then critiques its own work: missing invariants, unintended
nondeterminism, edge cases you haven't covered.

## Run

```bash
cd studio
npm start          # → http://localhost:7333
```

Requirements:
- Node ≥ 22
- Ollama running locally with `glm-5.3-flash:cloud` (or set `OLLAMA_MODEL`)
- `z3` binary on PATH (or set `Z3_BIN`)
- speckl repo at `~/Projects/speckl` (or set `SPECKL_REPO`); compiler built
  (`cd ~/Projects/speckl/compiler && npm run build`)

## Configuration (environment)

| Variable | Default | Meaning |
|---|---|---|
| `OLLAMA_HOST` | `http://localhost:11434` | Ollama endpoint |
| `OLLAMA_MODEL` | `glm-5.3-flash:cloud` | Chat model |
| `SPECKL_REPO` | `~/Projects/speckl` | Repo holding compiler, examples, SPEC.md |
| `SPECKL_BIN` | `$SPECKL_REPO/compiler/dist/index.js` | Compiler binary |
| `Z3_BIN` | `z3` | Solver binary |
| `SPECKL_SESSIONS` | `studio/sessions` | Where conversations + specs live |
| `PORT` | `7333` | HTTP port |

Binds to 127.0.0.1 only. Runs entirely locally.

## How it works

- **server/index.ts** - HTTP server: session CRUD, spec read/write, verify, SSE chat streaming
- **server/ollama.ts** - Ollama `/api/chat` streaming client with tool-calling
- **server/tools.ts** - the AI's hands: `list_examples`, `read_example`, `write_spec`
  (save + compile → diagnostics), `verify_spec` (compile to Z3 → run real solver →
  per-file verdicts with counterexample traces)
- **server/prompt.ts** - system prompt, built at startup from the repo's own `SPEC.md`
  and examples index, so it never drifts from the language
- **web/** - dependency-free vanilla UI: streaming chat on the left, spec editor +
  compile/verify output on the right

## Verification semantics

The tool reports exactly what the solver said, per emitted `.smt2` file:

- `PASS` - solver result matched the compiler's expectation marker
- `VIOLATED` - property violated within the BMC depth (counterexample trace included);
  marked **[advisory]** when the model is degraded (skipped constructs), since the trace
  may be spurious
- `CONTRADICTORY` - constraints are unsatisfiable
- `SOLVER ERROR` - Z3 rejected the file (generator bug)

Degraded expectations (compiler downgrades `unsat` to `sat` when forms are skipped) are
surfaced in the report so the AI can't overclaim a proof.

## Known compiler interactions (as of speckl 0.3.1)

- Single-line blocks (`invariant X { p }`) degrade Z3 lowering - the prompt requires
  multi-line block style
- `verify` blocks must appear before `next:`, or the parse corrupts
- BMC transition constraints referencing `Step`/`Action`/`Stuttering` are dropped for
  some spec shapes, downgrading unrolled checks to advisory

## Future

Plugins, extensions, or GPTs so others can consume spec-development conversations with
their own harnesses for behavior-specific problems. The tool-calling contract here
(`write_spec` / `verify_spec` / `read_example`) is the seed of that interface.