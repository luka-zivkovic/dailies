# ADR-0009: An abstained Rubrist outcome counts as not passing

Status: **Accepted**

Date: 2026-09-26

Decision owner: Luka Živković (founder).

## Context

Rubrist assessment receipt v2 (Rubrist ADR-0014 section 6) gives each item
exactly one result: an outcome (`pass`, `fail`, or `abstain`), a failure, or
`not_attempted`. An abstention is a completed outcome, so it leaves a receipt
complete. Under receipt v1 an `ambiguous` label made the whole receipt
incomplete, and every Dailies report treated that as incomplete evidence.

When Dailies switched to receipt v2 (ADR-0008 decision 2), its single-criterion
(v4) and suite (v5, and v6's embedded suite) reports needed a rule for an item
the evaluator abstained on. The founder chose between three options:

- count an abstention as not passing, with the pass rate unchanged as
  `passed / total` and abstentions shown separately;
- exclude abstentions from the pass rate and gate on a new, required minimum
  classified-coverage threshold, a configuration format change; or
- hold the release on any abstention, as v1 effectively did.

## Decision

The founder decided on 2026-09-26 that an abstention counts as not passing.
In the founder's words: "Pass rate stays passed / total, so an evaluator that
can't decide never earns a pass. Reports show the abstained count separately.
No new config field."

- The pass rate stays `passed / total`.
- Reports show the abstained count separately: `totals.abstained` in v4, and
  each criterion's `totals.abstained` in v5 and v6, a subset of `failed`.
- No configuration field is added.

The implementation derives these rules from "counts as not passing"; they are
recorded here so they can be revisited:

- An abstention compares with a baseline label as a fail does: against a
  `pass` baseline it is a regression, and against a `fail` baseline a stable
  fail. So an evaluator that abstains on everything can't promote under a
  regression-only policy, where receipt v1 would have been inconclusive.
- An abstained item is completed, verified evidence: it counts as evaluated.
  Dailies' `evaluationCoverage` is the share of items with a completed result,
  so an abstention doesn't lower it; Rubrist's classified coverage,
  `(pass + fail) / total`, is a different measure that it does lower.
- Only a Rubrist evaluator can abstain; exact-match and HTTP judges produce
  `pass` or `fail`.
- A receipt with any failure or `not_attempted` item stays incomplete, and
  Dailies records every submitted item as an `incomplete` judge error, as
  before.

## Consequences

- A release whose evaluator abstains often blocks, on its pass-rate threshold
  or on regressions against passing baselines, rather than holding as
  inconclusive. The report says why: the abstained count sits next to the pass
  rate in every format's markdown.
- At the launch baseline (ADR-0008 decision 4) this rule carries into the
  renumbered formats unchanged.
