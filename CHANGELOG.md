# Changelog

Notable changes to Dailies are recorded here. The project follows semantic
versioning while the public API remains pre-1.0.

## Unreleased

- Remove read-only inspection of historical v3 reports and the captured v3
  fixtures (ADR-0008, founder decision 2026-09-25). Nothing reads a v3 report
  any more; report v4 keeps the same integrity and Rubrist-linkage rules it
  previously borrowed from the v3 schema.

## 0.4.0 — 2026-09-23

- Publish the Rubrist-compatible consumer and align the npm package, GitHub
  Action default, and plugin at 0.4.0. This pre-1.0 breaking release consumes
  Rubrist 0.3.0 evidence; Dailies 0.3.x remains the Coeval-era consumer.
  Existing Coeval configuration identifiers are not aliases. Recreate
  disposable test evidence using the renamed contracts before using 0.4.0.

- Rename the consumed evidence provider Coeval to Rubrist (ADR-0007, owner
  decision 2026-09-22). Vendored contract IDs are now `rubrist/<name>/v1` and
  `rubrist-canonical-json/v1`; the configuration judge/provider `type` is
  `rubrist`; report evidence kinds are `rubrist_receipt_v1` and
  `rubrist_binary_calibration_v1`; exported names follow (for example
  `verifyRubristReceipt`); `src/coeval.ts` and `scripts/mock-coeval.mjs` are
  now `src/rubrist.ts` and `scripts/mock-rubrist.mjs`. The old spellings are
  not accepted as aliases. Vendored contracts are re-vendored byte-identical
  from Rubrist, and derived digests and examples are regenerated. The
  `dailies` plugin is aligned with the 0.4.0 package release.
- Propose ADR-0006 for Promptfoo, DeepEval, and Braintrust result intake.
  It records that imported results are `self_reported` under ADR-0001 and
  lists the questions that need a decision first: candidate-execution
  ownership, scope identity, and score mapping. It adds a "Bring your own eval
  platform" README section and a PLAN note. Docs only; no runtime change.
- Make the Coeval `bounds polling` test deterministic: it drives the poll
  deadline through a faked `Date` instead of a 25ms wall-clock budget, so a
  slow local round-trip can no longer turn the expected `deadline`
  termination into a recorded `timeout` attempt. Test-only; no runtime change.
- Bump the dev-only transitive dependency `fast-uri` (pulled in by `ajv`,
  used only in contract tests) from 3.1.5 to 3.1.8 in the lockfile to clear
  four high-severity advisories (GHSA-5jgf-p345-68v8, GHSA-f65p-4m7j-42xc,
  GHSA-fph4-wmhf-6fwf, GHSA-jqff-g426-hqxp). No runtime dependency changes.
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
- Add runnable schema-v5 and schema-v6 examples under `fixtures/examples/`,
  generated from the vendored Coeval contract fixtures by
  `scripts/build-examples.mjs` (`npm run examples:build`), together with
  `scripts/mock-coeval.mjs`, a local stub for the three receipt-v1 endpoints
  that returns scripted, structurally valid evidence. End-to-end tests run
  the v4, v5, and v6 examples, check the committed files against the
  generator, and show `block` and `inconclusive` paths through the stub.
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
