# Dailies positioning note

Status: **time-sensitive market context; not product authority**

Last verified against linked official documentation: 2026-08-22

Refresh this note before using it in external claims. `PRODUCT.md` and accepted
ADRs define Dailies even when competitors change.

## Category context

Open-source eval frameworks already run AI tests in CI and block changes:

- [Promptfoo CI/CD](https://www.promptfoo.dev/docs/integrations/ci-cd/)
  integrates prompt and model evaluations with release workflows and
  configurable assertions.
- [DeepEval CI/CD](https://deepeval.com/docs/evaluation-unit-testing-in-ci-cd)
  brings end-to-end, component, single-turn, and multi-turn evaluations into
  pytest-style CI.
- [Braintrust experiments](https://www.braintrust.dev/docs/evaluate/run-evaluations)
  create immutable evaluation snapshots, run in CI, compare experiments, and
  support repeated trials.

Dailies should not claim that local evaluation, regression testing, thresholds,
CI integration, experiment comparison, or multiple evaluator types are unique.

## Intended wedge

Dailies treats a release decision as a typed evidence-policy problem across
systems:

- every claim is bound to a declared evidence scope;
- verified, deterministic, and self-reported evidence remain distinct;
- baseline/candidate cells distinguish regression, improvement, stable states,
  and missing comparison evidence;
- mandatory, advisory, blocking, and explicitly compensatory criteria remain
  visible;
- infrastructure or evidence failure produces `inconclusive`, not a fabricated
  product failure or accidental promotion; and
- customer policy, override, and the final release consequence live outside
  the evaluator provider.

The wedge is therefore not a larger evaluator catalog. It is a trustworthy
release-decision layer that can consume heterogeneous evidence without
overstating what the evidence proves.

## What Dailies must prove

- Adversarial decision tests show materially fewer false promotions under
  partial, tampered, mixed-trust, and scope-mismatched evidence.
- Release owners can understand and act on `inconclusive` rather than bypassing
  it.
- Scope and criterion policy remain usable enough that teams do not fall back
  to one opaque aggregate threshold.
- Dailies can interoperate with Rubrist (formerly Coeval) and deterministic tools without becoming
  a serving-path proxy or duplicating their analysis.

Until those comparative tests exist, these are product hypotheses rather than
superiority claims.
