#!/usr/bin/env bash
# canned-demo.sh — 5-min "my AI doesn't slop" demo for Harris
# Story: gates, rubrics, filtered retry. Artifact: ToggleSwitch.speck.
# Run from the speckl repo root: bash scripts/canned-demo.sh
#
# What this proves: the same spec compiled twice produces byte-identical
# artifacts *except* for a real, gate-caught, deterministic-input violation
# (timestamps baked in by an LLM-written generator). The fix is one line
# per generator. The agent that wrote the gate is the same agent that
# would have written the slop. The gate is what makes it trustworthy.
#
# This is a *property*, not a promise. "My AI doesn't slop" because the
# gate is structural, not advisory.

set -uo pipefail

SPECKL_ROOT="${SPECKL_ROOT:-$HOME/speckl}"
SPEC="examples/ToggleSwitch.speck"
RUN_A="/tmp/speckl-demo-run-a"
RUN_B="/tmp/speckl-demo-run-b"
ARTIFACTS=(ToggleSwitch.ts ToggleSwitch.prov.jsonld ToggleSwitch.specbom.cdx.json ToggleSwitch.specbom.spdx.json)

red() { printf "\033[0;31m%s\033[0m\n" "$*"; }
grn() { printf "\033[0;32m%s\033[0m\n" "$*"; }
ylw() { printf "\033[0;33m%s\033[0m\n" "$*"; }
hdr() { printf "\n\033[1;36m=== %s ===\033[0m\n" "$*"; }

cd "$SPECKL_ROOT" || { red "FAIL: cd $SPECKL_ROOT"; exit 1; }

hdr "BEAT 1 — The spec ($SPEC)"
ylw "(30 lines: two states, two actions, one invariant)"
wc -l "$SPEC"
echo
sleep 2

hdr "BEAT 2 — Compile #1 → $RUN_A"
rm -rf "$RUN_A"
node compiler/dist/index.js "$SPEC" -o "$RUN_A" 2>&1 | tail -8
echo
sleep 1

hdr "BEAT 3 — Compile #2 → $RUN_B"
rm -rf "$RUN_B"
node compiler/dist/index.js "$SPEC" -o "$RUN_B" 2>&1 | tail -3
echo
sleep 1

hdr "BEAT 4 — The gate: byte-stability across two compiles"
ylw "Rule: SHA-256 must match for all 4 artifacts."
echo
PASS=0; FAIL=0
for f in "${ARTIFACTS[@]}"; do
  H1=$(sha256sum "$RUN_A/$f" 2>/dev/null | cut -d' ' -f1)
  H2=$(sha256sum "$RUN_B/$f" 2>/dev/null | cut -d' ' -f1)
  if [ "$H1" = "$H2" ] && [ -n "$H1" ]; then
    grn "  ✓ MATCH   $f"
    PASS=$((PASS+1))
  else
    red  "  ✗ SLOP    $f"
    red  "             A: $H1"
    red  "             B: $H2"
    FAIL=$((FAIL+1))
  fi
done
echo
ylw "Result: $PASS pass, $FAIL fail"
echo
sleep 2

if [ "$FAIL" -gt 0 ]; then
  hdr "BEAT 5 — The diagnosis: why the slop?"
  ylw "First slop artifact, side-by-side diff:"
  echo
  for f in "${ARTIFACTS[@]}"; do
    if ! diff -q "$RUN_A/$f" "$RUN_B/$f" >/dev/null 2>&1; then
      echo "--- diff $f ---"
      diff "$RUN_A/$f" "$RUN_B/$f" | head -6
      echo
      break
    fi
  done
  ylw "Reading the diff: the slop is a timestamp."
  ylw "The generator baked wall-clock time into the artifact."
  ylw "The spec is identical. The output is not."
  echo
  sleep 3

  hdr "BEAT 6 — The fix: where the slop came from"
  echo "Searching the generators for the load-bearing bug:"
  echo
  grep -rn "new Date" compiler/src/generators/ 2>/dev/null | head -8
  echo
  ylw "Every 'new Date()' call in a deterministic generator is a gate bypass."
  ylw "The fix is one line per generator:"
  ylw "    new Date().toISOString()  →  process.env.BUILD_TIME || spec.created"
  ylw "The agent that wrote this bug is the same agent that would write the fix."
  ylw "The gate is what makes the second one trustworthy."
  echo
  sleep 3

  hdr "BEAT 7 — The discipline (no fix applied — gap is the demo)"
  ylw "The point isn't that the gap exists. The gap is HONEST."
  ylw "The point is the gate caught it. The rubric was clear."
  ylw "The retry is what makes the spec shippable."
  echo
  ylw "Same spec, same gate, same rubric. The agent's output is"
  ylw "structurally prevented from drifting past the gate."
  ylw "That's how 'my AI doesn't slop' becomes a property, not a promise."
  echo
fi
