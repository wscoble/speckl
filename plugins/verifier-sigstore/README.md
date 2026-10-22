# @speckl/verifier-sigstore

A Speckl signal verifier plug-in for [Sigstore](https://www.sigstore.dev/)
keyless signatures. An approver signs the signal drop with their OIDC
identity (no long-lived key), and `signal.mjs` applies it only if the bundle
verifies and the signer matches the identity pinned for that signal.

This is a plug-in, not part of the generated rails: `hook.mjs` and
`signal.mjs` stay plain Node with no dependencies, and only operators who
pin this module install the Sigstore libraries. See
[docs/verifier-plugins.md](../../docs/verifier-plugins.md) for the plug-in
interface and how pinning works.

Status: in this repository only. Not published to npm.

## Install

Install it somewhere the agent can't write, as the user that runs
`signal.mjs`:

```
sudo install -d -o speckl -m 0755 /opt/speckl/verifier-sigstore
cp index.mjs package.json package-lock.json /opt/speckl/verifier-sigstore/
cd /opt/speckl/verifier-sigstore && npm ci --omit=dev
```

`npm ci` checks every dependency against the lockfile's integrity hashes.
After that, the dependencies are trusted by file permissions. `signal.mjs`
pins only `index.mjs`.

## Configure and pin

`plugins.json`:

```json
{
  "sigstore": {
    "module": "/opt/speckl/verifier-sigstore/index.mjs",
    "config": {
      "tuf": { "cachePath": "/var/lib/speckl/sigstore-tuf" },
      "signals": {
        "review": {
          "issuer": "https://github.com/login/oauth",
          "identity": "carol@example.com"
        },
        "clear-pending": {
          "issuer": "https://token.actions.githubusercontent.com",
          "identityRegExp": "^https://github\\.com/acme/ops/\\.github/workflows/clear\\.yml@refs/heads/main$"
        }
      }
    }
  }
}
```

```
node signal.mjs init --state ./state.json --key /etc/speckl/state.key --plugins ./plugins.json
```

| Key | Meaning |
| --- | --- |
| `tuf` | Use the Sigstore public-good trusted root, fetched and verified over TUF into `cachePath` (needs network; `mirrorURL`, `rootPath`, `forceCache` are passed to `@sigstore/tuf`). |
| `trustedRoot` + `trustedRootSha256` | Use a `trusted_root.json` file instead (offline, or a private Sigstore deployment). The sha256 is required, so the file can't be swapped after init. |
| `tlogThreshold` | Rekor entries required, default 1, minimum 1. |
| `ctlogThreshold` | SCTs required, default 1. |
| `signals.<name>.issuer` | Required OIDC issuer (Fulcio certificate extension). Exact match. |
| `signals.<name>.identity` | Required certificate identity (SAN: email, or workflow URI). Exact match. |
| `signals.<name>.identityRegExp` | Instead of `identity`, a regular expression that must start with `^` and end with `$`. |

The identity policy comes only from this pinned config. The drop's own
`subject` field is ignored, and `--identity`, `--issuer` and similar flags
are refused.

## Sign and apply

The drop is the same JSON the `file-drop` verifier reads:

```json
{ "signal": "review", "outcome": "approve", "claims": { "reviewer": "carol" },
  "run": "<run id from signal.mjs init>", "expires": "2026-10-22T17:00:00Z",
  "nonce": "4f1c9a7e-2b7d-4c55-9e0e-0d6c1f6c7b21" }
```

```
cosign sign-blob drop.json --bundle drop.json.sigstore.json     # cosign v3; v2 needs --new-bundle-format
node signal.mjs apply --state ./state.json --verifier plugin:sigstore --file drop.json
```

`--bundle <path>` overrides the default `<file>.sigstore.json`.

## What is checked

All cryptography is done by `@sigstore/verify`:

1. The bundle is a message signature (DSSE bundles are refused) over the
   exact bytes of the drop file.
2. The signing certificate chains to a Fulcio CA in the trusted root, valid
   at the time the log or timestamp authority recorded it, with the
   required SCTs from a CT log in the trusted root.
3. At least one Rekor entry verifies against a Rekor key in the trusted
   root (a signed entry timestamp, or an inclusion proof against a signed
   checkpoint) and matches this signature and certificate.
4. The certificate's issuer and SAN match the pinned policy for the awaited
   signal. `@sigstore/verify` matches the SAN as an unanchored regular
   expression, so the plug-in escapes and anchors an exact `identity`, then
   compares it again as a plain string.
5. The trusted root is refused if any authority lacks a `validFor.start`.
6. Then the same bindings as `file-drop`: `signal`, `run`, `expires`, a
   single-use `nonce` and an allowed `outcome`.

Evidence is `sigstore:<sha256 of the bundle file>:rekor:<log index>:<entry
uuid>`. The entry UUID is the RFC 6962 leaf hash of the entry body, without
a tree-ID prefix. The signal log also records the verified `subject`,
`issuer` and the Rekor log index, log id, entry UUID and integrated time.

Any failure, including a library throw, returns `{ ok: false }`, and
`signal.mjs` denies.

## Tests: what is verified offline and what isn't

`npm test` (needs `npm ci` here and in `compiler/`) runs without network:

- **Generated bundles:** a throwaway Fulcio CA, CT log and Rekor log from
  `@sigstore/mock`, served in-process with `nock`, sign drops through the
  real `@sigstore/sign` client. The tests cover a valid approval, a tampered
  payload, wrong identity (including a superstring of the right one), wrong
  issuer, an untrusted CA, a missing or untrusted Rekor entry, an altered
  entry, a missing CT log, a missing/changed/malformed trusted root, a
  library throw, expiry, a reused nonce, a wrong run, a disallowed outcome
  and a wrong signal. `e2e.test.mjs` runs the same through a compiled
  `signal.mjs`.
- **Real bundles:** 23 cases from the Sigstore conformance suite
  (`test/fixtures/`), 7 that must verify and 16 that must not. They include
  public-good Rekor v1 bundles and Rekor v2 bundles (checkpoint + RFC 3161
  timestamp). Public-good cases verify against a snapshot of the public-good
  trusted root taken on 2026-10-21.

Not covered by the tests:

- **TUF.** Fetching the public-good root over TUF needs the network. The
  tests only check that a failed fetch denies. It was run by hand on
  2026-10-21: with `tuf` configured, all conformance cases gave the expected
  result against the freshly fetched root.
- **cosign and live OIDC.** No test signs with `cosign` or a live OIDC
  identity. The bundles come from `@sigstore/sign` with the mock services,
  or from the conformance suite.
- **Node 20.** The plug-in pins `@sigstore/verify` 3.x, the last line that
  supports Node 20. `@sigstore/verify` 4.x needs Node 22.
