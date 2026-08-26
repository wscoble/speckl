#!/usr/bin/env bash
# validate-all.sh — Batch compile all Speckl examples and validate outputs
# Usage: ./scripts/validate-all.sh [--quick] [--verbose]
#   --quick: only parse + TypeScript check
#   --verbose: show all errors
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
SPECKL_ROOT="$(dirname "$SCRIPT_DIR")"
COMPILER_DIR="$SPECKL_ROOT/compiler"
EXAMPLES_DIR="$SPECKL_ROOT/examples"
OUT_DIR="$COMPILER_DIR/out/ci-validation"
GREEN='\033[0;32m'
RED='\033[0;31m'
YELLOW='\033[1;33m'
NC='\033[0m'

QUICK=false
VERBOSE=false

for arg in "$@"; do
  case $arg in
    --quick) QUICK=true ;;
    --verbose) VERBOSE=true ;;
  esac
done

# Ensure compiler builds clean
echo "Building compiler..."
cd "$COMPILER_DIR"
if ! npx tsc --noEmit 2>&1; then
  echo -e "${RED}FAIL: Compiler has TypeScript errors${NC}"
  exit 1

# Run unit tests
echo "Running unit tests..."
TEST_OUTPUT=$(npm test 2>&1) || true
TEST_COUNT=$(echo "$TEST_OUTPUT" | grep -oP 'Tests\s+\K\d+(?=\s+passed)' | head -1 || echo "0")
FAIL_COUNT=$(echo "$TEST_OUTPUT" | grep -oP 'Tests\s+\K\d+(?=\s+failed)' | head -1 || echo "0")
if [ "$FAIL_COUNT" != "0" ] && [ "$FAIL_COUNT" != "" ]; then
  echo -e "${RED}FAIL: $FAIL_COUNT test(s) failing${NC}"
else
  echo -e "${GREEN}PASS: $TEST_COUNT tests passing${NC}"

# Prepare output directory
rm -rf "$OUT_DIR"
mkdir -p "$OUT_DIR"

echo ""
echo "============================================"
echo "  Speckl Compiler Validation"
echo "  $(date '+%Y-%m-%d %H:%M:%S')"
echo "============================================"
echo ""

# Results tracking
PASS=0
FAIL=0
PARSE_FAIL=0
TS_CLEAN=0
TS_ERRORS=0


declare -A RESULTS
declare -A TS_ERROR_COUNTS

NODE_BIN="$COMPILER_DIR/dist/index.js"
if [ ! -f "$NODE_BIN" ]; then
  echo -e "${RED}FATAL: Compiler dist not found at $NODE_BIN${NC}"
  exit 1

shopt -s nullglob
SPECS=( "$EXAMPLES_DIR"/*.speckdl )

for spec in "${SPECS[@]}"; do
  NAME=$(basename "$spec" .speckdl)
  EXAMPLE_OUT="$OUT_DIR/$NAME"
  mkdir -p "$EXAMPLE_OUT"
  
  echo -n "  $NAME ... "
  
  # Step 1: Parse + generate all artifacts
  PARSE_OUT=$(node "$NODE_BIN" "$spec" -o "$EXAMPLE_OUT" 2>&1) || true
  if echo "$PARSE_OUT" | grep -q "Error\|error:"; then
    echo -e "${RED}PARSE FAIL${NC}"
    RESULTS[$NAME]="PARSE_FAIL"
    PARSE_FAIL=$((PARSE_FAIL + 1))
    FAIL=$((FAIL + 1))
    continue
  
  # Step 2: Count artifacts generated
  
  # Step 3: TypeScript check
  TS_FILE="$EXAMPLE_OUT/$NAME.ts"
  TS_OK=false
  if [ -f "$TS_FILE" ]; then
    TS_CHECK_OUT=$(npx tsc --noEmit --target ES2020 --module commonjs --strict --lib ES2020 --skipLibCheck \
      "$TS_FILE" 2>&1) && TS_OK=true || true
    if [ "$TS_OK" = true ]; then
      TS_CLEAN=$((TS_CLEAN + 1))
    else
      TS_ERR_COUNT=$(echo "$TS_CHECK_OUT" | grep -c "error TS" 2>/dev/null || echo "0")
      TS_ERROR_COUNTS[$NAME]=$TS_ERR_COUNT
      TS_ERRORS=$((TS_ERRORS + 1))
      # Save error log
      echo "$TS_CHECK_OUT" > "$EXAMPLE_OUT/ts-errors.txt"
  else
    echo -e "${RED}NO TS OUTPUT${NC}"
    RESULTS[$NAME]="NO_TS"
    FAIL=$((FAIL + 1))
    continue
  
  
  # Final status
  if [ "$TS_OK" = true ]; then
    echo -e "${GREEN}OK${NC} ($ARTIFACT_COUNT artifacts, TS clean)"
    RESULTS[$NAME]="PASS"
    PASS=$((PASS + 1))
  else
    TS_ERR="${TS_ERROR_COUNTS[$NAME]:-?}"
    echo -e "${YELLOW}TS ERRORS: $TS_ERR${NC} ($ARTIFACT_COUNT artifacts)"
    RESULTS[$NAME]="TS_ERRORS"
    FAIL=$((FAIL + 1))
    if $VERBOSE && [ -f "$EXAMPLE_OUT/ts-errors.txt" ]; then
      head -20 "$EXAMPLE_OUT/ts-errors.txt"
done

echo ""
echo "============================================"
echo "  RESULTS"
echo "============================================"
TOTAL=${#SPECS[@]}
echo "  Total examples:    $TOTAL"
echo "  Parse success:     $((PASS + TS_ERRORS))/$((PASS + TS_ERRORS + PARSE_FAIL))"
echo "  Parse failures:    $PARSE_FAIL"
echo "  TS clean:          $TS_CLEAN"
echo "  TS with errors:    $TS_ERRORS"
echo "  Overall pass:      $PASS / $TOTAL"
if [ "$QUICK" = false ]; then
echo ""

# Detailed table
printf "  %-30s %s\n" "EXAMPLE" "STATUS"
printf "  %-30s %s\n" "-------" "------"
for spec in "${SPECS[@]}"; do
  NAME=$(basename "$spec" .speckdl)
  STATUS="${RESULTS[$NAME]:-UNKNOWN}"
  case $STATUS in
    PASS)       COLOR="$GREEN" ;;
    TS_ERRORS)  COLOR="$YELLOW" ;;
    PARSE_FAIL|NO_TS) COLOR="$RED" ;;
    *)          COLOR="$RED" ;;
  esac
  EXTRA=""
  if [ "$STATUS" = "TS_ERRORS" ]; then
    EXTRA=" (${TS_ERROR_COUNTS[$NAME]:-?} errors)"
  printf "  ${COLOR}%-30s %-12s${NC}%s\n" "$NAME" "$STATUS" "$EXTRA"
done

echo ""
echo "  Artifacts in: $OUT_DIR"
echo "  TS error logs: $OUT_DIR/*/ts-errors.txt"
echo ""

# Exit code
if [ $FAIL -gt 0 ] || [ $PARSE_FAIL -gt 0 ]; then
  exit 1
exit 0
