# Calibration-aware release report v6

Status: **CURRENT additive contract**

Report v6 records one Dailies release decision that combines the unchanged
suite assessment flow from report v5 with separately scoped, policy-free Rubrist
binary-calibration evidence. It does not change assessment receipt v1,
evaluator-suite manifest v1, or reports v3 through v5.

## Inputs and execution boundary

A schema-v6 run binds:

- one exact candidate JSONL artifact and declared release scope;
- one exact evaluator-suite manifest;
- customer release policy v2;
- one ordered calibration binding per manifest criterion; and
- the existing command/HTTP candidate and Rubrist receipt-v1 provider settings.

Each calibration binding is explicit absence or a local file with an expected
byte digest and full expected producer identity. Paths resolve relative to the
config file but are redacted from the report. The runner reads each configured
file once, sequentially in manifest order, with no retry, network fallback,
latest lookup, or current-status request. It has no private-ledger interface.

Config, policy, candidate input, suite manifest, and every calibration source
are preflighted before candidate or provider calls. A required calibration
integrity failure produces `candidateAssessment.status = "not_started"` and an
`inconclusive` report. Otherwise Dailies executes the already-preflighted v5
candidate/receipt snapshot exactly once and embeds that fully verified report.
Calibration threshold insufficiency, staleness, and explicitly unconfigured
evidence do not stop candidate assessment; Dailies must still be able to retain
an unrelated complete admissible blocking result.

## Evidence separation

`releaseScope` is the candidate input scope from report v5. Every criterion has
a separate `calibrationTruthScope` derived from the accepted sealed-validation
artifact. Calibration identity never fills the release scope's
`producerProvenance`; receipt v1 still reports those fields as `not_provided`.

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

## Policy and precedence

Policy v2 keeps all policy-v1 candidate rules and adds an optional closed
binary-calibration requirement per criterion. When one is configured, a
blocking assessment requires its own calibration requirement to be satisfied.
Requirements can bind sealed/governed truth, positive class, representative
population, freshness, provider identity strength, truth support, classified
coverage, trial count, exact point estimates, and Wilson lower bounds.

The `all_trials_meet/v1` rule evaluates every trial independently. Counts and
metrics are never pooled across trials. Undefined metrics, weak denominators,
and the worst closed failure reason remain explicit.

ADR-0005 precedence still applies. Required integrity is `inconclusive`; a
candidate execution failure blocks; a complete admissible blocking result can
outrank unrelated mandatory incompleteness; otherwise missing mandatory
evidence is `inconclusive`. A blocking assessment participates only when its
own calibration requirement is satisfied. Calibration status/completeness is
evidence state, not a release outcome.

## Canonical report and verification

The CLI writes exact canonical JSON bytes for `report.json`. Report v6 includes
digests for policy, candidate assessment, and the ordered calibration evidence
set. Its strict parser re-verifies the embedded v5 report, manifest, policy,
accepted calibration artifacts, expected identities, scope projections,
freshness, per-trial checks, effective admissibility, compensation, decision,
precedence, and decision statement. Unknown fields, noncanonical bytes, a BOM,
or any derived-field mismatch are rejected rather than normalized.

CLI exit codes remain `0` for `promote`, `1` for `block`, and `2` for
`inconclusive` or a run/configuration error.
