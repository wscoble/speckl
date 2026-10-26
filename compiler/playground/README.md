# Speckl playground

Edit a `.speckdl` spec in the browser. Diagnostics (with line numbers) and the compiled files update as you type: `AGENTS.md`, the hook, and the other targets this compiler emits.

The page runs the compiler from this repository. It is not a second implementation. A Web Worker does the compile so a bad spec cannot lock the tab. Nothing is uploaded.

Z3 does not run in the browser. The page still shows obligations the compiler marks unchecked. `speckl verify` on a machine with the `z3` binary is the solver proof.

## Run it

From `compiler/`, after `npm ci`:

```bash
npm run playground
```

Open http://127.0.0.1:5173 . That is the one command once dependencies are installed.

## Deploy static files

```bash
npm run playground:build
```

Upload `compiler/playground/dist/`. Asset URLs are relative, so the folder can live at a site root or a subpath such as `/play/`. Any static host works. There is no server.

`speckl.scoble.me` is not built from this repository. The existing `/demo/` page is a static walkthrough, not this playground. Putting `dist/` on that site, and linking it, is a hosting decision.

## Checks

```bash
npm test          # compiler tests, including the browser entry and a bundle smoke test
npm run test:e2e  # builds the page and runs the Playwright abuse suite
```
