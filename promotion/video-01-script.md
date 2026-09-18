# Video 01 - "My AI caught its own design bug with a theorem prover"

Format: screen-first, 8-10 min, minimal talking head (intro/outro only).
Assets: studio running at localhost, GreybeardConsole session, terminal for
`npm run verify`.

## Hook (0:00-0:40) - cold open on the counterexample table

Show the counterexample table on screen while narrating:

> "This is my own design bug. I wrote a signal bus that accepts messages and
> delivers them. I closed the bus while a message was still in flight - and
> it can never be delivered, because the acknowledge action can't run once
> the bus is closed. I didn't find this in code review. A theorem prover
> found it, and it told me exactly which steps broke. This is the story of
> why I built this."

Title card: **Speckl - AI writes your specs. Z3 signs off.**

## Section 1 - The problem (0:40-2:00)

- AI writes enormous amounts of code; nothing writes *what it should do*
- Tests check what you thought to check; reviews check what a human noticed
- Formal methods solves this - TLA+ etc. - but the ergonomics stop most teams
- "So I built the tool I wanted: you describe behavior in plain language, an
  AI interviews you about edge cases, writes a formal spec, and a solver
  *proves* it. The key rule: **no LLM in the compilation path**. Same spec,
  same proof, every time."

## Section 2 - Live demo part 1: draft and prove (2:00-4:30)

In the studio (chat left, spec editor right, live annotations):

1. Type: "I want a token-bucket rate limiter: capacity 10, refills over time,
   requests consume tokens, reject when empty."
2. Show the AI asking clarifying questions (cut to keep pace), drafting
   `TokenBucket`, calling write_spec → compile diagnostics inline
3. Verify: inline annotations flip green - "✔ proven within depth"
4. Hover a verdict: "the solver proved the bucket can never go negative"
5. Key line: "Every green checkmark is a theorem about my design, not a
   test that passed on Tuesday."

## Section 3 - Live demo part 2: the solver catches the design (4:30-7:30)

The GreybeardConsole story, replayed honestly:

1. SignalBus spec: Accept (sequence numbers), Acknowledge (FIFO), Close.
2. Verify → red ✘ on `ClosedMeansEmpty`.
3. Show the counterexample table full-screen: accepted 0→1, delivered stays 0,
   open flips false at step 1.
4. Narrate the flaw: "Closing the bus doesn't require a drained bus - and
   after close, Acknowledge can never run. That's not a test failure; that's
   a design that cannot be saved by good implementation."
5. Fix live: add `require accepted == delivered` to Close.
6. Re-verify: **16/16 green**.
7. "The AI didn't just write the spec - the solver argued with both of us."

## Section 4 - What speckl actually is (7:30-9:00)

Fast cuts: spec → compiler → outputs (TypeScript, Z3, Rust, Protobuf, K8s
CRDs, OpenAPI, provenance JSON-LD, BOMs). Mention: provenance-native (every
constraint carries its intent - the compliance story), local-first, MIT.
Honest limitations: bounded model checking (depth-limited), some constructs
still degrade to advisory - the tool tells you when it's advisory.

## Outro / CTA (9:00-9:30)

- "Specs, examples, and the full source are on GitHub."
- "Next episode: we prove a Raft consensus implementation's leader-election
  invariants - subscribe if you want to see a solver disagree with an LLM."
- End card with repo link.

## Production notes

- Record 1440p, editor font size 13→16 for legibility, dark theme matches the studio
- Keep every solver verdict on screen ≥3 seconds
- Cut AI typing latency (the only acceptable cuts); never cut solver runs
- Music: none or minimal; the counterexample table is the drama
- Captions: the narrative lines double as a blog post (SEO mirror)

## Shorts to cut from this video (do not overthink)

1. 30s: counterexample table reveal - "the solver found a bug my code review wouldn't"
2. 45s: green checks flipping as the spec verifies - "proofs, not vibes"
3. 45s: "no LLM in the compilation path" with the compiler pipeline diagram
4. 60s: the fix loop - red ✘ → one-line guard → 16/16 green