# Show HN Demo Script — Speckl

**Purpose:** 2-3 minute terminal recording for the Show HN post (May 12-13)
**Format:** Terminal screen recording (asciinema or screen-capture GIF)
**Goal:** Show "spec in, 5 auditable artifacts out" in under 3 minutes

## Pre-flight (before recording)

```bash
# Verify compiler is clean
cd ~/speckl/compiler
npm test  # should show 41/41 passing

# Clear output
rm -rf out/demo-script
```

## Scene 0: Title Card (5 sec)
Show `~/speckl/examples/` directory listing. Voiceover or text overlay:
> "Speckl is a judgement transport utility for AI-generated specifications. Let me show you what happens when you compile a spec."

## Scene 1: The Spec (15 sec)

```bash
cat examples/ToggleSwitch.speck
```

Narrate:
- "This is SpeckDL — a specification language designed for both humans and compilers."
- "It has types, records, state variables, actions with guards, preconditions, and postconditions."
- "This is the same ToggleSwitch you'd write in TLA+, but with one difference: it compiles."

## Scene 2: One Command, Five Artifacts (20 sec)

```bash
node dist/index.js examples/ToggleSwitch.speck -o out/demo-script
ls -la out/demo-script/
```

Narrate:
- "One command. Five artifacts."
- "A PROV-O provenance graph, a TypeScript state machine, WebAssembly, a CycloneDX BOM, and an SPDX BOM."
- "Every one of these is independently auditable."

## Scene 3: The TypeScript (20 sec)

```bash
cat out/demo-script/ToggleSwitch.ts
```

Narrate:
- "This is production-ready TypeScript generated from the spec."
- "The state machine is a class with typed methods for every action."
- "Guards become assertions. Actions become mutations."

## Scene 4: TypeScript Compiles Clean (10 sec)

```bash
npx tsc --noEmit out/demo-script/ToggleSwitch.ts
echo "Exit code: $?"  # should be 0
```

Narrate:
- "It compiles with zero errors. You could import this into any TypeScript project right now."

## Scene 5: The WASM (15 sec)

```bash
head -40 out/demo-script/ToggleSwitch.wat
```

Narrate:
- "It also compiles to WebAssembly. This is the exact same spec — same toggle logic — but now it runs in any browser or edge runtime."
- "One spec, multiple targets. That's the power of compiler-level provenance."

## Scene 6: The Provenance Graph (15 sec)

```bash
python3 -m json.tool out/demo-script/ToggleSwitch.prov.jsonld | head -30
```

Narrate:
- "Every artifact links back to the original spec through a W3C PROV provenance graph."
- "This is what NIST SA-11 calls 'human-in-the-loop for automated outputs.'"
- "You can prove what ran came from what you wrote."

## Scene 7: The BOMs (15 sec)

```bash
cat out/demo-script/ToggleSwitch.specbom.cdx.json | head -20
echo "..."
cat out/demo-script/ToggleSwitch.specbom.spdx.json | head -20
```

Narrate:
- "And you get two machine-readable bills of materials — CycloneDX and SPDX."
- "This means your compliance team can import Speckl's output directly into their existing toolchain."

## Scene 8: TigerBeetle (15 sec) — CONDITIONAL

Only include if engineering#9 + #11 are fixed by launch day:

```bash
node dist/index.js examples/TigerBeetleLedger.speck -o out/demo-tiger
npx tsc --noEmit out/demo-tiger/TigerBeetleLedger.ts
echo "Exit code: $?"  # should be 0 if bugs fixed
```

Narrate:
- "And it scales. Here's a naive TigerBeetle port — a double-entry ledger with 7 actions, 5 preconditions, and 4 postconditions."
- "Zero TypeScript errors. Production-ready from a spec."

If NOT fixed by launch day, skip this scene. Instead show:

```bash
cat examples/TigerBeetleLedger.speck | head -40
```

Narrate:
- "And here's what we're working on next: a full TigerBeetle-style double-entry ledger. Spec written, compilation in progress. Follow the repo for updates."

## Scene 9: Call to Action (10 sec)

Show the repo URL and landing page:

```bash
echo "github:  https://os.scoble.me/forgejo/sscoble/speckl"
echo "mirror:  https://codeberg.org/sscoble/speckl"
echo "site:    https://speckl.scoble.me"
echo "spec:    speckl.scoble.me#try-it — paste a spec and see output"
```

Narrate:
- "Speckl is MIT-licensed and open source. The whitepaper is in the repo. I'd love your feedback."

## Recording Tips

1. **Use asciinema** for terminal recording — it produces lightweight `.cast` files that can be embedded or converted to GIF
   ```bash
   asciinema rec speckl-demo.cast
   ```
2. **Or use terminalizer** for a styled GIF with a config file
3. **Keep it under 3 minutes** — Show HN attention spans are short
4. **No audio needed** — terminal text + captions work better for HN
5. **Paste the asciinema link or GIF** directly in the Show HN post body

## Alternative: Static Screenshot Flow

If terminal recording is too much setup, use 5-6 screenshots in sequence:
1. The `ToggleSwitch.speck` source
2. The `ls` output showing 5 generated files
3. A snippet of generated TypeScript
4. The `tsc --noEmit` clean exit
5. A snippet of the PROV-O JSON
6. The landing page with "Try It" CTA

Less impressive than a recording, but zero setup time.

## Post-Launch

After Show HN goes live, share the demo recording on:
- Twitter/X with the HN link
- LinkedIn with a short writeup
- r/programming (Reddit)
- Speckl landing page (embed the asciinema player)
