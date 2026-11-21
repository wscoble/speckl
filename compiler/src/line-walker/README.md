# Line-walker copy

This directory is a callable copy of the line walker: `parser.ts` and `speck-part0.ts` through `speck-part9.ts`.

It is test-only. Production never imports it. `parseSpeckContent` in `compiler/src/parser.ts` calls `parseSpeckDocument`.

`compiler/src/__tests__/line-walker-copy.test.ts` compares this copy with that live parser.

- `lowers every speck in the repo to the same IR as the live parser` lowers this copy and the live parser over every `.speckdl` outside `node_modules`, `dist`, and `.git`. Both use `lower()` with `resolveImports: false`. The test compares `JSON.stringify` of the two IR values.
- `reports the same error as the live parser for each rejection fixture` expects `rejections.length` to be 25. The copy and the live parser must throw the same error string.
- `is imported only by tests` walks `compiler/src`, skips this directory, and fails if any file outside `compiler/src/__tests__/` imports `line-walker/`.

`walker-vs-rd.test.ts` compares this copy with `parseSpeckDocument`, after the same `setParseFile` call `parseSpeckContent` makes. `parseSpeckContent calls the token parser` asserts that `parser.ts` is the production file that imports `rd-parser.ts`.

Delete this directory and the tests that import it when those comparisons are no longer run.
