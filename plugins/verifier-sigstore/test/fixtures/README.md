# Test fixtures

## `sigstore-conformance/`

Copied unchanged from the Sigstore conformance suite,
<https://github.com/sigstore/sigstore-conformance>, `test/assets/bundle-verify/`
at commit `43321d80f52958efa584c6c975716150db62180b` (2026-10-19). Licensed
under the Apache License 2.0 by the Sigstore authors. Each directory holds a
real bundle and a README explaining it; names ending in `_fail` must not
verify. Only message-signature (`cosign sign-blob`-style) cases are copied,
because the plug-in refuses DSSE bundles. The artifact is `a.txt` unless a
directory has its own `artifact`; identity and issuer default to the
conformance beacon workflow unless a directory has `identity` / `issuer`.

## `public-good-trusted_root.json`

The Sigstore public-good trusted root, fetched over TUF with
`@sigstore/tuf` `getTrustedRoot()` on 2026-10-21 (sha256 `39dbe448b3cea57cbd445c9cdd1454a3bf24ca0ed3eaf5d9d8348b6abb4363b2`). Used for
the conformance cases that have no `trusted_root.json` of their own, so
those tests run offline. It is a snapshot: it isn't refreshed by the tests,
and it isn't what the plug-in uses in production (configure `tuf` or your
own `trustedRoot`).
