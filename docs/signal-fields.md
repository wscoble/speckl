# Tool signal fields

The agent generator copies an action `priority` onto the tool, or the domain `priority` when the action declares none and the domain's members include the speck. `kpis` are the `kpi` tags of events that action emits with a straight-line `emit`, in source order, once each, stopping at `return`. An `emit` inside an `if` or a `for`, or an `emit` in a comment, is not tagged. Both fields are omitted when absent.

This does not write the decision line. The hook does that, in a later change. This slice does not route events, queue work, or run a tick, and it does not enforce a queue.

`compiler/src/__tests__/agent-signal-fields.test.ts` covers `copies an action priority and a straight-line kpi onto the tool`, `uses the domain priority when the action declares none`, `does not tag an emit inside an if or a comment`, and `omits priority and kpis when the speck declares neither`.
