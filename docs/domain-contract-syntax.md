# Domain contract check

This slice copies `cost` onto the action. It does not route events, queue work, or schedule a tick.

The parser records `cost` as a statement. This check copies that number onto the action, including `cost 0`. A speck with no `cost` and no domain still lowers, and that action has no `cost` field. A domain with no contract clauses still lowers. Storing `cost` does not drop the action's other statements.

This check rejects a consumed event that nobody produces and that is not external, a produce of something that is not an event, and an emit the domain does not produce. `compiler/src/__tests__/domain-contracts.test.ts` covers those rejections. `compiler/src/__tests__/domain-contract-syntax-each.test.ts` covers `a speck with no contract still lowers and does not invent a cost`, `a domain with no contract clauses still lowers`, and `stores the parsed cost on the action`.

The parent syntax slice left `cost` unset. That change is this slice, and the two tests above are the cases that still match the parent.
