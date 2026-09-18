# speckl-serve - Agent Contract v0.1 (alpha)

HTTP API for external harnesses, agents, and GPTs to drive spec development.
Localhost-only, dependency-free. Run with:

```bash
cd studio && node serve.ts        # → http://localhost:7343
```

Env: `SPECKL_REPO`, `SPECKL_BIN`, `Z3_BIN`, `SPECKL_SESSIONS`, `PORT`.

## Contract

### `POST /sessions` → `{ "id": "<workspace id>" }`
Creates an isolated workspace. All spec I/O is confined to it.

### `GET /health` → `{ ok, api, version, contract }`

### `GET /examples` → `[ "ToggleSwitch", … ]`
### `GET /examples/:name` → SpeckDL source
Reference specs bundled with the compiler.

### `GET /session/:id/specs/:name` → SpeckDL source (404 if missing)

### `POST /session/:id/specs/:name` `{ content }` → `{ ok, diagnostics }`
Saves and compiles the spec (TypeScript target) - `ok: false` + `422` on
compile failure, `diagnostics` carries compiler output. Spec names must match
`[A-Za-z][A-Za-z0-9_]{0,63}`.

### `POST /session/:id/verify/:name` `{}` → `{ ok, checks, report }`
Compiles to Z3, runs the real solver, returns one entry per check:

```json
{
  "ok": true,
  "checks": [
    { "file": "CallSession.smt2", "check": "Always(PhaseInDomain) for 6 steps",
      "expect": "unsat", "got": "unsat", "verdict": "pass", "advisory": false }
  ]
}
```

- `verdict`: `pass` · `violated` · `contradictory` · `unexpected` · `error`
- `advisory: true` - the model is degraded (skipped constructs); the result
  is a consistency check, **not a proof**. The `skipped` array names the
  constructs blocking a real proof (the remediation path).
- `detail` on `violated` - bounded counterexample trace.
- Solver errors are fatal: results after a real z3 error are reported as
  `error`, never as a pass.

### `GET /session/:id/folds/:name` → AST structure
Line spans from the compiler's parser:

```json
[ { "name": "SignalBus", "startLine": 270, "endLine": 336 }, … ]
```

## Design notes

- Deterministic: identical spec + identical depth ⇒ identical verdicts. Agents
  can cache and trust results.
- Honesty is structural: the API never reports a proof the solver didn't
  deliver; degraded checks are marked, never hidden.
- v0.2 candidates: `diff` endpoint (spec versions), `counterexample`
  normalization (JSON, not S-expr), chat endpoints (interview protocol).