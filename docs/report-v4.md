# Dailies report and configuration v4

Status: **accepted Batch 1B contract**

Version 4 makes evidence scope and trust part of the release decision. Its
Rubrist evidence is assessment receipt v2 (ADR-0008), and it does not introduce
multi-criterion policy.
It remains an executable compatibility contract after additive v5 introduced
criterion suites; v4 artifacts are never reinterpreted as suite evidence.

## Configuration contract

Release execution accepts only a strict configuration with
`schemaVersion: 4`.

The input declaration pins the exact JSONL bytes with a lowercase
`sha256:<64 hex>` digest. Dailies verifies that digest before candidate work.
Each non-empty JSONL line is a strict input object; unknown item keys are
rejected rather than silently discarded.
The declared scope contains:

- stable scope id;
- `regression_corpus`, `sealed_representative_evaluation`,
  `production_sample`, or `manual_review_set` kind;
- expected item count;
- collection procedure and applicable population; and
- either an inclusive ISO-8601 time range or an explicit `not_applicable`
  reason.

Trust policy lists the admissible classes. `verified` and `deterministic` are
the default. Listing `self_reported` requires a visible self-reported-evidence
override with a non-empty reason; an override without that class is also
invalid.
`production_sample` always requires a bounded, ordered time range.

## Derived trust contract

Trust is derived from the integration path and cannot be supplied by a judge:

| Judge path | Trust class | Derivation |
| --- | --- | --- |
| Exact match | `deterministic` | `exact_match_v1` |
| Fully verified Rubrist receipt path | `verified` | `rubrist_receipt_v2` |
| Generic HTTP judge | `self_reported` | `http_judge_v1` |

Completed item evidence records the derived class. Candidate or judge errors
do not fabricate a trust class for evidence that was never completed.
Incomplete or invalid Rubrist evidence remains explicitly incomplete; it is not
silently downgraded to self-reported evidence.

The report-level trust summary has `status: complete` only when at least one
item has completed evidence. When no item was evaluated it records
`status: unavailable`, the configured derivation path, `admissible: false`,
and `reason: no_completed_evidence`; it does not claim the intended Rubrist path
actually produced verified evidence.

## Report contract

`report.json` has `schemaVersion: 4`, `decision`, and no `verdict` field. It
retains:

- the declared scope;
- verified exact-input artifact digest, byte length, and item count;
- the declared digest separately from the observed digest, which must match;
- expected, observed, and evaluated coverage;
- producer-supplied dataset revision, exposure, and review provenance, each
  explicitly `not_provided` for current integrations and Rubrist receipts;
- configured trust policy, achieved trust class when evidence completed (or
  explicit unavailability), derivation path, and admissibility; and
- an exact deterministic decision statement naming the scope kind, id, and
  input digest.

The statement bytes are:

```text
Decision <decision> for <scope-kind> scope <JSON-encoded-scope-id> over exact JSONL input <digest>.
```

Complete but inadmissible evidence yields `inconclusive`. Candidate execution
failure remains a Dailies-owned `block`; evidence transport or protocol
failure remains `inconclusive`. The precedence is fixed in ADR-0005.

## Item outcomes

Each item's `outcome` is `pass`, `fail`, `abstain`, or `error`. Only a Rubrist
evaluator can abstain: its receipt states an abstention as a completed outcome
that neither passes nor fails. Dailies counts it as not passing (ADR-0009):

- the item has `pass: false` and completed, verified judge evidence;
- `totals.passed` excludes it, `totals.failed` includes it, and
  `totals.abstained` shows it separately;
- it counts as evaluated, so it does not lower evaluation coverage (the share
  of items with a completed result, unlike Rubrist's classified coverage); and
- it compares with a baseline label as a fail does: a regression against a
  `pass` baseline, a stable fail against a `fail` baseline.

The pass rate stays `passed / total`. A complete receipt yields an outcome for
every submitted item, and an incomplete one (a failure or a `not_attempted`
item) yields none: every submitted item becomes an `incomplete` judge error.

## Report inspection

`parseReportForInspection` accepts valid v4, v5, and v6 reports as distinct
return variants and never upgrades one into another. Historical v3 reports are
no longer readable (ADR-0008). Versions 1 to 3, unknown versions, and objects
without an explicit version are rejected with a version diagnostic.

The v4 execution schema never accepts a v3 report, and configuration without
an explicit v4 scope/trust contract is rejected before execution.

Schema validation proves report consistency, not report authenticity. The v4
report is not signed: a party that can rewrite the scope, trust policy, items,
and decision consistently can create a different internally valid report.
Consumers must protect the report artifact and separately authenticate any
provider evidence; a later signing contract must be versioned explicitly.
