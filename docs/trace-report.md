# Trace report

`speckl trace report` reads a decision log offline. It checks the hash chain of the bytes it read. The HMAC is checked only when a key is passed and the log has a line. With `--state`, `head.json` is required when `<state>.decisions/` exists. A shortened or deleted log fails when that head is still there. `--log` does not know the head. An empty log prints `macs not checked`. That HMAC is a shared-key seal. It proves nothing to an outside auditor.

The report does not run the hook and it does not enforce a queue. Display order is not a queue rank.

`compiler/src/__tests__/trace-report.test.ts` covers `matches the golden report, including an empty log`, `checks the hash chain and leaves the HMAC for a key`, `prints usage and refuses a missing or ambiguous path`, `fails closed when --state log is shorter than the decision head or gone`, and `fails when a log or decisions dir has no head, and does not claim macs on an empty record`.
