# Line-walker copy

This directory is a callable copy of the line walker: `parser.ts` and `speck-part0.ts` through `speck-part9.ts`.

It is test-only. Production never imports it. `parseSpeckContent` in `compiler/src/parser.ts` still calls the live line walker. `is imported only by tests` in `compiler/src/__tests__/line-walker-copy.test.ts` fails if any file outside `compiler/src/__tests__/` imports `line-walker/`.

`line-walker-copy.test.ts` lowers this copy and the live parser over every `.speckdl` in the repo and compares the IR. It also compares the error string for each rejection fixture from the strict-structure classes.

`walker-vs-rd.test.ts` is the comparison this copy exists for. That test arrives with the token parser, while `parseSpeckContent` still calls the line walker, and it stays after `parseSpeckContent` switches to the token parser. Delete this directory and the tests that import it (`line-walker-copy.test.ts` and `walker-vs-rd.test.ts`) when that comparison is no longer run.
