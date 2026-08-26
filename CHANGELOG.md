# Changelog

Notable changes to Dailies are recorded here. The project follows semantic
versioning while the public API remains pre-1.0.

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
