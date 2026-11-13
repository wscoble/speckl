# Domain contract syntax

This slice parses contract clauses. It does not check that a consumed event is produced. It does not route events, queue work, or schedule a tick.

A domain may add `consumes PaymentReceived;`, `produces InvoiceIssued;`, and `budget 0 per tick;`. An empty `consumes` or `produces` is `has no event`. A name that is not an identifier is `not an event name`. The same name twice on one clause is `more than once`. `budget` must be a non-negative integer followed by `per tick`. Zero is a real budget. An action may declare `cost 0`. Zero is a real cost. A negative cost, a cost that is not an integer, and a second `cost` are errors. `cost := 1` stays an assignment. While lowering, `cost` is skipped, so the action has no `cost` field.

`compiler/src/__tests__/domain-contract-syntax-each.test.ts` covers each case, including `rejects consumes with no event`, `rejects an event name that is not an identifier`, `rejects a budget that is not an integer`, `keeps cost := as an assignment`, and `skips cost while lowering and does not store it on the action`.

The changelog entry for this slice is not in `CHANGELOG.md`. Adding that file to this pull request puts the diff over the token cap. The sentences above are the record of this change.
