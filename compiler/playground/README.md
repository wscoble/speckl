# Speckl playground

Edit a `.speckdl` spec in the browser. Diagnostics (with line numbers) and the compiled files update as you type: `AGENTS.md`, the hook, and the other targets this compiler emits.

The page runs the compiler from this repository. It is not a second implementation. A Web Worker does the compile so a bad spec cannot lock the tab. Nothing is uploaded.

Z3 does not run in the browser. The page says so once, as a note, and counts checks the compiler could not prove. `speckl verify` on a machine with the `z3` binary is the solver proof. Share links are `#s2.` (a checksum, so a cut-off link is rejected). Older `#s1.` links still open.

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

Serve `index.html` with `Cache-Control: no-cache` (revalidate on every load). The script and style URLs are content-hashed, so those files can be cached for a long time (`Cache-Control: public, max-age=31536000, immutable`). If `index.html` is cached across a deploy, the browser asks for the previous hashed files, they 404, and the page stays on “Loading the Speckl compiler…”. A failed script or worker load now says “Couldn't load the compiler. Refresh the page.” Refresh only helps after `index.html` itself is no longer stale, which is what `no-cache` on that one file is for.

`speckl.scoble.me` is not built from this repository. The existing `/demo/` page is a static walkthrough, not this playground. Putting `dist/` on that site, and linking it, is a hosting decision.

## Checks

```bash
npm test          # compiler tests, including the browser entry and a bundle smoke test
npm run test:e2e  # builds the page and runs the Playwright abuse suite
```
