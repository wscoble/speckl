# Effect target

`speckl <file> -t effect` compiles a speck to an [Effect](https://effect.website) 3.x module: `src/index.ts`, `package.json`, and `tsconfig.json` under `<output>/<Speck>/`. The module imports `effect` as a namespace (`$$effect`) so a spec type named `Schema`, `Effect`, or `Layer` cannot collide with the import. Generated code is typechecked with `tsc` against Effect 3.22.

Other components depend on the schemas and on the `Context.Tag`. The `Live` layer is the adapter that holds the machine in a `Ref`.

## Example

```speck
speck ToggleSwitch {
    state { isOn: Bool }
    init { isOn := false }
    action TurnOn {
        require not isOn
        isOn := true
        return isOn
    }
    next: TurnOn
}
```

```ts
export interface ToggleSwitchState {
  readonly isOn: boolean;
}
export const ToggleSwitchState: $$effect.Schema.Schema<ToggleSwitchState> = $$effect.Schema.Struct({
  isOn: $$effect.Schema.Boolean,
});

export class $$GuardFailed extends $$effect.Schema.TaggedError<$$GuardFailed>()("GuardFailed", {
  action: $$effect.Schema.String,
  detail: $$effect.Schema.String,
}) {}

export const turnOn = (machine: ToggleSwitchMachine): $$effect.Effect.Effect<ToggleSwitchDecision<boolean>, $$GuardFailed> =>
  $$effect.Effect.gen(function* () {
    let $$state = { ...machine.state };
    let $$log = machine.decisionLog;
    if (!((!$$state.isOn))) {
      return yield* new $$GuardFailed({ action: "TurnOn", detail: "not isOn" });
    }
    $$state = { ...$$state, isOn: true };
    return { state: $$state, decisionLog: $$log, value: $$state.isOn };
  });

export class ToggleSwitchCapability extends $$effect.Context.Tag("@speckl/ToggleSwitch")<ToggleSwitchCapability, {
  readonly getState: $$effect.Effect.Effect<ToggleSwitchState>
  readonly turnOn: () => $$effect.Effect.Effect<boolean, $$GuardFailed>
}>() {}

export const toggleSwitchLive: $$effect.Layer.Layer<ToggleSwitchCapability, never> = $$effect.Layer.effect(
  ToggleSwitchCapability,
  $$effect.Effect.gen(function* () {
    const initial = yield* boot;
    const ref = yield* $$effect.Ref.make<ToggleSwitchMachine>(initial);
    return {
      getState: $$effect.Effect.map($$effect.Ref.get(ref), (m) => m.state),
      turnOn: () => $$effect.Effect.gen(function* () {
        const current = yield* $$effect.Ref.get(ref);
        const decided = yield* turnOn(current);
        yield* $$effect.Ref.set(ref, { state: decided.state, decisionLog: decided.decisionLog });
        return decided.value;
      }),
    };
  }),
);
```

`boot` builds the initial machine. A `service` block becomes its own `Context.Tag` plus a layer that fails with `$$AdapterUnimplemented`, because the spec declares the capability and no adapter.

## Type mapping

| Speckl | Effect |
|---|---|
| `Bool` | `Schema.Boolean` (`boolean`) |
| `Nat` | `Schema.Number` filtered with `int()` and `nonNegative()` (`number`) |
| `Int`, `Integer`, `Long` | `Schema.Number` filtered with `int()` (`number`) |
| `Real`, `Float`, `Double`, `Number` | `Schema.Finite` (`number`) |
| `String` | `Schema.String` |
| `Bytes` | `Schema.Uint8ArrayFromSelf` |
| `Date`, `Timestamp` | `Schema.DateFromSelf` |
| `T \| null`, `Option(T)`, `nil` | `Schema.NullOr` (`T \| null`) |
| `List(T)` | `Schema.Array` (`ReadonlyArray<T>`) |
| `Set(T)` | `Schema.HashSetFromSelf` (`HashSet`) |
| `Map(K, V)` | `Schema.HashMapFromSelf` (`HashMap`) |
| record, including a nested `{ ... }` | `Schema.Struct`, recursive fields behind `Schema.suspend` |
| `interface` enum | `Schema.Literal` of the variant names |
| `"a" \| "b"` and `Follower \| Candidate \| Leader` | `Schema.Literal` |
| `type Name = <type>` | a named schema (and a type alias) |
| undeclared or unparseable type | `Schema.Unknown`, commented `SPECKL-UNRESOLVED` |
| event | tagged struct (`_tag` plus fields); the decision log is a `Schema.Union` of them |
| `require` / `precondition` / `postcondition` | `Schema.TaggedError` (`$$GuardFailed`, `$$PreconditionFailed`, `$$PostconditionFailed`) |
| invariant, constraint, `verify` | `Effect` that fails with `$$InvariantViolated` |
| action | `Effect` that returns the next machine and the action's value |
| the speck | `Context.Tag` (`<Name>Capability`) and `Layer` (`<name>Live`) over a `Ref` |
| `service` RPC | `Context.Tag` plus an unimplemented `Layer` (`$$AdapterUnimplemented`) |

`Nat` and `Int` decode as `number` (the filters do not brand), so generated arithmetic stays ordinary TypeScript. Collections are the in-memory Effect values (`HashSetFromSelf`, `HashMapFromSelf`), not JSON arrays.

A single-line `type Name = { ... }` is read from the source. The parser otherwise drops the closing brace and can turn the record into an enum; the Effect target keeps the record.

## What fails closed

Generation throws `EffectTargetError` for:

- `import` (cross-spec references are not resolved)
- `oneof` and `transition` (not lowered into the IR; emitting the other records would drop the discriminator)
- a streaming RPC (`stream` on the request or the response)
- validation rules, if the IR ever carries them
- a record field declared twice with two different parsed types

An expression or statement with no Effect form does not become a guess. The decision or rule returns `$$Untranslated` (`Schema.TaggedError`) before it changes state, and the source text is in the error. `eventually(...)` is one of these: it cannot be judged from the current state. A missing map key or list index inside an expression throws `SPECKL: ...` — there is no typed error channel in expression position.

## Explicitly not emitted

- PROV-O, CycloneDX, and SPDX stay on their own targets. `-t effect` does not write them.
- Agent rails (hooks, harness adapters) stay on `-t agent`. An `agent { }` block is emitted as an `agentConfig` value so the declaration is not dropped.
- Resource lifecycle (`conditions`, `finalizers`, `ownerReferences`, status text) is a `lifecycle` value. The status text is not parsed into a schema.
- `Set` algebra beyond `union` and difference (`\`), and quantifiers (`forall` / `exists`), are untranslated.
