# speckl

The Speckl compiler for SpeckDL, a specification language for state machines.
One spec compiles to:

- TypeScript, Rust, Go and Elm machines
- Z3 SMT-LIB2 bounded model checking
- Protobuf, Kubernetes CRDs, OpenAPI 3.1 and Apache Camel routes
- agent rails: `AGENTS.md`, `tools.json`, a pre/post tool hook, and adapters for Claude Code, Cursor, Codex CLI and Gemini CLI
- CycloneDX / SPDX SBOMs with PROV-O provenance

Speckl is not published to npm. From the repository root of a checkout (`compiler/package.json` `engines` declares Node.js `>=20`; these steps were run on Node 20.20.2 and Node 22.23.4):

```bash
cd compiler
npm ci
npm run build
node dist/index.js --help
node dist/index.js ../examples/ToggleSwitch.speckdl -t all -o out
node dist/index.js verify ../examples/ToggleSwitch.speckdl   # needs the z3 binary
```

If `NODE_ENV=production`, `npm ci` omits TypeScript and the build fails; use `npm ci --include=dev`.

`speckl` and `speckl-compile` are the same program (`speckl-compile` is the older name). To put both on your `PATH`, pack this checkout and install the tarball `npm pack` writes:

```bash
npm pack
npm install -g --prefix "$HOME/.local" ./speckl-*.tgz
export PATH="$HOME/.local/bin:$PATH"
speckl --help
speckl-compile --help
```

The packed `speckl` does not include `examples/`. `speckl verify` with no spec paths fails. Pass a spec, or `--examples <dir>`.

Docs, examples and the changelog: <https://github.com/wscoble/speckl>.
Agent harness wiring: <https://github.com/wscoble/speckl/blob/main/docs/harness-adapters.md>.

MIT licensed.
