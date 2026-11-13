# Domain contract check

This slice copies `cost` onto the action. It does not route events, queue work, or schedule a tick.

The parser records `cost` as a statement. This check copies that number onto the action, including `cost 0`. The parent syntax slice left `cost` unset while lowering. This slice stores it. A speck with no `cost` and no domain still lowers, and that action has no `cost` field. A domain with no contract clauses still lowers. Storing `cost` does not drop the action's other statements.

The parser rejects an empty `consumes` or `produces` as `has no event`. A name that is not an identifier is `not an event name`, for a consume and for a produce. The same name twice, on one clause or on a second clause, is `more than once`. A budget or a cost with no integer, and a budget or a cost above the safe integer range, are rejected by the parser before this check runs. `cost := 1` stays an assignment.

This check rejects a consumed event that nobody produces and that is not external, a produce of a name that is not an event, a produce of an external event (`declared external`, which is a different rejection), and an emit the domain does not produce. `compiler/src/__tests__/domain-contracts.test.ts` covers those rejections. `compiler/src/__tests__/domain-contract-syntax-each.test.ts` covers `a speck with no contract still lowers and does not invent a cost`, `a domain with no contract clauses still lowers`, and `stores the parsed cost on the action`.

The parent syntax slice left `cost` unset. `a speck with no contract still lowers and does not invent a cost` and `a domain with no contract clauses still lowers` still match that parent. `stores the parsed cost on the action` is the change in this slice.
