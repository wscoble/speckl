# n8n compile target

Builder Kit buyers keep one `.speckdl` spec and recompile it when a new target is added. `-t n8n` is that recompile for n8n. The approval wait, the reject stop, and the verify clause come from the spec, so a hand-drawn workflow does not drift away from them.

`speckl <file> -t n8n -o <out>` writes `<out>/n8n/<Speck>.workflow.json`, `<out>/n8n/<Speck>.verify.mjs`, and `<out>/n8n/README.md`. `-t all` and `-t all-ir` write those files when every expression translates. `-t n8n` does not also write the timestamped provenance graph or the TypeScript machine.

Not for regulated data without your own review. The workflow is general-purpose compiler output. It is not HIPAA-certified. You are responsible for your own compliance review. This output does not guarantee zero data retention (ZDR).

## Import

Import `*.workflow.json` in n8n with Workflows → Import from File. `active` is false. `settings.executionOrder` is `v1`. `pinData` is empty. `meta.templateCredsSetupCompleted` is false. The file has no live keys. Bind any credential in n8n after import. A credential reference you add has to be an n8n expression of the form `{{ $env.NAME }}`.

## Approval gates

An `agent { await ... }` block becomes an `n8n-nodes-base.wait` node that resumes on a webhook, then an `n8n-nodes-base.if` gate. Post `{"outcome":"<name>"}` to the webhook. The true branch is only an outcome that is not marked `!`. That branch sets the stage and then runs later actions. Outcomes marked `!` use the false output, which connects only to `n8n-nodes-base.stopAndError`. The timeout is a second Wait on a time interval and connects only to that same Stop node. A reject outcome that names an earlier stage still stops. The workflow does not loop back into an action.

The Wait node does not check a signal signature. `bind call` digests are not enforced.

## Verify script

`node <Speck>.verify.mjs` reads the workflow next to it. Exit 0 means every invariant, constraint, and `verify Always(...)` held on the straight-line trace, and every later action is reachable from Start only through the approval Wait. Exit 1 means a check failed. The script does not run n8n. It is not a model check. A recorded `depth` does not change the check.

## What compiles

Emitted, when the expression translates: `state`, `init`, straight-line actions (`require`, `precondition`, `postcondition`, `let`, assign, `emit`, `return`), `constraint`, `invariant`, `verify`, and `agent` awaits.

Rejected at compile time: `oneof` and `transition`. An await whose timeout is not a reject outcome is also rejected.

An `if` body, `Eventually`, `in`, `forall`, an unknown call, and any other expression this target cannot translate fail the compile. `-t n8n` writes no file. `-t all` and `-t all-ir` still write the other targets and do not write the n8n files for that spec.

Not written as nodes, and not a failed compile: formal-spec `input` and `output`, `interface`, `event` (a translated `emit` appends to the item), provenance and review members, `service`, lifecycle fields, and `next:`.

Node ids are a slug plus a sha256 prefix of the speck name and the node name. Positions are a fixed grid. Nothing in the n8n directory reads the clock, a random source, or a host path.

`compiler/src/__tests__/n8n-target.test.ts` compiles `examples/AgentPolicy.speckdl` and other specs, checks the import shape, the Wait and If routing, reject and timeout isolation, a secret scan, byte-identical recompiles, the verify script's exit status, a compile that stops with no file written, and this disclaimer.
