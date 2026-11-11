# Line-walker copy

This directory is a callable copy of the line walker: `parser.ts` and `speck-part0.ts` through `speck-part9.ts`.

It is test-only. Production never imports it. `parseSpeckContent` in `compiler/src/parser.ts` calls `parseSpeckDocument`. `is imported only by tests` in `compiler/src/__tests__/line-walker-copy.test.ts` fails if any file outside `compiler/src/__tests__/` imports `line-walker/`.

`walker-vs-rd.test.ts` compares this copy with that live parser. `lowers every speck in the repo to the same IR` is the check that they match. Delete this directory and the tests that import it (`line-walker-copy.test.ts` and `walker-vs-rd.test.ts`) when that comparison is no longer run.
