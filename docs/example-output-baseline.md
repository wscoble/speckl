# Example output baseline

`compiler/src/__tests__/fixtures/trace/example-output-baseline.json` stores a short digest of each example's `-t all` and `-t all-ir` output.
Four files are allow-listed and skipped in both loops: `agent/hook.mjs`, `agent/state-integrity.mjs`, `agent/AGENTS.md`, and `agent/README.md`. A missing allow-listed file does not fail. A changed allow-listed file does not fail this check. A changed non-allow-listed digest fails. A file the baseline does not list fails. A missing baseline key fails.

`SPECKL_WRITE_BASELINE=1` rewrites the JSON. CI does not set that variable. `OUTPUT_SHA256` is a separate pin of every digest, including the four allow-listed files. A change to an allow-listed file still moves that pin. The baseline does not decide whether the hook is correct and does not rewrite the hook.

`compiler/src/__tests__/compile-pipeline.test.ts` covers `ignores an allow-listed hook file and rejects a changed artifact`, `does not fail when an allow-listed file is missing from the fresh compile`, `rejects a file the baseline does not list`, `rejects a target the baseline does not list`, and `pins -t all and -t all-ir for every example`.
