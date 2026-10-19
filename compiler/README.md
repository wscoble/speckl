# speckl

The Speckl compiler for SpeckDL, a specification language for state machines.
One spec compiles to:

- TypeScript, Rust, Go and Elm machines
- Z3 SMT-LIB2 bounded model checking
- Protobuf, Kubernetes CRDs, OpenAPI 3.1 and Apache Camel routes
- agent rails: `AGENTS.md`, `tools.json`, a pre/post tool hook, and adapters for Claude Code, Cursor, Codex CLI and Gemini CLI
- CycloneDX / SPDX SBOMs with PROV-O provenance

```bash
npm install -g speckl            # or: npx speckl --help
speckl spec.speckdl -t all -o out
speckl verify spec.speckdl       # runs z3 on every verify block (needs the z3 binary)
```

`speckl-compile` is installed as an alias of `speckl`.

Docs, examples and the changelog: <https://github.com/wscoble/speckl>.
Agent harness wiring: <https://github.com/wscoble/speckl/blob/main/docs/harness-adapters.md>.

MIT licensed.
