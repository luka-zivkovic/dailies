#!/usr/bin/env bash
# Step logic for the Dailies composite GitHub Action (action.yml).
#
# Inputs arrive as environment variables so the same logic can be tested
# outside GitHub Actions:
#   DAILIES_CONFIG                path to the Dailies config (required)
#   DAILIES_VERSION               dailies npm version passed to npx (default: latest)
#   DAILIES_FAIL_ON_INCONCLUSIVE  true|false (default: true)
#   DAILIES_SUMMARY               true|false (default: true)
#
# Exit-code mapping (never maps inconclusive to success silently):
#   0 -> promote      step succeeds (only if report.json also says promote)
#   1 -> block        step fails
#   2 -> inconclusive step fails, or warns when DAILIES_FAIL_ON_INCONCLUSIVE=false
#   other             step fails with that code
set -euo pipefail

config="${DAILIES_CONFIG:-}"
version="${DAILIES_VERSION:-latest}"
fail_on_inconclusive="${DAILIES_FAIL_ON_INCONCLUSIVE:-true}"
summary="${DAILIES_SUMMARY:-true}"

fail() {
  echo "::error::$1"
  exit "${2:-2}"
}

lower() {
  printf '%s' "$1" | tr '[:upper:]' '[:lower:]'
}

case "$(lower "$fail_on_inconclusive")" in
  true) fail_on_inconclusive=true ;;
  false) fail_on_inconclusive=false ;;
  *) fail "action input 'fail-on-inconclusive' must be true or false, got '$fail_on_inconclusive'" ;;
esac
case "$(lower "$summary")" in
  true) summary=true ;;
  false) summary=false ;;
  *) fail "action input 'summary' must be true or false, got '$summary'" ;;
esac

[ -n "$config" ] || fail "action input 'config' is required"
[ -f "$config" ] || fail "Dailies config not found: $config"
command -v node >/dev/null 2>&1 ||
  fail "node was not found; add actions/setup-node (Node.js 20 or newer) before this action"
command -v npx >/dev/null 2>&1 || fail "npx was not found; it ships with Node.js 20 or newer"

# Resolve the configured output directory relative to the config file.
report_dir="$(node -e '
  const { readFileSync } = require("node:fs");
  const { dirname, isAbsolute, resolve } = require("node:path");
  const configPath = resolve(process.argv[1]);
  try {
    const config = JSON.parse(readFileSync(configPath, "utf8"));
    const dir = config && config.output && typeof config.output.dir === "string" ? config.output.dir : "";
    if (dir) process.stdout.write(isAbsolute(dir) ? dir : resolve(dirname(configPath), dir));
  } catch {
    // An unreadable config is reported by the CLI itself as exit 2.
  }
' "$config")"
report_json=""
report_md=""
if [ -n "$report_dir" ]; then
  report_json="$report_dir/report.json"
  report_md="$report_dir/report.md"
fi

# A report left over from an earlier run is never read as this run's result.
# Real reports always change between runs because they record timestamps.
snapshot() {
  if [ -n "$1" ] && [ -f "$1" ]; then
    node -e '
      const { createHash } = require("node:crypto");
      const { readFileSync } = require("node:fs");
      process.stdout.write(createHash("sha256").update(readFileSync(process.argv[1])).digest("hex"));
    ' "$1"
  else
    echo absent
  fi
}
before_json="$(snapshot "$report_json")"
before_md="$(snapshot "$report_md")"

set +e
npx --yes "dailies@${version}" --config "$config"
code=$?
set -e

fresh() {
  [ -n "$1" ] && [ -f "$1" ] && [ "$(snapshot "$1")" != "$2" ]
}

decision=""
if fresh "$report_json" "$before_json"; then
  decision="$(node -e '
    const { readFileSync } = require("node:fs");
    try {
      const report = JSON.parse(readFileSync(process.argv[1], "utf8"));
      const decision = report && report.decision;
      if (["promote", "block", "inconclusive"].includes(decision)) process.stdout.write(decision);
    } catch {}
  ' "$report_json")"
else
  report_json=""
fi
fresh "$report_md" "$before_md" || report_md=""

if [ -z "$decision" ]; then
  case "$code" in
    0) fail "dailies exited 0 but wrote no readable report.json; refusing to treat the run as promote" 1 ;;
    1) decision=block ;;
    *) decision=inconclusive ;;
  esac
fi

if [ -n "${GITHUB_OUTPUT:-}" ]; then
  {
    echo "decision=$decision"
    echo "exit-code=$code"
    echo "report-json=$report_json"
    echo "report-md=$report_md"
  } >> "$GITHUB_OUTPUT"
fi

if [ "$summary" = true ] && [ -n "$report_md" ] && [ -n "${GITHUB_STEP_SUMMARY:-}" ]; then
  cat "$report_md" >> "$GITHUB_STEP_SUMMARY"
  echo "" >> "$GITHUB_STEP_SUMMARY"
fi

echo "dailies decision: $decision (exit code $code)"
[ -z "$report_json" ] || echo "report: $report_json"
[ -z "$report_md" ] || echo "report: $report_md"

case "$code" in
  0)
    [ "$decision" = promote ] ||
      fail "dailies exited 0 but report.json records '$decision'; refusing to treat the run as promote" 1
    exit 0
    ;;
  1)
    fail "Dailies blocked the release: complete, admissible evidence shows a policy violation" 1
    ;;
  2)
    if [ "$fail_on_inconclusive" = true ]; then
      fail "Dailies was inconclusive: required evidence is missing, failed, or not trusted; this is not a pass" 2
    fi
    echo "::warning::Dailies was inconclusive: required evidence is missing, failed, or not trusted. The step passed only because fail-on-inconclusive is false; the decision output is still 'inconclusive'."
    exit 0
    ;;
  *)
    fail "dailies exited with unexpected code $code" "$code"
    ;;
esac
