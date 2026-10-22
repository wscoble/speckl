# Writing a signal verifier plug-in

A wait state in an `agent { }` block waits for a **signal**: a verified
statement that something outside the agent happened, such as "carol approved
this review". `signal.mjs` (the human channel, never run by the agent) records
signals. It doesn't decide what counts as proof; a **verifier** does.

Two verifiers ship with the agent target: `file-drop` (ed25519-signed JSON)
and the dev-only `cli`. Anything else is a plug-in: a small ES module that
`signal.mjs` loads by path, after checking it against a sha256 pinned in the
signed state. This page covers the interface, the security contract, loading
and pinning, a worked example, the Sigstore reference plug-in, a testing
checklist and the limits.

## The interface

```ts
// A plug-in is an ES module (.mjs) with these exports.
export const name: string;                       // informational
export const devOnly?: boolean;                  // true: refused unless the state is --dev
export function checkConfig?(config: unknown):   // called once at init; optional
  { ok: true } | { ok: false; reason: string } | Promise<...>;
export function verify(
  opts: Record<string, string | true>,           // signal.mjs CLI options after --verifier
  expect: AwaitSpec,                             // what the machine is waiting for
  ctx: VerifierContext,                          // from the state file
): Promise<VerifyResult>;

type AwaitSpec = {
  signal: string;                                // e.g. "review", or "clear-pending"
  outcomes: string[];                            // allowed outcomes, e.g. ["approve", "reject"]
  claims: { name: string }[];                    // claims the signal must carry
};

type VerifierContext = {
  runId: string;                                 // random id printed by signal.mjs init
  dev: boolean;                                  // state created with --dev
  now: number;                                   // ms since epoch; use it, not Date.now()
  usedNonces: string[];                          // nonces already applied in this state
  config: unknown;                               // the plug-in's config, pinned at init
  plugin: string;                                // the name it was pinned under
};

type VerifyResult =
  | { ok: true; signal: VerifiedSignal }
  | { ok: false; reason: string };

type VerifiedSignal = {
  signal: string;                                // required
  outcome: string;                               // required
  claims: Record<string, unknown>;               // required (may be {})
  evidence: string;                              // required, 1-1000 chars, unique per approval
  subject?: string;                              // who signed, from the verified proof
  at?: string;                                   // ISO-8601
  run?: string;                                  // re-checked against the state if present
  expires?: string;
  nonce?: string;                                // re-checked and recorded if present
  callId?: string;                               // required for clear-pending
  [extra: string]: unknown;                      // kept in state.signalLog
};
```

After `verify` returns, `signal.mjs` applies its own checks before it moves
the machine: the result must have exactly `ok: true` and the required fields
(any other shape denies). `signal` must be the awaited signal and `outcome`
one of its outcomes, and every awaited claim must be present. `run` must
match the state if present. `nonce` must be unused if present, and
`evidence` must not have been applied before. `verifier` is overwritten with
`plugin:<name>`, so a plug-in can't relabel itself.

## Security contract

A plug-in is part of the trusted computing base for every approval it
accepts. It must:

1. **Fail closed.** Return `{ ok: false, reason }` for anything it can't
   prove, including errors it didn't expect. Wrap the body in `try`/`catch`.
   A throw, a hang past the timeout or a malformed result also denies, but an
   explicit reason is easier to debug.
2. **Never trust identity from the drop.** Who approved comes from the
   verified proof (a certificate, a key, a token's signed claims), checked
   against a policy in the pinned `ctx.config`. A `subject` field in the
   payload, or a `--identity` flag on the command line, must not decide or
   widen it.
3. **Bind the approval to this run, a deadline and a nonce.** Require `run`
   equal to `ctx.runId`, refuse at or after `expires` (compare with
   `ctx.now`), require a nonce of 8-200 chars that isn't in `ctx.usedNonces`,
   and return `run`, `expires` and `nonce` so `signal.mjs` re-checks and
   records them. Without these, one approval can be replayed or carried to
   another run.
4. **Check the signal and outcome.** Refuse a payload whose `signal` isn't
   `expect.signal`, and an `outcome` that isn't in `expect.outcomes`. Never
   default the signal.
5. **Return evidence.** `evidence` should identify the proof (a hash of the
   signed bytes, a log index, a token `jti`) so the approval can be audited
   and can't be applied twice.
6. **Be deterministic.** Given the same files, config and `ctx`, return the
   same answer. Use `ctx.now`, not the wall clock.
7. **Avoid the network unless the proof needs it,** and bound it with a
   timeout. `signal.mjs` enforces `timeoutMs` (default 30 s) around the whole
   call, but a plug-in should time out its own requests first.
8. **Keep config checks in `checkConfig`,** so a bad policy fails `init`
   instead of the first approval, and call it again inside `verify`.

## Loading and pinning

Plug-ins are pinned when the state is created. Write a plugins file:

```json
{
  "sigstore": {
    "module": "/opt/speckl/verifier-sigstore/index.mjs",
    "sha256": "<optional: expected sha256 of the module>",
    "timeoutMs": 30000,
    "config": { "...": "plug-in specific" }
  }
}
```

```
node signal.mjs init --state ./state.json --key /etc/speckl/state.key --plugins ./plugins.json
# {"ok":true,...,"plugins":{"sigstore":"<sha256>"}}
node signal.mjs apply --state ./state.json --verifier plugin:sigstore --file ./inbox/review.json
```

At init, for each entry, `signal.mjs`:

- checks the name (`[a-z0-9][a-z0-9-]{0,63}`, not `cli` or `file-drop`);
- resolves `module` to its realpath and hashes the file, then compares it
  with `sha256` if one is given;
- imports it, requires a `verify` function, refuses a `devOnly` plug-in in a
  non-dev state, and runs `checkConfig(config)` if exported;
- stores `{ module: <realpath>, sha256, timeoutMs, config }` under
  `state.plugins`.

`state.plugins` is covered by the state's HMAC and by the genesis hash of
its log. A hand edit of a pin or its config fails the HMAC check. The same
edit re-signed with the state key still breaks the log chain. Either way,
every later hook and signal call denies. To change a pin, create a new state
with `init`.

On `apply` / `clear-pending` with `--verifier plugin:<name>`, `signal.mjs`
denies if the name isn't pinned, the realpath changed (for example the path
became a symlink), the file's sha256 differs from the pin (checked before and
after import), the import throws, `verify` is missing, the call throws or
runs past `timeoutMs`, or the result is malformed.

**Where to install.** Put the plug-in and its `node_modules` in a directory
the agent can't write, owned by the user that runs `signal.mjs`. The pin
covers the entry module's bytes only. It does not cover the modules that
file imports. Those are fixed by `npm ci` from a lockfile and then by file
permissions. Bundling a plug-in into one file makes the pin cover all of it.

## Worked example: an HMAC-signed webhook

[`examples/verifier-plugins/hmac-webhook.mjs`](../examples/verifier-plugins/hmac-webhook.mjs)
accepts a webhook body (the same JSON a file drop carries) signed with
`X-Speckl-Signature: sha256=<hex HMAC>`. The receiver writes the body to
`body.json` and the header value to `body.json.sig`. The core of it:

```js
export function checkConfig(config) {
  if (!isObj(config) || typeof config.secretFile !== 'string' || !config.secretFile) return { ok: false, reason: 'secretFile is required' };
  if (typeof config.sender !== 'string' || !config.sender) return { ok: false, reason: 'sender is required' };
  return { ok: true };
}

export async function verify(opts, expect, ctx) {
  // 1. proof: HMAC over the raw bytes, constant-time compare
  const want = crypto.createHmac('sha256', secret).update(body).digest();
  if (!crypto.timingSafeEqual(want, Buffer.from(m[1], 'hex'))) return { ok: false, reason: 'bad signature' };
  // 2. bindings: signal, run, expiry, nonce, outcome
  if (p.signal !== expect.signal) return { ok: false, reason: 'wrong signal: ' + p.signal };
  if (p.run !== ctx.runId || !ctx.runId) return { ok: false, reason: 'run mismatch' };
  ...
  // 3. identity from config, not from the body
  return { ok: true, signal: { ..., subject: ctx.config.sender,
    evidence: 'hmac-webhook:' + sha256(body), run: p.run, expires: p.expires, nonce: p.nonce } };
}
```

A shared secret proves that whoever sent the body held the secret. It
doesn't prove which person approved, so the subject is the configured sender.

Pin it:

```json
{ "hmac-webhook": { "module": "/opt/speckl/plugins/hmac-webhook.mjs",
    "config": { "secretFile": "/etc/speckl/webhook.secret", "sender": "approvals.example.com" } } }
```

Its tests are in
[`compiler/src/__tests__/agent-verifier-plugins.test.ts`](../compiler/src/__tests__/agent-verifier-plugins.test.ts)
("worked example"). They drive the generated `signal.mjs` and check that a
correct body is applied with the configured subject, and that a wrong key, a
tampered body, a wrong run, an expired body, a disallowed outcome, a wrong
signal, a missing signature and an incomplete config all deny.

## Reference implementation: Sigstore

[`plugins/verifier-sigstore/`](../plugins/verifier-sigstore/) verifies
Sigstore keyless signatures. The approver signs the drop file itself, for
example with `cosign sign-blob drop.json --bundle drop.json.sigstore.json`,
using their OIDC identity. The plug-in checks the bundle with
`@sigstore/verify`: signature over the exact bytes, Fulcio certificate chain
and SCTs against the trusted root, and a Rekor entry (signed entry timestamp
or inclusion proof) against the Rekor key in the trusted root. It then
checks the certificate's issuer and identity against the policy pinned for
that signal, and applies the run/expiry/nonce/outcome bindings. Evidence is
the bundle's sha256 plus the Rekor log index and entry UUID.

Two details from building it apply to any identity-based plug-in.
`@sigstore/verify` matches the certificate SAN as an unanchored regular
expression, so a plain `carol@example.com` policy would also accept
`xcarol@example.com.evil.test`. The plug-in escapes and anchors an exact
identity and compares it again as a string. Second, it refuses a trusted
root with an authority that has no validity start, which `@sigstore/verify`
3.x would otherwise treat as unbounded.

Its tests run offline against bundles from a mock Sigstore instance and 23
real bundles from the Sigstore conformance suite. See its
[README](../plugins/verifier-sigstore/README.md) for config and for what is
and isn't verified offline.

It keeps the generated rails dependency-free: `hook.mjs` and `signal.mjs`
stay plain Node, and only operators who pin the plug-in install the Sigstore
libraries.

## Testing checklist

Test through the generated `signal.mjs` where you can, not only by calling
`verify` directly. For each item, assert the exit code (2) and that
`state.json` didn't move (stage, `signalLog`, `usedNonces`).

- [ ] A valid proof is applied; `subject` comes from the proof or config.
- [ ] Tampered payload (one byte changed after signing) denies.
- [ ] Wrong signer identity denies, including one that only contains the
      expected identity as a substring.
- [ ] Wrong issuer / key / secret denies.
- [ ] Identity supplied in the payload or on the command line is ignored or refused.
- [ ] Wrong `run`, missing `run`, expired, invalid `expires` all deny.
- [ ] Reused nonce denies; short or missing nonce denies.
- [ ] Outcome not in `expect.outcomes` denies; wrong `signal` denies.
- [ ] Missing proof file, unparsable proof, missing trust material deny.
- [ ] A library throw becomes `{ ok: false }`, not a crash with exit 0.
- [ ] `checkConfig` rejects every incomplete or ambiguous config.
- [ ] No test needs the network.

## Limits

- **A verifier covers sign-offs only.** It decides whether a human (or other
  outside party) approved a transition. It says nothing about what the agent
  did before or after.
- **The state and its log are sealed with HMAC.** The tool-call log is
  hash-chained and MAC'd with a shared key. That catches edits by anyone
  without the key, but it doesn't prove the agent's actions to a
  counterparty. A Sigstore-signed approval can be checked by anyone; the log
  of what happened next can't.
- **Pinning covers one file.** The plug-in's dependencies are trusted by
  install location and permissions, not by hash. The before/after hash check
  narrows a swap during import but can't close it on a writable directory.
- **Speckl is not a sandbox.** If the agent can run `signal.mjs`, read the
  state key or the plug-in's secrets, or write the plug-in directory, none of
  this holds. Run the hook and signal tooling as a separate OS user.
