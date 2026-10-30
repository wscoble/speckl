# SpeckDL Claims Layer Dossier

> How the claims layer was designed, what it is, what to build, and why.
> Written by Scott + pi (session, 2026-10-30). This is the canonical context
> document for v0.4 work. Companion work order: `docs/v0.4-work-order.md`.

The worked examples in this document use **ExampleCo**, a fictional company
made up for teaching. The record ids, the probe rows, and the product names
`mirror-host`, `PebbleKV`, `Quill`, and `Keepsake` are fictional. They are
not a customer and not a production incident.

## 1. How we got here

The thread that produced this design ran through four external anchors:

1. **Jonathan Gorard on Theories of Everything**
   (<https://youtu.be/oQypVVv1u1o>) — applied mathematician, co-founder of the
   Wolfram Physics Project, and co-founder and CEO of Lanyon AI
   (<https://lanyon.ai/company/>, the company's own team page). Core claim: the
   recent AI capability explosion happened in code and math because those
   domains have formal verification substrates (compilers, type checkers, proof
   assistants). Capabilities train via reinforcement learning with verifiable
   rewards; you only get verifiable rewards where a machine-checkable
   description language exists. Physics lacks one, so physics is bottlenecked.
   Gorard's company builds "a language that mechanizes the process of scientific
   reasoning" — a reasoning DSL the LLM thinks *in*, with a checker as the
   verification pipeline. He frames it as "type systems for physics" and cites
   Hilbert's mechanization program and Turing's student Robin Gandy's attempt
   to extend type theory to physics. The lesson taken: **the reasoning language
   is the leverage point**; build the language, and checker quality mechanically
   raises the reasoning ceiling of anything that thinks in it.

2. **Catala** (<https://catala-lang.org>, Inria, Denis Merigoux) — the
   executable-specification DSL for legislation. On 8 June 2026 the French
   CNAF and Inria announced a partnership to develop Catala. The CNAF press
   release says Catala was retained as a structuring technology for the CNAF's
   future calculation-engine work, and that the CAF information systems pay
   out about 110 billion euros of social benefits a year to more than 13.6
   million households. That euro figure is the volume those systems pay. It is
   the CNAF's description of its own payments, and the announcement is a
   partnership to develop Catala for future work.
   Primary source: the CNAF press release of 8 June 2026,
   <https://caf.fr/professionnels/presse/publications/la-cnaf-et-inria-s-engagent-ensemble-pour-developper-catala-une-solution-souveraine-de-calcul-des>.
   Design lessons imported wholesale:
   - *Literate anchoring*: the legislative text IS the program carrier; code
     annotates prose; lawyer and programmer pair on one artifact. Drift between
     spec and source is physically impossible.
   - *Default logic*: explicit exception trees instead of ordering-dependent
     overrides. Refinement without re-commitment; late errors stay local.
   - *Release discipline*: versions named after landmark court cases —
     jurisprudence is legislation's incident ledger, and each case is a
     regression test the statutes must keep passing.
   Catala computes (legislation is a pure function of a factual record). Our
   domain is behavior over time — closer to TLA+ — so we take Catala's vessel
   and fill it with temporal semantics.

3. **Philip Mannheim on Theories of Everything**
   (<https://youtu.be/HJcQLHqOziM>) — conformal gravity lecture. Structural
   lesson imported (independent of whether the physics is right — it is used as
   grammar, not as endorsement): **scale-dependent coupling between global and
   local.** Newton's second-order Poisson equation is local (solid-angle
   cancellation at 1/r^2); fourth-order theories acquire a linear potential that
   grows with distance, so distant matter dominates galactic dynamics — "the
   global influences the local when the sizes are appropriate." His rotation
   curve formula has terms each waking at its own scale (Schwarzschild local,
   linear global, cluster-scale kappa). The maxim imported for systems work:
   *"dark matter is an attempt to describe global physics in local terms."*
   Swap domains: most postmortems describe global-term failures in local
   terms. Also Milgrom's a0: a **transition exists** (structural law);
   **where it sits is measured** (data, not grammar).

4. **Syllogisms, Toulmin, and defeasible logic** — classical syllogisms are
   the cheapest sound inference (a cheap "middle rung" between typecheck and
   solver: entailment over the claim graph, including automatic provenance
   edge derivation). Classical logic is monotone and our `except` is
   nonmonotonic, so the boundary semantics come from defeasible logic /
   argumentation. Toulmin's argument model (claim, data, warrant, backing,
   qualifier, rebuttal) maps almost one-to-one onto our primitive set — 1958
   prior art for the shape. Warrant (the named rule connecting evidence to
   claim) is the one Toulmin primitive our language still lacks; adding it is
   on the roadmap.

## 2. What the claims layer is

One language, many surfaces, one IR. The v0.3 block syntax stays (humans, CI,
state machines). The claims surface (condensed, breadth-first, claim-refine
form) is a second front-end that lowers to that same IR. Surfaces plural, IR
singular.

The compiler on main does not accept these members yet. The block form below
is the grammar Task 1 implements, after the parser rewrite named in the work
order. The claims surface is Task 7.

### 2.1 Canonical primitive set

Both this dossier and `docs/v0.4-work-order.md` use this list and no other.
Eleven primitives:

| Primitive | Where it appears | Role |
|---|---|---|
| `claim` | block member | Typed proposition. The unit of reasoning. |
| `evidence` | member of `claim` | `&` pointer at a record. |
| `provenance` | member of `claim` | Attribution chain. Must terminate at a `root`. |
| `ensured` | member of `claim` | Positive boundary. Lowers like a v0.3 `invariant`. |
| `except` | member of `claim` | Negation boundary. Default logic. |
| `root` | block member | Axiom. Zero evidence. Declares `trust`. |
| `coupling` | member of `claim` | Scale term: `coupling <Term> at <Layer>`. |
| `layer` | block member | A scale. Its `horizon` is a record reference. |
| `verdict-cap` | member of `claim` | Ceiling on that claim's verdict. |
| `commit` | block member | Composition of claims, joined by `and`. |
| `covers` | member of `claim` | Design-time citation of an incident id. |

Names that are not in this set:

- **`verify`** is the v0.3 verification block (`verify Always(...) { depth N }`
  and `verify: <temporal expr>`). It stays that member. It is not a claims
  primitive, and an earlier task list that included it did not define a new
  one.
- **`compose`** has no definition. Composition is the `commit` member.
- **`horizon`** is a field of `layer`, not its own primitive. Horizon
  constants come from `&` record references, not from literals, wherever the
  deployment provides them.
- **`incident`** is a runtime ledger record (section 5). It is never written
  into a spec file. ("Leak" was the working name. It was rejected in syntax
  because it collides with memory leaks. The word stays in prose as the
  rationale for the open-world rule.)

`provenance` is also an existing top-level speck member (`provenance { }`
with PROV-O clauses, SPEC §5). That production is unchanged. Inside
`claim { }`, `provenance &id` is the claims attribution edge. The two
productions share a keyword and are distinguished by position: a top-level
`provenance` block versus a line inside a claim.

### 2.2 Canonical block form

The block form is the canonical grammar. It matches SpeckDL on main: a speck
is `speck Name { <members> }`, and a member that has a body is
`keyword Name { <lines> }` (`state`, `action`, `invariant`, `agent`,
`provenance`, and the rest). Claims members live in that same brace grammar.

`verdict-cap` is a line inside the claim, next to `evidence` and `covers`.
It is not a suffix on `coupling`. A claim can carry several coupling terms
and still has one ceiling, so the ceiling is one field of the claim. A
coupling line is only `coupling <Term> at <Layer>`.

```speck
speck ExampleCoBackup {
  root ExampleCoAgreement2026 {
    authority "exampleco-ops"
    basis "fictional service agreement, signed 2026-08"
    trust CorpusConsistent
  }

  claim BackupWithinRTO(client ExampleCo, window 24h): obligation {
    evidence &backup/exampleco/2026-09-19
    provenance &agreement/exampleco-2026
    ensured &invariant/restore-test-passes
    except &outage/exampleco/2026-09-12 -> RTOx2
    coupling wan at global
    coupling local at sync-host
    covers &incident/exampleco-mirror-404
    verdict-cap Corrected
  }

  layer global {
    horizon &record/horizon-global
  }

  layer sync-host {
    horizon &record/horizon-sync-host
  }

  commit ExampleCo3Dot2 {
    claims: BackupWithinRTO and RestoreTestPasses
  }
}
```

`claim` types, by verification semantics:

- `fact` — checked against records
- `obligation` — checked against a contract
- `capability` — checked by bounded model checking

Reference sigils:

- `&id` — external record reference. It must exist. Resolution is a check
  against the resolver registry. `&` never defines a record. It only refers.
  The sigil is not part of the record id. The registry key is `id`.
- a bare name in a `claims:` list — internal claim reference.
- `and` — conjunction of claim references.

`except <condition> -> <consequence>` is the default-logic boundary.
`<condition>` is an `&` record reference or a boolean expression in the
existing expression language. `<consequence>` is the refinement that applies
when the condition holds (`RTOx2` in the example).

`root` members are `authority`, `basis`, and `trust`. `trust` is required.
See §2.4.

`commit` is the composition member. `claims:` lists internal claim references
joined by `and`. In the block form those references are bare names, the same
way `next: TurnOn | TurnOff` names actions.

### 2.3 Claims surface

The claims surface is the condensed front-end: unbraced, indentation-scoped,
breadth-first. It is a parser, not a second language. A claims-surface file
and a block-form file of the same speck lower to identical IR (the same
nodes, names, reference kinds, caps, and trust values). Source layout is
allowed to differ. The IR is not.

Internal references on this surface are written `*Name*`. That token and the
bare name in a block-form `claims:` list lower to the same internal reference.
`&` stays reserved for external records on both surfaces.

```
root ExampleCoAgreement2026
  authority "exampleco-ops"
  basis "fictional service agreement, signed 2026-08"
  trust CorpusConsistent

claim BackupWithinRTO(client ExampleCo, window 24h): obligation
  evidence &backup/exampleco/2026-09-19
  provenance &agreement/exampleco-2026
  ensured &invariant/restore-test-passes
  except &outage/exampleco/2026-09-12 -> RTOx2
  coupling wan at global
  coupling local at sync-host
  covers &incident/exampleco-mirror-404
  verdict-cap Corrected

layer global
  horizon &record/horizon-global

commit ExampleCo3Dot2
  claims *BackupWithinRTO* and *RestoreTestPasses*
```

The IR both surfaces lower to:

```
root ExampleCoAgreement2026 {
  authority: "exampleco-ops"
  basis: "fictional service agreement, signed 2026-08"
  trust: CorpusConsistent
}
claim BackupWithinRTO {
  kind: obligation
  args: [client ExampleCo, window 24h]
  evidence: [&backup/exampleco/2026-09-19]
  provenance: [&agreement/exampleco-2026]
  ensured: [&invariant/restore-test-passes]
  except: [{ condition: &outage/exampleco/2026-09-12, consequence: RTOx2 }]
  coupling: [{ term: wan, layer: global }, { term: local, layer: sync-host }]
  covers: [&incident/exampleco-mirror-404]
  verdictCap: Corrected
}
layer global { horizon: &record/horizon-global }
commit ExampleCo3Dot2 {
  claims: [BackupWithinRTO, RestoreTestPasses]   // internal refs
}
```

Task 1 is free to name the TypeScript fields, as long as each line in this
sketch is a distinct facet and the two surfaces produce equal values.

### 2.4 Verdict lattice

Four verdicts. The order is **total**:

```
Unverifiable < CorpusConsistent < Corrected < Verified
```

`Corrected` sits strictly above `CorpusConsistent` and strictly below
`Verified`. It is a rank on that chain, not a side branch.

What the ranks mean:

- `Unverifiable` — no check has been discharged.
- `CorpusConsistent` — the claim agrees with the records that were resolved.
  A snapshot is not the wire, so corpus consistency is not verification.
- `Corrected` — detect-and-repair, ECC-style. The claim has an operational
  response to a violation (detection, attribution, a repair or a narrowed
  boundary). That is stronger than agreement with a corpus and weaker than
  a discharged proof.
- `Verified` — the check the claim's type asks for has been discharged
  (records for a fact, the contract for an obligation, BMC for a capability),
  inside the declared coupling range.

Because the order is total, `min` is the ordinary minimum: the least element
under `<`. `min(Verified, Corrected)` is `Corrected`. `min` of one verdict is
that verdict. There is no meet to define and no incomparable pair.

A partial order was the other reading of an earlier note that wrote
"Verified (local) / Corrected (global)" as if the two were alternatives at
the same height. That reading is not the order. Under it, `Verified` and
`Corrected` would be incomparable, both above `CorpusConsistent`, and `min`
would mean the meet: `min(Verified, Corrected) = CorpusConsistent`. A root
whose `trust` was one ceiling could not stand in `≤` with a premise at the
other ceiling. The total chain keeps the inequality the propagation rule
already writes, and it keeps a `Corrected` claim stronger than a merely
corpus-consistent one when it is composed with a `Verified` premise.

**Global ceiling.** The layer name `global` is reserved for this rule. A
coupling term `at global` is a global-coupling term. A claim with one or
more global-coupling terms has a forced ceiling of `Corrected`: it is never
`Verified`. Its declared `verdict-cap` must be `≤ Corrected`. Omitting
`verdict-cap` means the effective cap is that forced ceiling (`Corrected`
when any term is `at global`, otherwise `Verified`). An explicit
`verdict-cap` may tighten the effective cap and may not raise it. Setting
`verdict-cap Verified` on a claim that couples `at global` is a lattice
error. This is what "permanently Corrected-class" means: `Corrected` is the
maximum, not a separate class beside the order.

**`trust(root)`.** A root has no evidence, so it does not derive a verdict.
It declares one, with a required member:

```
trust <Verdict>
```

`<Verdict>` is one of the four names above. Omitting `trust` is a compile
error in the lattice pass (fail closed). There is no implicit default.

**Propagation.** For a derived claim:

```
derived ≤ min(verdicts of claim premises) ≤ trust(root)
```

when the claim has one or more claim premises, and

```
derived ≤ trust(root)
```

when its only support is the root. Claim premises are the claims named by
`provenance` edges that land on claims, and the claims named by a `commit`.
The root at the end of a provenance chain contributes `trust(root)` on the
right-hand side. It is not also inserted into the `min`. Evidence records
are not verdicts and are not premises of this inequality. Entailment never
upgrades a verdict: the derived verdict cannot outrank the weakest premise,
and that weakest premise cannot outrank the root's declared trust.

Three rules that are theorems, not policies:

1. **Entailment never upgrades a verdict.** The inequality above. No
   laundering a weak claim into a strong one by composition.
2. **Certainty caps at the horizon.** A claim upgrades from
   `CorpusConsistent` toward `Verified` only inside its declared coupling
   range. A global-coupling term stops that upgrade at `Corrected`.
3. **Claims cannot invent instrumentation.** A claim whose `evidence`
   pointer resolves to no registered measurement class is a compile error.
   The claims file is the requirements document for observability.

Verdicts are time-indexed in the ledger: `Verified as of T, incident
history: N observed in D days`. Verification is survival under observed
testing, not metaphysics.

### 2.5 Other semantics kept from the design

- **coupling / layer / horizon** — scale-free grammar for which coupling
  terms a claim carries and at which layers they wake. Constants (RTTs,
  thresholds, a0s) are categorical data behind `&` pointers, never syntax.
  The horizon predicate (can two constituents complete a round trip within
  the claim's window?) defines the boundary between one-system / synchronous
  and negotiation / eventual.
- **root** — the only node allowed to have zero evidence. Roots are
  versioned. A version bump is forced by an incident, not taken for
  convenience. The support graph is acyclic and finite. Circular support is
  a compile error.
- **covers `&incident/id`** — this revision claims to address that incident.
  The generated replay tests check the edge. `speckl-incidents --check`
  fails when a manifest incident has no `covers` edge. It does not inspect
  coupling terms.

## 3. The discipline (the actual moat)

The grammar is cheap (we produced a credible primitive set in one session).
The discipline is the defensible part:

1. **Horizon metrology** — measure and version deployment constants; re-measure
   like instruments get calibrated.
2. **Term attribution** — every incident decomposed into coupling terms before
   any local cause is named. Postmortems fill a term field, not a blame field.
   ("Which term was awake?" precedes "what did we break?")
3. **Verdict lifecycle** — who may issue Verified, when upgrades happen, all
   attributed. Extends v0.3's `review: manual|auto|hybrid`.
4. **Closure honesty** — roots declare their regime through `trust`; default
   open-world; narrowing `ensured` so incidents are expected, then revising
   on them.
5. **Refuse local explanations for global failures** — the Mannheim maxim as
   an operating rule.
6. **Incident-as-test** (runtime-to-design pipeline) — see Section 5.

Historical support for "languages that spawn discipline survive": Catala's
seven years were mostly methodology, not syntax; Lean's asset is mathlib
culture, not its grammar; Lamport insists the TLA+ tool is 20 percent, the
spec-review discipline is 80.

## 4. SRE application (first production surface)

| SRE canon | claims-layer form |
|---|---|
| SLI | evidence pointer with measurement discipline |
| SLO | ensured over a window |
| Error budget | incident ledger budget; exhaustion forces root revision |
| Alerting | contradiction detectors on ensured; term-aware |
| Incident | typed incident record with term attribution |
| Blameless postmortem | term attribution before local cause |
| Runbook | remediation per coupling term |
| Deploy / rollback | root versioning; canary = revision trial |
| Capacity planning | dominant-term analysis |

Readers of a claims file get a checkable receipt that named commitments
held, with verdict history, beyond an SLA paragraph in a contract.

The two sketches below are fictional teaching examples. They use ExampleCo
so the shape can be shown in a public repository.

**Fact claim, corpus against wire.** `NoAckedProbes(2026-09-07)` is a `fact`.
Twelve fictional probe rows each say `no-ack`. The verdict is
`CorpusConsistent`, and it is not `Verified`: the stored snapshot is not the
wire. The refinement is an evidence-boundary change. It is also the first
failure-taxonomy entry for a missing `routing` primitive.

**Four terms, one fictional sync.** The same sync story is told as four
records so the terms stay distinct:

| Record | Term | What the fiction is for |
|---|---|---|
| `incident/exampleco-mirror-404` | upstream | `mirror-host` answered 404 for the object the sync requested. This is the record the `covers` edge cites. |
| `incident/exampleco-pebblekv` | vendor-api | The fictional `PebbleKV` API returned an error. The term is the vendor API, not the caller. |
| `incident/exampleco-quill` | configuration | The fictional `Quill` ledger was never configured, and no root declares that configuration. A missing root is a configuration term. |
| `lifecycle/exampleco-keepsake-tombstone` | lifecycle, not an incident | A fictional `Keepsake` tombstone is ordinary record lifecycle. It is not an `ensured` violation, it does not enter the incident ledger, and it does not need a `covers` edge. |

## 5. Incident to regression test (the pipeline)

```
RUNTIME   monitor observes violation, records incident:
          { awake term, attributions, violated commit, evidence pointers }
LEDGER    append-only, resolver-exposed
GENERATOR compiles incident -> replay fixture:
          mock the awake term at the boundary; run the revised speck's
          generated monitor; assert semantic outcome (correct detection,
          correct attribution, correct verdict downgrade)
DESIGN    root revision lands as diff (new except / narrowed ensured /
          new coupling term) + `covers &incident/id` citation edge
CI        replay test runs forever; uncovered incidents fail the build
```

The fixture comes from data (what the monitor recorded), assertions are
semantic (verdict semantics, not merely "recovered"), and `covers` makes
forgetting an incident a failed check. Precedents: TLA+ TLC counterexample
traces, Hypothesis example database, fuzzing crash corpora, Catala's
case-named releases. Near-miss versus incident: both replay as tests;
near-misses test guards and spend budget softly; incidents hit the covers
gate. The replay is against the mocked term boundary by design. It shows
the revision handles the recorded shape. It does not show that the world
will not fail differently next time (the open-world rule survives).

`speckl-incidents --check` implements only the covers gate: every incident
id in the manifest has a `covers` edge in some spec revision. Deleting a
coupling term does not, by itself, make `--check` fail.

## 6. Generate the world it describes

v0.3 already generates implementations from state machines (TypeScript, Rust).
Claims layer extends generation: every claim compiles to its monitors, probes,
dashboards, resolvers, and receipts. Compiler rule: **no component ships
without its monitor** (the DAO-hack lesson: generate the critic too).
Epistemics relocate but never close: generated code faithfully satisfies the
model; the remaining place reality can disagree is the claim itself
(CompCert lesson — trust shifts to spec adequacy). Consequence: the claim
author holds the accountability the operator used to hold; spec authorship is
the accountable role.

## 7. LLM reasoning-language experiment (planned, not yet run)

Four arms over the same ten behavior questions:
A. prose control; B. v0.3 block syntax; C. condensed DFS; D. claims surface
(claim-refine, breadth-first, `&`/`*` pointers, verdict-aware).
Failure taxonomy per attempt: parse / commit-order stall / missing primitive /
wrong claim. Metrics: accuracy, repair-loop count, token cost.
Rationale: LLMs are breadth-first generators; block syntax forces
depth-first commitment (late errors invalidate early structure). If
failures are mostly parse errors, the surface grammar is the suspect;
mostly missing primitives, we have the language-design research program;
mostly "D loses to A", the Gorard bet fails for this domain and the
language stays a checkable-output format — a real result either way.

## 8. Modularity and pluggability (HARD CONSTRAINT)

Everything above must integrate without breaking the generator-target
architecture that observability and data-source integrations already rely on:

- New member types slot into the existing brace grammar. v0.4 adds the
  eleven primitives in §2.1. `verify` is already in the grammar and is not
  one of the additions.
- New compiler passes are additive (graph validation, resolvability, verdict
  lattice) over the existing resolved IR.
- New backends are new generator modules in `compiler/src/generators/` —
  prometheus, grafana, otel, resolver-manifest, receipt — registered the same
  way typescript, z3, protobuf, k8s, openapi, cyclonedx, and spdx are.
  Observability and data sources stay pluggable targets.
- Resolver registry: a service interface plus a registry. A backend answers
  two queries, existence (compile-time) and shape/lookup (runtime). The
  in-tree reference backends are `filesystem` (Markdown with YAML
  frontmatter) and `static-manifest` (a JSON map of record id to measurement
  class). The SPI lives at `compiler/src/resolver/index.ts` and is exported
  from the package as `speckl/resolver`. A backend that lives outside this
  repository implements that interface and registers itself. There is no
  in-tree adapter for Greybeard Core. A Greybeard Core resolver adapter, if
  any, lives out of tree, is registered through that plug-in point, and is
  not imported by this repository. The compiler has no hard dependency on it
  and does not reach it over the network.
- The incident ledger is a runtime subsystem behind the resolver registry.
- Surfaces are front-ends: block syntax and the claims surface both lower to
  the same IR. Any new surface is a new parser, never a fork.

## 9. References

- Jonathan Gorard, "The Physicist Revolutionizing Physics With AI,"
  Theories of Everything, <https://youtu.be/oQypVVv1u1o>
- Lanyon AI team page (Gorard's co-founder and CEO title),
  <https://lanyon.ai/company/>
- Philip Mannheim, "Dark Matter and General Relativity Explained FROM
  SCRATCH," Theories of Everything, <https://youtu.be/HJcQLHqOziM>
- Catala: <https://catala-lang.org>; Inria Apollo program page
- CNAF press release, 8 June 2026, "La Cnaf et Inria s'engagent ensemble
  pour développer Catala":
  <https://caf.fr/professionnels/presse/publications/la-cnaf-et-inria-s-engagent-ensemble-pour-developper-catala-une-solution-souveraine-de-calcul-des>
- Toulmin, *The Uses of Argument* (1958)
- Defeasible logic / defeasible argumentation (DeLP); description logic and
  monotone subsumption as "modern syllogisms"
- TLA+ (Lamport) — temporal semantics reference for behavior claims
- CompCert — verification shifting trust to specification adequacy
- Hypothesis example database; TLA+ TLC; fuzzing corpus regression — the
  incident-as-test lineage
- Milgrom's law (a0 as measured transition) — cited for structure, and the
  Mannheim fits' universal-parameter argument (4 parameters for 138 galaxies
  vs dark matter's 2 per halo) as the "capture the systematic term once"
  design lesson in engineering: idempotency, consensus, backpressure
- AWS region/AZ/VPC nesting; DDIL environments — the systems version of
  scale-dependent coupling terms
