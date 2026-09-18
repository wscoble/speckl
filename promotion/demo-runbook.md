# Demo Recording Runbook

The demo IS the product footage. Every recording must be reproducible.

## Pre-flight (every recording)

- [ ] `cd ~/Work/speckl/studio && npm start` → http://localhost:7333 (tmux: `speckl-studio`)
- [ ] `curl localhost:7333/api/health` → ok, model `glm-5.3-flash:cloud` reachable
- [ ] `cd ~/Projects/speckl/compiler && npm run verify` → 142/144+ (know the exact number on camera day)
- [ ] Fresh browser profile, hard refresh (Ctrl+Shift+R) - cached bundles have bitten before
- [ ] Editor font 13→16px, dark theme, 1440p capture, mic gain checked
- [ ] Close notifications; disable screen notifications

## The canonical demo arc (record end-to-end once, then segment)

1. **Token bucket** (proven path): new session → describe behavior → let the AI
   interview → draft → verify → green annotations. ~90s of usable footage.
2. **SignalBus** (the story): open the GreybeardConsole session →
   `Always(ClosedMeansEmpty)` red ✘ → counterexample table full-screen →
   apply the one-line fix (`require accepted == delivered` in Close) →
   live re-verify → 16/16 green. This is the emotional core; never cut the
   solver run itself.
3. **Honest degradation**: open a spec with `forall` sugar (OAuth2-style) and
   show the dim `◌ not machine-provable` markers with remediation hints.
   "It tells you when it can't prove something" - credibility shot.
4. **Compiler one-liner** (terminal): `speckl-compile GreybeardConsole.speckdl -t all`
   → TypeScript, Z3, Rust, Protobuf, K8s CRDs, OpenAPI, provenance, BOMs.

## Studio behaviors to know before recording

- Verification is live: pauses in typing auto-verify after ~1.2s - pause deliberately
- Hovering annotations reveals solver details and remediation hints (slow, deliberate hovers)
- The status pill: `● edited` → `⟳ verifying` → `● verified` / `⚠ advisory` / `● failures`
- Folding: hover fold gutter for block guides; fold a speck for clean zoom-outs
- Sessions auto-reopen the last spec - stage the session you want on screen before recording

## Failsafe

If the model is slow or derails live: pre-stage a session (run the real
conversation once, keep the transcript) and replay it on camera. The verdicts
are deterministic - re-running verify gives identical results. Never fake a
solver output; the honesty IS the brand.

## Shot list for the 60-90s landing-page embed

1. 0-3s: cold open on the counterexample table (already on screen)
2. 3-10s: chat prompt → AI clarifying question
3. 10-20s: spec writes itself in the editor (annotations dim → verify)
4. 20-35s: time-lapse green checks filling in (16/16)
5. 35-50s: the SignalBus red ✘ → one-line fix → green
6. 50-60s: end card - "speckl. AI writes your specs. Z3 signs off." + repo URL