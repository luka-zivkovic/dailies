# Changelog

Notable changes to Dailies are recorded here. The project follows semantic
versioning while the public API remains pre-1.0.

## Unreleased

- Add `dailies digest --config <path>` to recompute the JSONL input
  artifact's SHA-256 digest and line count and rewrite only `inputs.digest`
  and `scope.expectedItems` in place for schema v4, v5, and v6 configs,
  preserving key order and formatting; `--check` reports drift without
  writing and exits `1` on mismatch. Document it in the README quickstart, a
  new CLI reference, and the `release-gate` skill.
- Add a composite GitHub Action at the repository root
  (`uses: luka-zivkovic/dailies@<ref>`) with `config`, `version`,
  `fail-on-inconclusive`, and `summary` inputs and `decision`, `exit-code`,
  `report-json`, and `report-md` outputs. It runs the pinned npm release,
  appends `report.md` to the job summary, fails on `block`, and fails on
  `inconclusive` by default (a `::warning::` only when explicitly opted out).
  The step logic lives in `scripts/action-run.sh` and is tested against a
  fake CLI for every exit-code mapping, stale-report handling, and outputs.
- Add a Claude Code plugin marketplace (`.claude-plugin/marketplace.json`)
  and the `dailies` plugin with a `release-gate` skill so a coding agent can
  install Dailies in one line, initialize a digest-pinned starter corpus, run
  the release evaluation, and read the tri-state decision without treating
  `inconclusive` as a pass; document the install in the README.
- Add `CONTRIBUTING.md` describing the required local checks, the
  `TARGET`/`CURRENT`/`ASSUMPTION` evidence labels, and the rule against
  implementing proposed ADRs without approval; link it from the README.
- Run continuous integration on a Node.js 20 and 22 matrix and add the
  `npm run invariant:batch6` robustness gate as a CI step.
- Stop hardcoding the test count in the README and describe the CI matrix
  and invariant gate accurately.

## 0.3.0 — 2026-08-26

- Add `dailies init [directory]` to generate a runnable, digest-pinned starter
  corpus and schema-v4 configuration without overwriting existing files.
- Make the npm quickstart lead directly from installation to a first auditable
  release report.

## 0.2.1 — 2026-08-26

- Correct the public npm installation instructions after the `0.2.0` registry
  release.

## 0.2.0 — 2026-08-26

- Bind release decisions to exact evidence scopes and explicit trust classes.
- Emit `promote`, `block`, or `inconclusive` without turning missing evidence
  into a synthetic product result.
- Add additive v5 multi-criterion suite policy and v6 calibration-aware policy.
- Verify pinned Coeval receipts, evaluator-suite manifests, and binary
  calibration artifacts through closed contracts and adversarial fixtures.
- Add deterministic retry evidence, canonical reports, and an authored
  invariant robustness gate.
- Publish the library entry point and TypeScript declarations alongside the
  CLI.

## 0.1.0 — 2026-08-11

- Initial local CLI for evaluating a candidate against historical JSONL inputs.
- Command and HTTP candidates, exact-match and HTTP judges, JSON/Markdown
  reports, and tri-state CI exit codes.
