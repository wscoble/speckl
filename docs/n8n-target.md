# n8n compile target

Builder Kit buyers keep one `.speckdl` spec and recompile it when a new target is added. `-t n8n` is that recompile for n8n. The approval wait, the reject stop, and the verify clause come from the spec, so a hand-drawn workflow does not drift away from them.

`speckl <file> -t n8n -o <out>` writes `<out>/n8n/<Speck>.workflow.json`, `<out>/n8n/<Speck>.verify.mjs`, and `<out>/n8n/README.md`. `-t all` and `-t all-ir` write those files when the n8n compile succeeds. `-t n8n` does not also write the timestamped provenance graph or the TypeScript machine.

The output is an n8n workflow you import and run on your own n8n. Speckl does not run it after import and does not watch it after import.

Not for regulated data without your own review. The workflow is general-purpose compiler output. It is not HIPAA-certified. You are responsible for your own compliance review. This output does not guarantee zero data retention (ZDR).

## Import

Import `*.workflow.json` in n8n with Workflows → Import from File. `active` is false. `settings.executionOrder` is `v1`. `pinData` is empty. `meta.templateCredsSetupCompleted` is false. The file has no live keys and no credential id. Bind any credential in n8n after import. A credential reference is the placeholder name only, of the form `{{ $env.NAME }}`.

## Approval gates

An `agent { await ... }` block becomes an `n8n-nodes-base.wait` node that resumes on a webhook, then an `n8n-nodes-base.if` gate. Post `{"outcome":"<name>"}` to the webhook. The true branch is only an outcome that is not marked `!`. That branch sets the stage and then runs later actions. Outcomes marked `!` use the false output, which connects only to `n8n-nodes-base.stopAndError`. The timeout is a second Wait on a time interval and connects only to that same Stop node. A reject outcome that names an earlier stage still stops. The reject branch and the timeout branch have no path to a later action. The workflow does not loop back into an action.

The Wait node does not check a signal signature. `bind call` digests are not enforced. An await with no timeout fails the compile and writes no file.

## Verify script

`node <Speck>.verify.mjs` reads the workflow next to it. Exit 0 means every invariant, constraint, and `verify Always(...)` held on the straight-line trace, and every later action is reachable from Start only through the approval Wait. Exit 1 means a check failed. Those checks run only where this compile wrote them: in the code nodes that carry a translated check, and in this script. They do not run anywhere else. The script does not run n8n. It is not a model check. A recorded `depth` does not change the check.

## What compiles

Emitted, when the expression translates and the await has a timeout: `state`, `init`, straight-line actions (`require`, `precondition`, `postcondition`, `let`, assign, `emit`, `return`), `constraint`, `invariant`, `verify`, and `agent` awaits.

A string from the spec is data. The characters `{{` in that string are written as unicode escapes, so n8n does not evaluate them as an expression.

Node ids are a slug plus a sha256 prefix of the speck name and the node name. Two specks that use the same action name get different ids. Names inside one workflow are unique. Positions are a fixed grid. Nothing in the n8n directory reads the clock, a random source, or a host path.

## Limits

Each row is a construct this target does not emit. The compile fails and writes no n8n file. `-t all` and `-t all-ir` still write the other targets and do not write the n8n files for that spec.

- `oneof` fails the compile and writes no file.
- `transition` fails the compile and writes no file.
- An `if` body fails the compile and writes no file.
- A `for` loop fails the compile and writes no file.
- `forall` fails the compile and writes no file.
- `in` fails the compile and writes no file.
- `Eventually` fails the compile and writes no file.
- An unknown call fails the compile and writes no file.
- An await with no timeout fails the compile and writes no file. The Wait node is not written.
- A string that looks like a live key fails the compile and writes no file. The key text is not in the error.
- Any other expression this target cannot translate fails the compile and writes no file.
- A timeout whose outcome is not a reject outcome fails the compile and writes no file.

These are not nodes, and they are not a failed compile: formal-spec `input` and `output`, `interface`, `event` (a translated `emit` appends to the item), provenance and review members, `service`, lifecycle fields, and `next:`. `next:` is not scheduled. Actions before the first await are chained, then the gates, then later actions.

The workflow does not check a signal signature and does not enforce `bind call` digests. A `require` that does not hold stops that n8n run. A reject that names an earlier stage still stops.

The output is a workflow file. You import it and run it on your own n8n. Speckl does not run it after import and does not watch it after import. The verify checks run only where they are compiled in.

`compiler/src/__tests__/n8n-target.test.ts` covers this page. The test names are `puts the approval Wait and If before OpenPR, and stops reject and timeout`, `fails the compile when an expression cannot be translated and writes no file`, `a Wait node with no timeout fails the compile`, `spec text is escaped and is not an n8n expression`, `credential references are placeholders by name only`, `rejected and timed-out branches have no path to a downstream action`, `node ids and names are stable and collision-free across specs with the same step name`, `recompiles to the same bytes in two directories`, `writes no workflow when a literal looks like a secret, and a real workflow has no credentials`, and `carries the regulated-data disclaimer and no secret material`.
