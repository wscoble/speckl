# Launch Kit - Social

## Show HN (the big lever - wait for the launch gate)

**Title options** (HN responds to specificity, not hype):
- "Show HN: Speckl - an AI writes formal specs of your system, Z3 proves them"
- "Show HN: A spec language where the compiler calls a theorem prover on your invariants"
- "Show HN: Conversational spec development with real bounded model checking"

**Prerequisites (launch gate, see STRATEGY.md):**
- [ ] Examples suite 144/144 (`npm run verify`) - GreybeardCore failures fixed (B-06)
- [ ] One-command setup: clone → `npm install && npm start` → working studio
- [ ] Landing page with embedded 60-90s demo
- [ ] B-12 `speckl-serve` at least in alpha (HN will ask "can I drive this myself?")
- [ ] Honest limitations section in the README (HN punishes omissions, not weaknesses)

**Post structure**: lead with the SignalBus story ("the solver rejected my own
design"), one GIF of the counterexample table, one of green annotations,
link repo. Stay in the thread all day; the strongest HN comments will be
"why not TLA+" - answer: ergonomics and the conversational loop, and be
genuinely grateful for the comparison.

**Timing**: Tuesday-Thursday, 8-10am ET. Have 2-3 hours free to reply.

## X thread - launch thread (8 posts)

1. "AI writes enormous amounts of code. Nothing writes down what it's
   *supposed* to do. I built the missing piece: an AI that interviews you,
   writes a formal spec, and a theorem prover proves it. Thread 🧵"
2. The stack in one image: spec → compiler → TypeScript / Z3 / Rust / Protobuf /
   K8s / OpenAPI / provenance / BOMs. "No LLM in the compilation path."
3. 15-second clip: typing a behavior description → spec appears → checks go green.
4. The SignalBus counterexample table. "The solver found this in my own
   design. Code review would not have."
5. The fix: one-line `require accepted == delivered` → 16/16 green.
6. Honest limits: bounded depth, advisory degradation - the tool says when
   it doesn't know. "A proof tool that lies is worse than none."
7. What's next: quantifier lowering, language server, plugin API for
   external agents.
8. Repo link + "specs from the video are in the repo. Show me what your
   system should do - I'll verify it on stream."

## LinkedIn (enterprise/provenance angle)

Post 1 - the compliance story:
> "In regulated software, the expensive question is never 'does the code
> work' - it's 'who decided what it should do, and can you prove it?'
> Speckl specs carry their intent with them: every constraint records the
> regulation, ADR, or conversation it came from (W3C PROV-O), and every
> verification run emits a software bill of materials. AI drafted this
> 16-property behavioral spec of a multi-tenant console. A solver proved
> all of it. The audit trail was not bolted on - it's part of the language."

## Shorts pipeline (cut from long-form, 2-3/week)

- Counterexample reveals (the drama shot - always end on the table)
- "Prove it in 60 seconds": one invariant, one verdict
- "Solver vs LLM": feed a buggy spec, watch them argue
- One-line-fix time lapses (red → green)
- "Explain bounded model checking" whiteboard-style (evergreen)

## Reply-engineering (the underrated lever)

Reply substantively to: TLA+/Alloy community members, MCP/agent-framework
builders, "AI code review" tool accounts. The formal methods community will
stress-test claims in public - engage honestly (the honest-degradation story
is the credibility moat). Every reply is next week's content.