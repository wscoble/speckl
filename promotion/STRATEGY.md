# Speckl Promotion Strategy

> Positioning: **AI writes your specs. Z3 signs off.**
> The reviewer is a theorem prover, not another model.

## The one-sentence pitch

Speckl is a specification language + conversational studio where an AI
interviews you about your system's behavior, writes a formal spec, and a
deterministic solver (Z3) *proves* it - or hands you a counterexample in
plain English. No LLM in the compilation path. Same spec, same proof,
every time.

## Why this lands now

1. **"AI-written code, who checks it?"** is the anxiety of 2025-2026. Speckl
   flips the stack: AI writes, deterministic math verifies.
2. Formal methods content is underserved on YouTube - rigorous content with
   production quality stands out immediately.
3. The tool has a built-in story arc: the solver catches *its own author*
   (the SignalBus close-without-drain bug was found by the tool during
   development - on camera material).

## Audiences (in order of conversion likelihood)

| Audience | Hook | Venue |
|---|---|---|
| AI-native builders (agents, MCP, GPT devs) | "Your agent writes specs; a solver signs off" | X, AI Engineer-style confs, YouTube |
| Senior/staff engineers skeptical of AI code | "Proofs, not vibes" - deterministic, auditable | HN, YouTube, conference talks |
| Formal methods community (TLA+/Alloy/P) | "TLA+ ergonomics with a conversational front end" | ICFEM/SEFM tool papers, Lambda-ish venues |
| Regulated industries (medical, fintech, aviation) | Provenance-native: every constraint carries its intent (PROV-O, SpeckBOM) | LinkedIn, conference industry tracks |

## Content pillars (each maps to real assets)

1. **Proofs, not vibes** - solver verdicts, counterexample traces as drama
2. **Worked examples** - ToggleSwitch → Raft, GreybeardConsole (16/16 proven)
3. **Building in public** - the studio, the compiler fixes, honest limitations
4. **War stories** - bugs the solver caught that review missed (SignalBus is #1)

## The SignalBus story (the flagship narrative - use everywhere)

While building the GreybeardConsole spec suite, the tool flagged its own
signal-bus design: `Close` didn't require a drained bus, so a closed bus
could strand undelivered signals - and after closing, `Acknowledge` could
never run. A real design flaw, found by bounded model checking *before
implementation*, presented as a readable per-step state table, fixed with a
one-line drain-before-close guard, and re-proven: **16/16 checks green.**
That loop - draft → prove → violated → fix → proven - is the product.

## Funnel

- **Discover**: YouTube shorts (counterexample reveals, 30-60s), X threads, Show HN
- **Learn**: long-form YouTube (10-15 min worked examples), blog posts mirroring videos
- **Try**: one-command studio (`npm start`), spec corpus on GitHub
- **Convert**: conference talks → stars → users → (later) Greybeard as the commercial proof point

## Cadence (sustainable solo)

- 1 long-form YouTube video / week (10-15 min, screen-first, low production overhead)
- 2-3 shorts/week cut from long-form (counterexample reveals are perfect shorts)
- 1 X thread or LinkedIn post / week (alternate audiences: AI builders ↔ formal methods)
- 1 blog post / video (mirrors for SEO)
- Conference CFPs on the calendar (see conference-talk.md)

## Gates (what must be true before big swings)

- **Show HN launch gate**: examples suite 144/144 green · one-command local setup ·
  landing page with an embedded 60-90s demo · B-12 (serve API) at least in alpha
- **Conference talk gate**: GreybeardConsole case study written up; a second
  worked example outside Greybeard's domain (breadth)
- Building-in-public content starts immediately - it needs no gate

## Metrics that matter (weekly)

YouTube: retention @ 30s (>70%), average view duration, CTR. X: replies from
engineering accounts (not likes). HN: comment quality (are the objections
about limitations we can fix?). Conference: submissions accepted → talk given.
North star: **external specs contributed to the repo**.