# Dailies report and configuration v4

Status: **accepted Batch 1B contract**

Version 4 makes evidence scope and trust part of the release decision. It does
not change Coeval receipt v1 and does not introduce multi-criterion policy.
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
| Fully verified Coeval receipt path | `verified` | `coeval_receipt_v1` |
| Generic HTTP judge | `self_reported` | `http_judge_v1` |

Completed item evidence records the derived class. Candidate or judge errors
do not fabricate a trust class for evidence that was never completed.
Incomplete or invalid Coeval evidence remains explicitly incomplete; it is not
silently downgraded to self-reported evidence.

The report-level trust summary has `status: complete` only when at least one
item has completed evidence. When no item was evaluated it records
`status: unavailable`, the configured derivation path, `admissible: false`,
and `reason: no_completed_evidence`; it does not claim the intended Coeval path
actually produced verified evidence.

## Report contract

`report.json` has `schemaVersion: 4`, `decision`, and no `verdict` field. It
retains:

- the declared scope;
- verified exact-input artifact digest, byte length, and item count;
- the declared digest separately from the observed digest, which must match;
- expected, observed, and evaluated coverage;
- producer-supplied dataset revision, exposure, and review provenance, each
  explicitly `not_provided` for current integrations and Coeval receipt v1;
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

## Historical reports

`parseReportForInspection` accepts valid v5, v4, and historical v3 reports as
distinct return variants. V3 is read-only and is never upgraded or used for
release-policy execution. V4 remains its own single-criterion contract rather
than being upgraded into v5. Versions 1, 2, unknown versions, and objects
without an explicit version are rejected with a version diagnostic.

`fixtures/report-v3-exact.json`, `fixtures/report-v3-http.json`, and
`fixtures/report-v3-coeval-incomplete.json` were captured from the pre-v4
`a6d494f` runtime. Compatibility tests validate and return those historical
objects byte-for-byte so later live-schema changes cannot silently redefine v3.

The v4 execution schema never accepts a v3 report, and configuration without
an explicit v4 scope/trust contract is rejected before execution.

Schema validation proves report consistency, not report authenticity. The v4
report is not signed: a party that can rewrite the scope, trust policy, items,
and decision consistently can create a different internally valid report.
Consumers must protect the report artifact and separately authenticate any
provider evidence; a later signing contract must be versioned explicitly.
