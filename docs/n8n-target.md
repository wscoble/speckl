# n8n compile target

Builder Kit buyers keep one `.speckdl` spec and recompile it when a new target is added. `-t n8n` is that recompile for n8n. The approval wait, the reject stop, and the verify clause come from the spec, so a hand-drawn workflow does not drift away from them.

`speckl <file> -t n8n -o <out>` writes `<out>/n8n/<Speck>.workflow.json`, `<out>/n8n/<Speck>.verify.mjs`, and `<out>/n8n/README.md`. `-t n8n` does not also write the timestamped provenance graph or the TypeScript machine.

The output is an n8n workflow you import and run on your own n8n. Speckl does not run it after import and does not watch it after import. No test runs n8n.

Not for regulated data without your own review. The workflow is general-purpose compiler output. It is not HIPAA-certified. You are responsible for your own compliance review. This output does not guarantee zero data retention (ZDR).

## Import

Import `*.workflow.json` in n8n with Workflows → Import from File. `active` is false. `settings.executionOrder` is `v1`. `pinData` is empty. `meta.templateCredsSetupCompleted` is false. The file has no live keys, no credentials object, and no credential id.

A string in the spec is literal data. It is not an n8n env binding. The compiler does not emit a live env expression for it.

## Approval gates

An `agent { await ... }` block becomes one `n8n-nodes-base.wait` node, a Resume code node, and an `n8n-nodes-base.if` gate.

The Wait resumes on a webhook (`resume` is `webhook`, `httpMethod` is `POST`) and carries Limit Wait Time on that same node (`limitWaitTime` is true, `limitType` is `afterTimeInterval`, `resumeAmount` and `resumeUnit` are the spec timeout). There is no second Wait and no `timeInterval` node, so the timeout cannot fire after the webhook resumes.

Post this JSON to the Wait resume URL:

```json
{"outcome":"<name>"}
```

n8n puts that object on the resumed item at `body`. The posted value is `$json.body.outcome` on the webhook item. The webhook item replaces the pre-wait item. The Resume node reads the pre-wait item with `$('NodeName').item.json`, where `NodeName` is the node that links into the Wait, and copies those fields forward. It treats the incoming item as a webhook only when `headers` is an object, and then sets `body` from `incoming.body`. A timeout resumes with the pre-wait item, which has no webhook `headers`, so Resume sets `body` to an empty object. The If left value is `={{ $json.body.outcome }}` and the true branch is only an outcome that is not marked `!`. That branch sets the stage and then runs later actions. The false output connects only to `n8n-nodes-base.stopAndError`. A missing `body.outcome` takes that false output, so both a reject and a timeout stop. A reject outcome that names an earlier stage still stops. The Stop node has no path to a later action. The workflow does not loop back into an action.

`incomingAuthentication` is `none`. The node has no credentials. A POST of `{"outcome":"approve"}` is accepted. After import, open the Wait node and set Authentication to Basic Auth (`basicAuth`), Header Auth (`headerAuth`), or JWT Auth (`jwtAuth`), then attach the matching credential you create in n8n (`httpBasicAuth`, `httpHeaderAuth`, or `jwtAuth`). This file does not contain that credential. The live rejection of a forged POST is untested, because no test runs n8n. The emitted parameter is tested.

The Wait node does not check a signal signature. `bind call` digests are not enforced. An await with no timeout fails the compile and writes no file.

## Verify script

`node <Speck>.verify.mjs` reads the workflow next to it. Exit 0 means every invariant, constraint, and `verify Always(...)` held on the straight-line trace, and every later action is reachable from Start only through the approval Wait. Exit 1 means a check failed. Those checks run only where this compile wrote them: in the code nodes that carry a translated check, and in this script. They do not run anywhere else. The script does not run n8n. It is not a model check. A recorded `depth` does not change the check.

## What compiles

Emitted, when the expression translates and the await has a timeout whose outcome is a reject: `state`, `init`, straight-line actions (`require`, `precondition`, `postcondition`, `let`, assign, `emit`, `return`), `constraint`, `invariant`, `verify`, and `agent` awaits.

A string from the spec is data. In a code node, `{{` and `}}` inside that string are unicode escapes, so the parameter text does not contain those two-character sequences. Every other parameter string is rejected if it contains `{{` or `}}` or starts with `=`. The one expression this target emits on purpose is the If left value `={{ $json.body.outcome }}`.

Each node id is a speck slug, a name slug, and 16 hex characters. Those 16 characters are the first 16 characters of sha256 of the bytes `speckl-n8n`, a NUL, the speck name, a NUL, and the node name. If that id is already used, the compiler appends `-2`, then `-3`, and so on, until the id is new. Two specks that use the same action name get different ids. Names inside one workflow are unique. Positions are a fixed grid. Nothing in the n8n directory reads the clock, a random source, or a host path.

## `-t all` and `-t all-ir`

`-t n8n` throws and writes no n8n file when this target rejects the spec.

`-t all` and `-t all-ir` skip a backend that rejects the spec and still write a backend that accepts it. The skip is a conservation reject (`backend rejects AST node type`), an `N8nTranslateError`, or `agent block is invalid`. Any other error still stops the run. A skipped backend throws before it writes, so the run does not leave that backend's file behind. `-t agent` still throws `agent block is invalid` and writes no agent rails.

`oneof` and `transition` are rejected by every backend except protobuf. `-t all` writes the protobuf schema and does not write the n8n directory. `-t all-ir` does not include protobuf, and every backend it runs rejects those two members, so that compile writes no file for that spec and does not throw.

A failure that only n8n raises (an expression n8n cannot translate, a Wait with no timeout, a timeout outcome that is not a reject, a secret-like literal, or a parameter n8n would treat as an expression) is skipped on both `-t all` and `-t all-ir`. The other targets those modes include are still written. No partial n8n file is written.

## Limits

Each row is something this target does not do. The test column names the test in `compiler/src/__tests__/n8n-target.test.ts`, or says the row is untested.

- `oneof` fails `-t n8n` and writes no file. Test: `rejects oneof instead of dropping it`. On `-t all` the protobuf schema is still written and the n8n directory is not. Test: `continues -t all when n8n rejects oneof, transition, or a timeout that is not a reject`.
- `transition` fails `-t n8n` and writes no file. Test: `transition fails the compile and writes no n8n file`. On `-t all` the protobuf schema is still written and the n8n directory is not. Same continuation test.
- An `if` body fails the compile and writes no file. Test: `an if body fails the compile and writes no n8n file`.
- A `for` loop fails the compile and writes no file. Test: `for fails the compile and writes no n8n file`.
- `forall` fails the compile and writes no file. Test: `forall fails the compile and writes no n8n file`.
- `in` fails the compile and writes no file. Test: `in fails the compile and writes no n8n file`.
- `Eventually` fails the compile and writes no file. Test: `Eventually fails the compile and writes no n8n file`.
- An unknown call fails the compile and writes no file. Test: `fails the compile when an expression cannot be translated and writes no file`.
- An await with no timeout fails the compile and writes no file. The Wait node is not written. Test: `a Wait node with no timeout fails the compile`.
- A timeout whose outcome is not a reject fails the compile and writes no file. Test: `a timeout outcome that is not a reject fails the compile and writes no n8n file`. On `-t all` the other targets are still written and the n8n directory is not. Test: `continues -t all when n8n rejects oneof, transition, or a timeout that is not a reject`.
- A string that looks like a live key fails the compile and writes no file. The key text is not in the error. Test: `writes no workflow when a literal looks like a secret, and a real workflow has no credentials`.
- A parameter that contains `{{` or `}}`, or starts with `=`, fails the compile, except the If left value. Test: `rejects {{, }}, and a leading = in every parameter slot`. A spec string is escaped instead, and the value that the code evaluates to is the original text. Test: `spec text is escaped and is not an n8n expression`.
- A spec string is literal data. It is not an n8n env binding. The workflow has no credentials object. Test: `spec strings are literal data and are not n8n env bindings`.
- Any other expression this target cannot translate fails the compile and writes no file. Test: `fails the compile when an expression cannot be translated and writes no file`. On `-t all` the TypeScript machine is still written. Same test.
- The webhook resume wiring copies the pre-wait item and the If reads `$json.body.outcome`. Test: `webhook resume keeps the pre-wait item and the If reads body.outcome`. No test runs n8n, so a live n8n execution of that POST is untested.
- Limit Wait Time is on the one Wait. A reject and a timeout have no path to a later action. Test: `rejected and timed-out branches have no path to a downstream action`. The live fact that n8n will not fire the limit after the webhook resumes is untested, because no test runs n8n.
- `incomingAuthentication` is `none`. Test: `webhook resume keeps the pre-wait item and the If reads body.outcome`. Adding Basic Auth, Header Auth, or JWT Auth is a step you take in n8n after import. The live check that a forged POST is then refused is untested.
- Node ids are a 16-hex sha256 prefix, and a third collision does not reuse `-2`. Test: `node ids stay unique past a third copy of the same id`. Ids are stable across two compiles. Test: `node ids and names are stable and collision-free across specs with the same step name`.
- Two compiles of the same spec are byte-identical. Test: `recompiles to the same bytes in two directories`.

These are not nodes, and they are not a failed compile: formal-spec `input` and `output`, `interface`, `event` (a translated `emit` appends to the item), provenance and review members, `service`, lifecycle fields, and `next:`. `next:` is not scheduled. Actions before the first await are chained, then the gates, then later actions.

The workflow does not check a signal signature and does not enforce `bind call` digests. A `require` that does not hold stops that n8n run. A reject that names an earlier stage still stops. Test: `keeps a reject and a timeout off every later action, including a reject back to an earlier stage`.

The output is a workflow file. You import it and run it on your own n8n. Speckl does not run it after import and does not watch it after import. The verify checks run only where they are compiled in. The verify script does not run n8n. It is not a model check.
