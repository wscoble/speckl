# PodcastPublishing — call-bound metadata approval

This is a workflow and generated-rails example, **not a working publisher**.
Fetch, upload, drafting and platform updates must be implemented and integrated
by the caller. The state machine records stages, not actual metadata values or
platform outcomes.

## Workflow and approval

`fetch_assets`, `start_uploads`, and `draft_metadata` lead to
`AwaitingApproval`. While waiting, `mode in` blocks even observe tools. A host
reviews the exact intended `apply_metadata` tool and arguments, including title
and description, and signs the call digest. The earlier `draft_metadata`
arguments are not stored or bound: they are not proof of what was reviewed.
Approval goes to `Approved`; rejection or the seven-day timeout goes to `Idle`.
A successful apply spends the binding and advances to `MetadataLive`.

To correct metadata, call `request_fix` (which changes no platform metadata),
then get a **fresh** host approval bound to the exact `fix_metadata` call. A
fix cannot run directly from `MetadataLive` or before metadata is live. A
successful fix spends its approval. A failed post keeps the approval for retry;
this is not an idempotency guarantee. Neither the spec nor hooks ensure external
side effects are atomic, retried safely, or deduplicated.

## Security and integration boundaries

The generated pre-hook refuses a mismatched tool or argument object, and the
post-hook advances state only after the integrator reports success. The host
must review the canonical call, not merely a digest; use `signal.mjs digest`
or the waiting pre-hook's canonical call hint. The deployment must authenticate
and authorize the actual host, use a trusted verifier (the tests use Ed25519
file-drop signatures), protect signing keys and state, and enforce pre/post
hooks around **every** platform-changing path. A `host` string claim alone
is not identity verification. Never use the development CLI verifier in
production. Calls bypassing the rails, direct platform access, dishonest or
incorrect success reports, and platform-side changes are outside this model.

Title limits, saved contact links, transcript fidelity and typos require human
review and/or independent validation; the spec does not enforce them. It does
not prove video and audio metadata match, or even that either platform was
updated. In particular two separate external updates can partially fail. The
integrator must handle this without claiming atomicity or safe retry.

## What Z3 checks

At bounded depth 8, `ApplyFromApproved` checks the model's ghost flag when
stage 5 is reached; `LiveNeedsFlow` checks that live state implies the model's
draft and upload flags. These checks do not model signed signals, argument
binding, actual content, human review or external systems. The runtime tests
exercise the binding separately.

## Try it

```bash
cd compiler
npm ci && npm run build
node dist/index.js ../examples/PodcastPublishing.speckdl -t all -o out
node scripts/verify-z3.mjs ../examples/PodcastPublishing.speckdl
npm test -- example-podcast-publishing
```
