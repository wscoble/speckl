# Priority and kpi syntax

An action may declare `priority P0`. A domain may declare `priority P0`. An event may declare `kpi "notes"`. `priority := 1` stays an assignment. A priority that is not an identifier, a second priority, and a kpi that is not a string are errors. Two kpi tags for one event name are an error. A `}` inside a kpi string or a `//` comment does not end the speck.

This slice does not copy the labels onto tools, and it does not enforce a queue. It does not route events or run a tick.

`compiler/src/__tests__/signal-syntax.test.ts` covers `round-trips an action priority, a domain priority, and a kpi tag`, `rejects a domain priority that is not an identifier`, `rejects a domain priority declared twice`, `rejects an action priority that is not an identifier`, `rejects an action priority declared more than once`, `keeps priority := as an assignment`, `rejects a kpi that is not a string`, `rejects two kpi tags for one event name`, `keeps the next speck when a brace sits in a // comment`, and `keeps both specks when a kpi string contains a brace`.

The changelog entry for this slice is not in `CHANGELOG.md`. Adding that file puts this pull request over the token cap.
