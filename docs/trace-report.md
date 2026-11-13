# Trace report

`speckl trace report` reads a decision log offline. When the log parses, it checks the hash chain of those lines. A torn file, a blank line, or a line that is not JSON is refused before that check. A key that is not 64 hex characters is refused. With `--state`, `head.json` is required when `<state>.decisions/` exists. `--log` does not know the head. An empty log prints `macs not checked`.

The report does not run the hook and it does not enforce a queue. Display order is not a queue rank.

`compiler/src/__tests__/trace-report.test.ts` covers `matches the golden report, including an empty log`, `refuses a torn file, a blank line, and a non-JSON line before the hash check`, `checks the hash chain and leaves the HMAC for a key`, `rejects a key that is not 64 hex characters`, `prints usage and refuses a missing or ambiguous path`, `fails closed when --state log is shorter than the decision head or gone`, and `fails when a log or decisions dir has no head, and does not claim macs on an empty record`.
