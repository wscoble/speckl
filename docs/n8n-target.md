# n8n compile target

Builder Kit buyers keep one `.speckdl` spec and recompile it when a new target is added. `-t n8n` is that recompile for n8n. The approval wait, the reject stop, and the verify clause come from the spec, so a hand-drawn workflow does not drift away from them.

`speckl <file> -t n8n -o <out>` writes `<out>/n8n/<Speck>.workflow.json`, `<out>/n8n/<Speck>.verify.mjs`, and `<out>/n8n/README.md`. `-t n8n` does not also write the timestamped provenance graph or the TypeScript machine.

The output is an n8n workflow you import and run on your own n8n. Speckl does not run it after import and does not watch it after import. Test `imports every generated example workflow with n8n import:workflow` in `compiler/src/__tests__/n8n-live.test.ts` runs `n8n import:workflow` on every generated example workflow, against n8n 2.48.7 pinned by image digest.

Not for regulated data without your own review. The workflow is general-purpose compiler output. It is not HIPAA-certified. You are responsible for your own compliance review. This output does not guarantee zero data retention (ZDR).

## Import

Import `*.workflow.json` in n8n with Workflows → Import from File. `active` is false. `settings.executionOrder` is `v1`. `pinData` is empty. `meta.templateCredsSetupCompleted` is false. The file has no live keys, no credentials object, and no credential id.

A string in the spec is literal data. It is not an n8n env binding. The compiler does not emit a live env expression for it.

## Approval gates

An `agent { await ... }` block becomes one `n8n-nodes-base.wait` node, a Resume code node, and an `n8n-nodes-base.if` gate.

The Wait node this compile emits has `resume` `webhook`, `httpMethod` `POST`, and Limit Wait Time on that same node (`limitWaitTime` true, `limitType` `afterTimeInterval`, `resumeAmount` and `resumeUnit` from the spec timeout). There is no second Wait and no `timeInterval` node. Test `posts approve, keeps the pre-wait ticket, and stays successful past the Wait limit` posts an approve, then waits past the limit, and the run stays successful. The emitted parameters and edges are also checked by `webhook resume keeps the pre-wait item and the If reads body.outcome`.

Post this JSON to the Wait resume URL:

```json
{"outcome":"<name>"}
```

The emitted If left value is `={{ $json.body.outcome }}`. The Resume node reads the pre-wait item with `$('NodeName').item.json`, where `NodeName` is the node that links into the Wait, copies those fields, and sets `body` from `incoming.body` when `incoming.headers` is an object. A state field named `headers` fails the compile, so a timeout item cannot be mistaken for that webhook shape by a field of that name. The true branch is only an outcome that is not marked `!`. That branch sets the stage and then runs later actions. The false output connects only to `n8n-nodes-base.stopAndError`. A reject outcome that names an earlier stage still stops. The Stop node has no path to a later action. The workflow does not loop back into an action. Test `posts approve, keeps the pre-wait ticket, and stays successful past the Wait limit` shows the posted JSON at `body` and the downstream action still holding the pre-wait fields. Test `a short timeout ends at Stop and Error` shows a timeout resume with the pre-wait item, no webhook headers, and an empty `body`.

`incomingAuthentication` is `none`. The node has no credentials. Test `posts approve, keeps the pre-wait ticket, and stays successful past the Wait limit` posts `{"outcome":"approve"}` with no credential, and n8n accepts it. After import, open the Wait node and set Authentication to Basic Auth (`basicAuth`), Header Auth (`headerAuth`), or JWT Auth (`jwtAuth`), then attach the matching credential you create in n8n (`httpBasicAuth`, `httpHeaderAuth`, or `jwtAuth`). This file does not contain that credential. Test `a resume POST without the header auth credential is refused` turns Header Auth on for that run and a POST without the header is refused. Basic Auth and JWT Auth are not covered by that test. The emitted parameter is `none`.

The Wait node does not check a signal signature. `bind call` digests are not enforced. An await with no timeout fails the compile and writes no file.

## Verify script

`node <Speck>.verify.mjs` reads the workflow next to it. Exit 0 means every invariant, constraint, and `verify Always(...)` held on the straight-line trace, and every later action is reachable from Start only through the approval Wait. Exit 1 means a check failed. Those checks run only where this compile wrote them: in the code nodes that carry a translated check, and in this script. They do not run anywhere else. The script does not run n8n. It is not a model check. A recorded `depth` does not change the check.

## What compiles

Emitted, when the expression translates and the await has a timeout whose outcome is a reject: `state`, `init`, straight-line actions (`require`, `precondition`, `postcondition`, `let`, assign, `emit`, `return`), `constraint`, `invariant`, `verify`, and `agent` awaits.

A string from the spec is data. In a code node, `{{` and `}}` inside that string are unicode escapes, so the parameter text does not contain those two-character sequences. Every other parameter string is rejected if it contains `{{` or `}}` or starts with `=`. The one expression this target emits on purpose is the If left value `={{ $json.body.outcome }}`.

Each node id is a speck slug, a name slug, and 16 hex characters. Those 16 characters are the first 16 characters of sha256 of the bytes `speckl-n8n`, a NUL, the speck name, a NUL, and the node name. If that id is already used, the compiler appends `-2`, then `-3`, and so on, until the id is new. Two specks that use the same action name get different ids. Names inside one workflow are unique. Positions are a fixed grid. Nothing in the n8n directory reads the clock, a random source, or a host path.

## `-t all` and `-t all-ir`

`-t n8n` throws and writes no n8n file when this target rejects the spec. The process exits 1.

Compared with main, `-t all` and `-t all-ir` still stop when any backend other than n8n rejects the spec. `oneof` and `transition` are rejected by k8s before n8n runs, the same way main stops, so both modes throw, the process exits 1, and no file is written. That is the same exit as main. The n8n directory is not written.

An n8n-only failure is the one exception, and it is new relative to main because main has no n8n target. The failures are an expression n8n cannot translate, a Wait with no timeout, a timeout outcome that is not a reject when the agent target does not also reject it, a secret-like literal, a parameter n8n would treat as an expression, and a state field named `headers`. The log line is `Skipped backend: n8n` followed by the reason. The other targets are still written. The process exits 0. If that skip would write no file, the process exits 1. No partial n8n file is written. A timeout outcome that is not a reject is also an agent-block error, so `-t all` still throws at the agent target after n8n is named as skipped. `-t all-ir` does not run the agent target, so that same spec skips n8n, writes the other all-ir targets, and exits 0.

## Limits

Each row is something this target does not do. The test name is in `compiler/src/__tests__/n8n-target.test.ts` or `compiler/src/__tests__/n8n-live.test.ts`, or the row says it is untested.

- `oneof` fails `-t n8n` and writes no file. Test: `rejects oneof instead of dropping it`. `-t all` and `-t all-ir` throw, exit 1, and write no file. Test: `oneof and transition stop -t all and -t all-ir`. The CLI exit code is tested by `the speckl CLI exits 1 for oneof and transition, and exits 0 when only n8n is skipped`.
- `transition` fails `-t n8n` and writes no file. Test: `transition fails the compile and writes no n8n file`. `-t all` and `-t all-ir` throw and exit 1. Same two tests.
- An `if` body fails the compile and writes no file. Test: `an if body fails the compile and writes no n8n file`.
- A `for` loop fails the compile and writes no file. Test: `for fails the compile and writes no n8n file`.
- `forall` fails the compile and writes no file. Test: `forall fails the compile and writes no n8n file`.
- `in` fails the compile and writes no file. Test: `in fails the compile and writes no n8n file`.
- `Eventually` fails the compile and writes no file. Test: `Eventually fails the compile and writes no n8n file`.
- An unknown call fails the compile and writes no file. Test: `fails the compile when an expression cannot be translated and writes no file`.
- An await with no timeout fails the compile and writes no file. The Wait node is not written. Test: `a Wait node with no timeout fails the compile`.
- A timeout whose outcome is not a reject fails `-t n8n` and writes no file. Test: `a timeout outcome that is not a reject fails the compile and writes no n8n file`. `-t all` still throws, because the agent target rejects that await. `-t all-ir` skips n8n, names it, and writes the other all-ir targets. Test: `oneof and transition stop -t all and -t all-ir`.
- A string that looks like a live key fails the compile and writes no file. The key text is not in the error. Test: `writes no workflow when a literal looks like a secret, and a real workflow has no credentials`.
- A parameter that contains `{{` or `}}`, or starts with `=`, fails the compile, except the If left value. Test: `rejects {{, }}, and a leading = in every parameter slot`. A spec string is escaped instead, and the value that the code evaluates to is the original text. Test: `spec text is escaped and is not an n8n expression`.
- A spec string is literal data. It is not an n8n env binding. The workflow has no credentials object. Test: `spec strings are literal data and are not n8n env bindings`.
- Any other expression this target cannot translate fails `-t n8n` and writes no file. On `-t all` and `-t all-ir` the log says `Skipped backend: n8n`, the other targets are still written, and the process exits 0. Test: `fails the compile when an expression cannot be translated and writes no file` and `the speckl CLI exits 1 for oneof and transition, and exits 0 when only n8n is skipped`.
- A state field named `headers` fails the compile and writes no n8n file. Test: `rejects a state field named headers`. The Resume node would otherwise treat an item with an object `headers` as a webhook.
- The webhook resume copies the pre-wait item and the If reads `$json.body.outcome`. Wiring test: `webhook resume keeps the pre-wait item and the If reads body.outcome`. Live test: `posts approve, keeps the pre-wait ticket, and stays successful past the Wait limit`.
- Limit Wait Time is on the one Wait. A reject and a timeout have no path to a later action in the emitted graph. Test: `rejected and timed-out branches have no path to a downstream action`. Live n8n ends a reject at Stop and Error (`posts reject and the run ends at Stop and Error`) and ends a short timeout the same way (`a short timeout ends at Stop and Error`). After an approve, the same run stays successful past the Wait limit (`posts approve, keeps the pre-wait ticket, and stays successful past the Wait limit`).
- `incomingAuthentication` is `none`. The approve test posts with no credential and n8n accepts it. Adding Basic Auth, Header Auth, or JWT Auth is a step you take in n8n after import. Test `a resume POST without the header auth credential is refused` turns Header Auth on and a POST without the header is refused. Basic Auth and JWT Auth are not covered by that test.
- Node ids are a 16-hex sha256 prefix, and a third collision does not reuse `-2`. Test: `node ids stay unique past a third copy of the same id`. Ids are stable across two compiles. Test: `node ids and names are stable and collision-free across specs with the same step name`.
- Two compiles of the same spec are byte-identical. Test: `recompiles to the same bytes in two directories`.

These are not nodes, and they are not a failed compile: formal-spec `input` and `output`, `interface`, `event` (a translated `emit` appends to the item), provenance and review members, `service`, lifecycle fields, and `next:`. `next:` is not scheduled. Actions before the first await are chained, then the gates, then later actions.

The workflow does not check a signal signature and does not enforce `bind call` digests. A `require` that does not hold stops that n8n run. A reject that names an earlier stage still stops. Test: `keeps a reject and a timeout off every later action, including a reject back to an earlier stage`.

The output is a workflow file. You import it and run it on your own n8n. Speckl does not run it after import and does not watch it after import. The verify checks run only where they are compiled in. The verify script does not run n8n. It is not a model check.
