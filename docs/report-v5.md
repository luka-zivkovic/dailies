# Dailies criterion release configuration and report v5

Status: **implemented Batch 3 contract**

Version 5 adds customer-owned criterion release policy over a pinned,
policy-free Rubrist evaluator-suite manifest. It is additive: v4 configuration
continues to execute with v4 semantics and produces a v4 report. A v4 report
is never upgraded into v5.

## Evidence boundary

Dailies reads one exact canonical
`rubrist/evaluator-suite-manifest/v2` artifact (ADR-0008). Configuration pins both its
`manifestId` and `manifestDigest`; there is no `latest` selection. The first
runtime transport is an exact local file because Rubrist has not yet accepted a
public manifest-fetch route.

The manifest supplies ordered criterion definitions and exact evaluator
bindings, never release roles or thresholds. Dailies submits one
`release_evidence` batch for every member and verifies a separate assessment
receipt v2. Each receipt must match manifest `projectId`, `skillId`,
`skillVersionId`, and `skillDigest`, which the receipt recomputes from its
evaluator identity, in addition to the item, content, dataset, ordering,
counter, and evidence-digest checks.

Each criterion item's `assessedLabel` is `pass`, `fail`, `abstain`, or `null`
when the criterion's evidence is not complete. An abstention counts as not
passing (ADR-0009): the criterion's `passed` excludes it, `failed` includes it,
`abstained` shows it separately, the pass rate stays `passed / total`, and its
comparison is `unpaired`, so it is never a regression.

Execution currently requires `trialPlan: null`. The manifest parser preserves
the closed independent-repetitions shape, but v5 refuses to execute it until a
customer policy names how repeated evidence is reduced.

## Configuration

V5 retains the exact-byte input declaration, scope, candidate, trust policy,
timeouts, concurrency, and output directory from v4. It replaces one `judge`
and one global `thresholds` block with:

- a pinned suite manifest and Rubrist provider;
- a strict release policy v1; and
- criterion-version-specific `baseline_labels` in JSONL inputs.

Every manifest member has exactly one policy entry in manifest order. The
entry separates whether evidence is required from what a completed result
does:

```json
{
  "criterionVersionId": "criterionv_safety_2",
  "evidenceRequirement": "mandatory",
  "consequence": "blocking",
  "rule": {
    "kind": "binary_threshold/v1",
    "minPassRate": 1,
    "maxRegressions": 0
  }
}
```

Policy v1 accepts exactly four evidence/consequence roles:

- mandatory + blocking;
- mandatory + advisory;
- optional + advisory; and
- mandatory + compensatory.

Optional blocking and optional compensation are rejected rather than assigned
ambiguous failure semantics. There is no default role and no default average.

Compensation requires `dailies/weighted-pass-rate/v1`. Its unit is exactly
`pass_rate_ratio`, weights are positive integer basis points totaling 10,000,
and every term names one compensatory criterion in manifest order. All operand
evidence must be complete and admissible. A compensatory criterion declares
only `pass_rate_operand/v1` with unit `pass_rate_ratio`; it has no local
threshold. The formula's `minimumPassRate` is the sole trade-off threshold.
Dailies compares the weighted observed count fractions and the configured
minimum as exact integer rationals. The report retains both rational operands;
the floating pass-rate value is display-only.

## Decision precedence

Dailies applies these rows in order:

1. Required operational or protocol-integrity failure is `inconclusive`.
2. Candidate execution failure is `block` when no higher integrity failure
   exists.
3. A complete admissible blocking failure is `block`, even if another
   mandatory criterion has a digest-valid incomplete receipt.
4. Missing, incomplete, unverifiable, or inadmissible mandatory evidence is
   `inconclusive`.
5. With required evidence complete, a failed explicit compensation formula is
   `block`; otherwise policy is satisfied and the decision is `promote`.

Advisory results never rescue another condition. Receipt transport or binding
failure is distinct from a structurally and digest-valid incomplete receipt.

## Report invariants

The v5 report retains:

- exact scope and input identity;
- the full verified suite manifest;
- the full policy and its derived canonical digest;
- the configured deadline, polling interval, per-call timeout, concurrency,
  redacted provider/candidate identity, deterministic scheduling rule, and a
  digest over that execution-policy audit block;
- one candidate-execution ledger (candidate work is not repeated per
  criterion);
- one candidate dataset digest shared by every retained criterion receipt;
- criterion, evaluator, suite, scope, trust, completeness, receipt, metrics,
  comparisons, and policy outcome per member;
- explicit compensation inputs and results;
- the winning precedence row; and
- an exact decision statement naming policy, suite, scope, and input digest.

The runtime schema independently re-verifies the manifest and every receipt,
re-aggregates criterion items, re-applies policy, and reconstructs the final
decision and statement. Criterion output order always follows the manifest;
item order always follows the exact JSONL artifact.

Candidate execution completes before the shared evidence deadline starts.
Criterion work is assigned from manifest order through a bounded pool; output
is always restored to manifest order. The configured concurrency remains in
the audit block, so reports from concurrency 1 and N intentionally differ in
that declared execution policy even when their semantic evidence and decision
bytes are identical.

Provider identity hashes only its type, URL, and sorted lowercase header
names. HTTP candidate identity hashes only its type, URL, and sorted lowercase
header names; command identity hashes its type and command template. Header
values and HTTP body templates are neither retained nor hashed, so credentials
cannot influence or leak through identity digests.

Unknown `baseline_labels` keys are rejected both before execution and during
report validation. All accepted or rejected receipts must carry the report's
recomputed candidate dataset digest. If collection returns a receipt that
fails the suite-manifest binding, the report retains it as `rejectedReceipt`
with a reproducible typed rejection. An integrity failure with a fully
successful operation ledger is invalid without that artifact. When no request
was made, the evidence instead retains a typed `zeroRequestTermination` with
its phase and closed reason; free text alone is insufficient.
Operational retry and deadline terminations are typed attestations in the
ledger, not events independently reproducible from a static report.

V5 preserves the existing tri-state values and CLI exits: `promote`/0,
`block`/1, and `inconclusive`/2.

## Internal scalability probe

`npm run --silent benchmark:batch3` runs a deterministic, in-memory Batch 3
probe at 1, 10, and 50 criteria over 100 synthetic candidate items. It verifies
and validates each fixture before timing; every timed sample then performs
manifest verification plus policy/report derivation and full v5 report
validation. The command writes machine-readable JSON to stdout and a concise
p50/p95 summary to stderr. It performs no provider or network calls and has no
timing pass/fail budget: invariant failures fail the command, while timing
results are observations only. This is an internal scalability probe, not a
competitor performance claim.
