# Line-walker copy

This directory is a callable copy of the line walker: `parser.ts` and `speck-part0.ts` through `speck-part9.ts`.

It is test-only. Production never imports it. `parseSpeckContent` in `compiler/src/parser.ts` still calls the live line walker.

`compiler/src/__tests__/line-walker-copy.test.ts` is the check this copy exists for.

- `lowers every speck in the repo to the same IR as the live parser` lowers this copy and the live parser over every `.speckdl` outside `node_modules`, `dist`, and `.git`. Both use `lower()` with `resolveImports: false`. The test compares `JSON.stringify` of the two IR values.
- `reports the same error as the live parser for each rejection fixture` expects `rejections.length` to be 25. The copy and the live parser must throw the same error string.
- `is imported only by tests` walks `compiler/src`, skips this directory, and fails if any file outside `compiler/src/__tests__/` imports `line-walker/`.

Delete this directory and `line-walker-copy.test.ts` when that test is no longer run.
