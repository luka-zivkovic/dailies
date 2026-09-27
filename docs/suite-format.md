# Dailies suite format

Status: **accepted launch contract** (ADR-0010)

The suite format releases a candidate against a pinned, policy-free Rubrist
evaluator-suite manifest under a customer release policy. Each criterion can
also require binary-calibration evidence. The configuration is
`dailies/suite-config/v1`, the report is `dailies/suite-report/v1`, and the
policy is `dailies/release-policy/v1`. A single-judge release uses the
[single format](single-format.md) instead; a single report is never read as
suite evidence.

## Evidence boundary

Dailies reads one exact canonical `rubrist/evaluator-suite-manifest/v1`
artifact (ADR-0008). Configuration pins both its `manifestId` and
`manifestDigest`; there is no `latest` selection. The first runtime transport
is an exact local file because Rubrist has not yet accepted a public
manifest-fetch route.

The manifest supplies ordered criterion definitions and exact evaluator
bindings, never release roles or thresholds. Dailies submits one
`release_evidence` batch for every member and verifies a separate assessment
receipt. Each receipt must match manifest `projectId`, `skillId`,
`skillVersionId`, and `skillDigest`, which the receipt recomputes from its
evaluator identity, in addition to the item, content, dataset, ordering,
counter, and evidence-digest checks.

Each criterion item's `assessedLabel` is `pass`, `fail`, `abstain`, or `null`
when the criterion's evidence is not complete. An abstention counts as not
passing (ADR-0009): the criterion's `passed` excludes it, `failed` includes it,
`abstained` shows it separately, the pass rate stays `passed / total`, and it
compares with a baseline label as a fail does, so it is a regression against a
`pass` baseline.

Binary-calibration evidence (`rubrist/binary-calibration/v1`, recorded as
`rubrist_binary_calibration_v1`) is separately scoped and policy-free. The
suite format does not change the assessment receipt or the evaluator-suite
manifest.

Execution currently requires `trialPlan: null`. The manifest parser preserves
the closed independent-repetitions shape, but the suite refuses to execute it
until a customer policy names how repeated evidence is reduced.

## Configuration

A suite configuration has `"contract": "dailies/suite-config/v1"` and
`"schemaVersion": 1`. It keeps the single format's exact-byte input
declaration, scope, candidate, trust policy, timeouts, concurrency, and output
directory, and binds:

- a pinned suite manifest and Rubrist provider;
- a strict release policy;
- criterion-version-specific `baseline_labels` in JSONL inputs; and
- optionally, `calibrationEvidence`: one ordered calibration binding per
  policy criterion.

Each calibration binding is explicit absence (`"source": null`) or a local
file with an expected byte digest and full expected producer identity. A
configuration that leaves out `calibrationEvidence` binds a null source for
every criterion; a list that is present covers every policy criterion in
policy order. Paths resolve relative to the config file but are redacted from
the report. The runner reads each configured file once, sequentially in
manifest order, with no retry, network fallback, latest lookup, or
current-status request. It has no private-ledger interface.

## Release policy

Every manifest member has exactly one policy entry in manifest order. The
entry separates whether evidence is required from what a completed result
does, and states its calibration requirement, which may be `null`:

```json
{
  "criterionVersionId": "criterionv_safety_2",
  "evidenceRequirement": "mandatory",
  "consequence": "blocking",
  "rule": {
    "kind": "binary_threshold/v1",
    "minPassRate": 1,
    "maxRegressions": 0
  },
  "calibrationRequirement": null
}
```

The policy accepts exactly four evidence/consequence roles:

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

A `dailies/binary-calibration-requirement/v1` requirement can bind
sealed/governed truth, positive class, representative population, freshness,
provider identity strength, truth support, classified coverage, trial count,
exact point estimates, and Wilson lower bounds. The `all_trials_meet/v1` rule
evaluates every trial independently. Counts and metrics are never pooled
across trials. Undefined metrics, weak denominators, and the worst closed
failure reason remain explicit. A criterion whose requirement is set but
whose source is null is not release-admissible (`source_not_configured`);
that is a result of the run, not a configuration error. A criterion with no
requirement is `not_required` and admissible.

## Preflight and execution

Config, policy, candidate input, suite manifest, and every calibration source
are preflighted before candidate or provider calls. A required calibration
integrity failure produces `candidateAssessment.status = "not_started"` and an
`inconclusive` report. Otherwise Dailies runs the candidate assessment
exactly once. Calibration threshold insufficiency, staleness, and explicitly
unconfigured evidence do not stop the candidate assessment; Dailies must still
be able to retain an unrelated complete admissible blocking result.

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

## Candidate assessment

The candidate assessment is the part of the suite report that judges the
candidate's outputs against the manifest. It has no identifier of its own:
the suite report that embeds it versions it. It records the suite policy with
calibration requirements left out, and its decision statement names a digest
of that projection. It retains:

- exact scope and input identity;
- the full verified suite manifest;
- the policy projection and its derived canonical digest;
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

## Calibration evidence

`releaseScope` is the candidate input scope. Every criterion has a separate
`calibrationTruthScope` derived from the accepted sealed-validation artifact.
Calibration identity never fills the release scope's `producerProvenance`;
the receipt still reports those fields as `not_provided`.

Collection states are closed:

- `verified`: exact canonical bytes, configured byte digest, full expected
  identity, manifest binding, and artifact semantics all verify;
- `incomplete`: the source was explicitly unconfigured or the verified
  artifact itself is incomplete; and
- `integrity_failure`: a configured file was not found or unreadable, or its
  bytes, canonical form, digest, identity, manifest binding, or semantics fail.

Accepted evidence retains the aggregate-only public artifact. Rejected
evidence retains expected/observed digests and a closed reason, never raw
rejected bytes or a local path. The private calibration ledger is neither an
input nor an output.

## Decision precedence

Dailies applies these rows in order (ADR-0005):

1. Required operational or protocol-integrity failure is `inconclusive`.
2. Candidate execution failure is `block` when no higher integrity failure
   exists.
3. A complete admissible blocking failure is `block`, even if another
   mandatory criterion has a digest-valid incomplete receipt.
4. Missing, incomplete, unverifiable, or inadmissible mandatory evidence is
   `inconclusive`.
5. With required evidence complete, a failed explicit compensation formula is
   `block`; otherwise policy is satisfied and the decision is `promote`.

A blocking assessment participates only when its own calibration requirement
is satisfied. Calibration status and completeness are evidence state, not a
release outcome. Advisory results never rescue another condition. Receipt
transport or binding failure is distinct from a structurally and digest-valid
incomplete receipt.

## Canonical report and verification

The report has `"contract": "dailies/suite-report/v1"` and
`"schemaVersion": 1`. The CLI writes exact canonical JSON bytes for
`report.json`. The report includes digests for the policy, the candidate
assessment, and the ordered calibration evidence set. Its strict parser
re-verifies the embedded candidate assessment, manifest, every receipt,
policy, accepted calibration artifacts, expected identities, scope
projections, freshness, per-trial checks, effective admissibility,
compensation, decision, precedence, and decision statement. Criterion output
order always follows the manifest; item order always follows the exact JSONL
artifact. Unknown fields, noncanonical bytes, a BOM, or any derived-field
mismatch are rejected rather than normalized.

CLI exit codes are `0` for `promote`, `1` for `block`, and `2` for
`inconclusive` or a run/configuration error.

## Internal scalability probe

`npm run --silent benchmark:batch3` runs a deterministic, in-memory probe of
the candidate assessment at 1, 10, and 50 criteria over 100 synthetic
candidate items. It verifies and validates each fixture before timing; every
timed sample then performs manifest verification plus policy/report
derivation and full candidate-assessment validation. The command writes
machine-readable JSON to stdout and a concise p50/p95 summary to stderr. It
performs no provider or network calls and has no timing pass/fail budget:
invariant failures fail the command, while timing results are observations
only. This is an internal scalability probe, not a competitor performance
claim.
