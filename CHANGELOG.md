# Changelog

Notable changes to Dailies are recorded here. The project follows semantic
versioning while the public API remains pre-1.0.

## Unreleased

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
