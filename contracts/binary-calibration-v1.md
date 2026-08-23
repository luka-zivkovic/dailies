# Binary calibration artifact v1 specification

This document is normative for `coeval/binary-calibration/v1` alongside
`binary-calibration-v1.schema.json`. The artifact is immutable, aggregate-only,
single-criterion evidence from one exact binary evaluator version measured
against one exact governed-blind sealed-validation revision. It is not an
assessment receipt, a provider transcript, or a release decision, and it does
not change `coeval/assessment-receipt/v1` or
`coeval/evaluator-suite-manifest/v1`.

## Closed public boundary

Every object is closed. Unknown fields, policy fields, threshold fields,
per-item attempts, dataset item identities, labels, payloads, rationales,
provider request/response IDs, and per-observation commitments are invalid.
The artifact publishes aggregate counts sufficient to recompute every metric.
Aggregate-only is not anonymous: a class with very small support can disclose
its aggregate outcome. v1 applies no differential privacy or suppression.
Consumers must expose minimum-support policy and operators must govern sealed
population size accordingly; no public item linkage is added to solve this.

The artifact includes one holistic commitment to the separately named private
`coeval/binary-calibration-private-ledger/v1`. That ledger contains the ordered
logical attempt evidence needed by the producer to reconstruct the aggregates.
It remains inside the protected sealed execution boundary and has no read API.
The commitment is SHA-256 over its exact canonical bytes. The public contract
does not make that digest dereferenceable and does not expose subordinate
observation commitments. A future ledger read or export is a development
exposure under ADR-0007 and cannot be added as a backwards-compatible v1
feature.

The private ledger v1 commitment input is exact canonical JSON with this closed
shape: root `contract`, `schemaVersion`, `artifactId`, `calibrationRunId`,
`canonicalizationVersion`, `projectId`, `revisionDigest`, `requestedProvider`,
`itemCount`, `trialsPerItem`, and `records`; each record contains
`datasetRevisionItemDigest`, `trialIndex`, `truthLabel` (`pass` or `fail`),
`terminalEvaluatorOutcome` (`evaluator_pass`, `evaluator_fail`, `abstained`,
`errored`, or `unevaluated`), `attemptState` (`not_started`, `started`, or
`terminal`), nullable `errorCode`, a closed `providerObservation`
(`provider`, `observedModel`, `observedVersion`, `systemFingerprint`), exact
nonnegative safe-integer `physicalProviderCalls`, and a
secret 32-byte lowercase-hex `commitmentSalt`. Records sort first by
`trialIndex`, then lexicographically by `datasetRevisionItemDigest`; there is
exactly one record for every revision item and trial. `commitmentDigest` is
SHA-256 over those exact canonical UTF-8 ledger bytes. The salt makes guessing
a small sealed ledger from the public digest impractical. Ledger records and
salts never enter the public artifact or a read surface.

The ledger uses `coeval-canonical-json/v1`. `errorCode` is non-null exactly for
`errored`; `unevaluated` pairs with `not_started`; classified, abstained, and
known errored terminal outcomes pair with `terminal`; and an
`outcome_unknown` record may remain `started` because physical completion
could not be established. Every private provider observation names the exact
globally requested provider; its observed model/version/fingerprint fields may
be null for `requested_only` evidence, but the logical record is never omitted.

The ledger root contract is exactly
`coeval/binary-calibration-private-ledger/v1` with schema version `1`.
Item/commitment digests use the public lowercase SHA-256 form, salts match
`^[a-f0-9]{64}$`, trial indexes are zero through nine, provider is a non-empty
Unicode-scalar string capped at 4,096 code points, and observed provider fields
are nullable strings under the same cap. Error
codes use the public closed error-code enum; an errored `outcome_unknown`
record has exactly that code. All objects are closed, all counts/indexes are
safe integers, and the ledger has exactly `itemCount * trialsPerItem` records.
Per-record physical call counts sum to each public trial's `providerCalls`.
An `unevaluated`/`not_started` record has zero calls and no observed
model/version/fingerprint. Classified and abstained terminal outcomes have at
least one call. `outcome_unknown`/`started` has at least one call. Any non-null
observed identity field requires at least one call; other typed errors may have
zero or more calls.
The strict structural schema is
`binary-calibration-private-ledger-v1.schema.json`; it is producer-internal and
does not authorize a ledger API or export.

The public artifact is complete evidence about its declared aggregate
measurement, not proof that the private payload was safe or that an evaluator
should be used for a release.

## Exact identity

The artifact binds:

- artifact, calibration-run, project, and correction-lineage identity;
- exact criterion ID, criterion-version ID, and criterion digest;
- exact skill and skill-version IDs, frozen `skillDigest`, and output-contract
  digest;
- requested provider/model/version and sampling configuration as canonical
  decimal strings plus `requestedBindingDigest`; no inherited JSON float enters
  the calibration artifact;
- an optional exact suite-manifest/member binding;
- dataset revision ID, `revisionDigest`, `contentDigest`, item count,
  `sealed_validation` role, `sealed_intake` source, and `governed_blind`
  provenance, with semantic-leakage detection explicitly `unsupported`;
- originating governed batch, instruction, population, and draw identities and
  digests, including selection method/provenance, nullable
  `representativeOfPopulationId`, and closed sorted reasons when population
  representativeness is not eligible;
- distinct authorization and completion exposure snapshots and events;
- sealed execution-definition and provider data-handling policy identity;
- positive class, metric definition, interval method, and trial plan; and
- exact canonicalization and evidence digests.

`revisionDigest` already binds the role and the multiset of frozen item
digests in lexicographic digest order; it is not an item presentation-order
claim. v1 does not invent a redundant `truthSetDigest`.

`requestedModelBinding.modelVersion` records what Coeval requested. It is not
silently treated as observed immutable provider identity. Observed identity is
reported separately in each trial's provider groups.

`requestedBindingDigest` is SHA-256 over canonical JSON of exactly:

```json
{
  "provider": "...",
  "modelId": "...",
  "modelVersion": "...",
  "temperatureDecimal": "0",
  "topPDecimal": null,
  "endpointKind": "managed",
  "baseUrlDigest": null
}
```

Decimal strings are canonical nonnegative decimals: no sign, exponent,
leading zero, trailing fractional zero, or decimal point on an integer.
Temperature is in `[0,2]`; top-p is null or in `[0,1]`. A custom endpoint has
one `baseUrlDigest`; a managed endpoint has none.

`truth.selectionMethod` preserves the governed Batch 4 source value exactly:
`simple_random`, `systematic`, `stratified_random`, `convenience`,
`uncertainty`, `failure_hunting`, or `manual`. When
`representativeOfPopulationId` is non-null,
`representativeIneligibleReasons` is empty. Otherwise it is a sorted, unique,
non-empty subset of the Batch 4 projection reasons (excluding `eligible`):
`selection_method_not_eligible`, `population_frame_incomplete`,
`collection_provenance_unverified`, `draw_not_server_executed`,
`draw_not_reproducible`, `fixed_budget_mismatch`, `strata_incomplete`,
`review_coverage_incomplete`, `deferred_assignments`,
`cannot_determine_present`, and `unresolved_items`. The artifact does not
collapse directed selection methods or manufacture a redundant selection
digest; the governed batch, population, and draw digests remain the source
bindings.

## Canonical JSON and time

`canonicalizationVersion` is exactly `coeval-canonical-json/v1`, the same
algorithm used by assessment receipt v1 and evaluator suite manifest v1:

1. object keys sort lexicographically by ECMAScript UTF-16 code units at every
   depth;
2. arrays retain declared order;
3. strings and supported primitives use `JSON.stringify` representation;
4. object properties whose value is `undefined` are omitted; and
5. unsupported and non-finite values fail rather than being coerced.

Calibration tightens the admissible input domain. Every digest-covered number
is a nonnegative safe integer, exact fraction component, or lowercase 16-hex
binary64 bit string. Negative zero is invalid. Every string and object key must
contain Unicode scalar values; unpaired UTF-16 surrogates are invalid. NFC and
NFD strings remain distinct. UTF-8 BOM-prefixed bytes are invalid.
Public free-text/identity strings are capped at 4,096 Unicode code points,
canonical decimal strings at 32, arrays at their closed domain maximum (never
above 5,000 in the public artifact), objects at 100 properties, JSON depth at
32, and artifact input at 16 MiB before decoding.

All timestamps use exact RFC3339 UTC milliseconds:
`YYYY-MM-DDTHH:mm:ss.SSSZ`. Offsets, missing or extra fractional digits,
rollover dates, and non-calendar instants are invalid.
`authorization.recordedAt` is the protected authorization event,
`startedAt` begins provider execution, `completedAt` is the terminal logical
attempt-accounting time, `completion.recordedAt` is the post-execution exposure
recheck, and `createdAt` is artifact mint time. They must be ordered:

```text
authorization.recordedAt <= startedAt <= completedAt
                         <= completion.recordedAt <= createdAt
```

Exact canonical artifact bytes are UTF-8 bytes of the complete artifact,
including `evidenceDigest`. A reader rejects invalid UTF-8, a BOM, invalid
JSON, valid noncanonical JSON, negative zero, and invalid Unicode scalar text.

## Digests

All digests are lowercase SHA-256 with the `sha256:` prefix.

`evidenceDigest` is SHA-256 over canonical JSON of the complete artifact with
only `evidenceDigest` removed. Storage and transport may additionally report
an `artifactDigest` over the exact canonical bytes, including
`evidenceDigest`; that byte digest is not embedded recursively in the JSON.

The verifier recomputes `requestedBindingDigest`, `evidenceDigest`, every
metric, every interval, and every conservation identity. Matching digests do
not replace expected-identity comparison: consumers compare the exact
criterion, evaluator, truth revision, authorization exposure, and optional
suite identity required by their scope.

## Trials and outcome accounting

`trialPlan` is either:

- `{ "kind": "single", "trialsPerItem": 1 }`; or
- `{ "kind": "independent_repetitions", "trialsPerItem": N }`, where `N`
  is 2 through 10.

Trials are ordered contiguously from zero. Each independent repetition is a
fresh logical provider assessment for every frozen item. Provider transport
retries do not become trials. Trial labels are never averaged or voted.
The ordered vector of trial aggregates and metrics is the v1 repeated-trial
distribution; v1 intentionally adds no pooled metric or unqualified mean.

Each trial partitions every planned item into exactly one logical outcome:

- `classified`: evaluator produced binary pass/fail;
- `abstained`: evaluator explicitly abstained;
- `errored`: execution ended without a usable classification; or
- `unevaluated`: no logical assessment was attempted.

The same partition is supplied separately for human-truth pass and fail. All
totals must conserve the frozen support. Error codes are sorted, unique, and
sum exactly to `errored`. `outcome_unknown` means a call may have happened but
its result cannot be recovered after a crash boundary. It is a permanent
errored outcome for that logical attempt and must not be retried within the
same calibration run, because doing so would silently substitute a different
nondeterministic observation.

`providerCalls` separately counts physical provider calls, including transport
retries. Provider identity groups are observation-level sorted, unique
aggregate buckets. Their `observationCount` values sum exactly to `planned`,
including unevaluated, errored, and `outcome_unknown` observations. Every group
uses the globally pinned `evaluator.requestedModelBinding.provider`; v1 has no
provider-null or `unavailable` identity. An observation with no returned model,
version, or fingerprint remains `requested_only`, including pre-call failures
and unevaluated attempts, because the requested provider identity is still
known.
At the public boundary, `providerCalls` is at least
`classified + abstained + outcome_unknown`; every usable terminal output and
every unknown-started attempt requires one physical call, while retries and
other typed errors may increase the count.
Transport retries therefore do not weaken the identity of a successfully
observed logical outcome, and physical call counts do not distort the
observation provenance distribution. Actual observations are never dropped
from a weaker group to make provenance appear stronger. Identity strength is
derived from the strongest observed field in this order:

1. `observed_version`;
2. `observed_fingerprint`;
3. `observed_model`;
4. `requested_only`.

Observed version and fingerprint strength additionally require an observed
model. A group may retain both version and fingerprint evidence; the listed
order determines its declared strength.

The provider-group uniqueness and order key is canonical JSON of exactly
`{provider,observedModel,observedVersion,systemFingerprint,identityStrength}`;
`observationCount` is excluded. Group keys, error codes, incomplete reasons,
eligibility reasons, representative reasons, object keys, and every other
contract string ordering use ECMAScript lexicographic UTF-16 code-unit order.

The public groups contain no request IDs, response IDs, item identity, or
observation commitments.

`observed_version` is reserved for a version identifier returned by the
provider and is not currently producible by Coeval's provider adapters.
Requested `modelVersion` is only requested identity and never upgrades a group
above `requested_only`; current Batch 5B implementations should expect
`observed_model`, `observed_fingerprint`, or `requested_only` until an adapter
captures an actual provider-returned version.

A trial is `complete` when every planned item has a terminal valid evaluator
outcome (`classified + abstained = planned`) and `errored = unevaluated = 0`.
An explicit abstention is valid terminal evidence, so it does not make the
trial incomplete; it lowers classified coverage and does not enter the
confusion matrix. The artifact is complete only when every trial is complete,
the completion exposure remains protected, and completion eligibility is
`eligible` with no reasons. Otherwise `status` is `incomplete` and the sorted,
closed `incompleteReasons` identifies trial, exposed-completion, and/or
ineligible-completion causes. Complete does not mean accurate, trusted, or
acceptable. An incomplete artifact remains valid immutable evidence and must
never coerce missing outcomes into pass or fail.

## Semantic matrix and error directions

The public confusion matrix uses invariant semantic cells:

- `truthPassEvaluatorPass`;
- `truthPassEvaluatorFail`;
- `truthFailEvaluatorPass`; and
- `truthFailEvaluatorFail`.

This avoids changing the meaning of the matrix when `positiveClass` changes.
The error directions are always:

- false pass (`evaluator_pass_when_truth_fail`) =
  `truthFailEvaluatorPass`; and
- false fail (`evaluator_fail_when_truth_pass`) =
  `truthPassEvaluatorFail`.

When positive class is `pass`, TP/FP/FN/TN are respectively pass/pass,
fail/pass, pass/fail, and fail/fail. When positive class is `fail`, TP/FP/FN/TN
are respectively fail/fail, pass/fail, fail/pass, and pass/pass.

## Exact metrics

Metric values are exact unreduced numerator/denominator pairs. Numerators and
denominators are safe integers and consumers compare fractions by integer
cross-multiplication, not rounded display decimals.

For each trial:

- accuracy = `(truthPassEvaluatorPass + truthFailEvaluatorFail) / classified`;
- truth-pass recall = `truthPassEvaluatorPass / classified truth-pass`;
- truth-fail recall = `truthFailEvaluatorFail / classified truth-fail`;
- positive-class precision = `TP / (TP + FP)`;
- positive-class recall = `TP / (TP + FN)`; and
- positive-class F1 = `2TP / (2TP + FP + FN)`.

`truthPassRecall` and `truthFailRecall` are invariant. The positive-class
precision, recall, and F1 fields change mapping with `positiveClass`.
Specificity/TNR is the invariant recall of the negative truth class.

Classified coverage is separately reported for all planned items, truth-pass
items, and truth-fail items. A metric with a zero denominator is explicitly
undefined. F1 is also undefined when the frozen revision has no positive-class
truth support, even if false positives make its algebraic denominator nonzero.
No metric can substitute zero merely because it is undefined.

## Wilson score interval v1

v1 attaches a 95% Wilson interval to accuracy, both invariant class recalls,
positive-class precision and recall, and overall/truth-pass/truth-fail
classified coverage. Confusion counts, support, error counts, and F1 have no
interval. In particular, v1 deliberately includes no F1 bootstrap or other F1
confidence interval.

Each Wilson interval conditions only on the frozen revision's observed binary
counts. It ignores selection strata, design weights, clustering, finite
population correction, target-population prevalence, and selection
uncertainty. It is not a population or design-weighted interval. Population
estimation is a separate future contract even when
`representativeOfPopulationId` is present.

The confidence level is exactly 9,500 basis points. The z constant is pinned by
big-endian IEEE-754 binary64 bits `3fff5c0331eeff84`; it is not recomputed from
an inverse CDF. Given integer `x` and positive integer `n`, implementations
must perform these binary64 operations in this exact order:

```text
zSquared           = z * z
adjustedDenominator = n + zSquared
centerNumerator    = x + (zSquared / 2)
remaining          = n - x
product            = x * remaining
scaledProduct      = product / n
correction         = zSquared / 4
radicand           = scaledProduct + correction
root               = sqrt(radicand)
marginNumerator    = z * root
lowerRaw           = (centerNumerator - marginNumerator) / adjustedDenominator
upperRaw           = (centerNumerator + marginNumerator) / adjustedDenominator
lower              = x == 0 ? +0 : max(0, lowerRaw)
upper              = x == n ? 1 : min(1, upperRaw)
```

Bounds are encoded as exactly 16 lowercase hexadecimal digits containing the
big-endian binary64 bits, with no `0x`. Negative zero, sign-bit values,
NaN/infinity, and decoded values outside `[0,1]` are invalid. The verifier
recomputes the exact bits; algebraically equivalent formulae are nonconforming
because they can differ by multiple ULPs. The conformance corpus pins golden
vectors. Binary64 `sqrt` portability beyond the tested V8 runtime is not
assumed; consumer implementations must pass those vectors.

`reference/binary-calibration-wilson-v1.py` is an independent CPython
binary64 implementation of the pinned operation sequence. Producer tests
cross-check its output against the TypeScript implementation and the golden
vectors; consumers may use it as a readable portability oracle.

No informative decimal interval is part of v1. Dailies policy thresholds must
be canonical decimal strings and comparisons with interval bounds must decode
binary64 to an exact integer/exponent rational before cross-multiplication.
Converting both values to a host float is not policy verification.

## Sealed execution requirements for the producer runtime

Batch 5A defines these requirements but implements no execution runtime.
Batch 5B must:

- authorize under a revision-scoped lock, verify protected governed-blind
  truth and exact criterion/evaluator binding, and append a final-validation
  exposure event before provider calls;
- retain a separate completion exposure snapshot instead of pretending the
  authorization state remained unchanged;
- record closed completion-eligibility reasons and refuse complete status when
  the completion snapshot is exposed or ineligible;
- permit at most one nonterminal run for an exact evaluator-version and sealed
  revision; identical idempotent requests replay and conflicting settings fail;
- write no sealed payload, attempt, raw response, or private-ledger content to
  ordinary cases, judge runs, verdicts, exports, caches, project-key APIs, or
  logs; and
- mint the aggregate artifact atomically only after every planned logical
  attempt has a terminal accounting category.

The external-provider implementation uses a revision-scoped execution lease,
not a database transaction held across network I/O. In one short locked
transaction it validates the authorization snapshot and reuse barrier,
reserves the unique nonterminal run/idempotency identity, records the exposure
event watermark, and marks the lease active. While active, every development
read/export/exposure path for that revision must acquire the same lock and fail
closed rather than reveal sealed content. Provider calls run outside the
transaction under the active lease. Terminalization reacquires the lock,
rechecks the full exposure event stream and reuse facts through a new
completion watermark, records closed eligibility reasons, writes the private
ledger commitment and exact public bytes atomically, and only then releases
the lease. Crash recovery follows the same terminal lock and permanently
accounts an indeterminate started attempt as `outcome_unknown`; it never
substitutes a retry in the same run.

The first completed final validation fixes a reuse barrier for that sealed
revision and stable criterion lineage. A second evaluator version may use the
same revision only if that exact version and all of its recorded development
activity predate the earliest prior final-validation completion. An evaluator
version created or developed after that completion is rejected. Unknown
creation/development ordering fails closed. Re-executing the same immutable
version does not retroactively disqualify its earlier assessment, but later
development exposure remains disqualifying for later versions.

## Correction and later revocation

Published bytes never mutate. A correction addresses evidence that was wrong
when minted: it creates a new artifact revision with a new `artifactId`, the
immediately preceding artifact ID, and a non-empty correction reason. Revision
one has no predecessor or correction reason. Corrections form one
nonbranching sequence and do not erase earlier bytes.

A later exposure, provenance discovery, provider disclosure, or policy change
is a revocation or changed admissibility fact, not a correction of the
historical artifact. It is appended outside artifact v1 and never changes its
bytes or status. A consumer retrieving an artifact must also check the
producer's separately authenticated current revocation state once Batch 5B
defines that read contract. A portable artifact alone cannot prove that no
later revocation exists.

## Dailies TARGET consumption contract

Dailies must vendor the schema, positive fixtures, and adversarial corpus and
must independently verify canonical bytes, all digests, aggregate conservation,
metric/interval recomputation, and expected criterion/evaluator/truth/exposure
identity.

Expected identity comparison is value-for-value, not digest-only. It includes
artifact/run/project; criterion ID/version/digest; skill ID/version/digests and
requested-binding digest; revision ID/digests/item count; governed batch,
instruction, population, draw, selection, and representativeness bindings;
both exposure snapshot/event identities plus completion state/eligibility;
provider data-handling policy/environment; positive class and trial plan; and
the nullable suite manifest ID/digest/member position as one exact tuple.

Calibration has its own calibration scope: exact criterion, evaluator, sealed
revision, exposure snapshots, population/draw provenance, and measurement
time. It does not upgrade the candidate execution scope in assessment receipt
v1. In particular, receipt-v1 candidate `producerProvenance` remains
`not_provided`.

Provider identity admissibility is policy. If any observed provider group is
below a customer's minimum strength, Dailies treats the entire criterion's
calibration evidence as inadmissible; it cannot discard weak observations and
recompute a favorable subset.

Missing, malformed, stale, swapped, revoked, insufficiently strong, or
otherwise unverifiable required calibration makes that required criterion
inconclusive. Integrity failures are scoped to the criterion whose calibration
is required; they do not globally poison unrelated criterion evidence.
Advisory or unrelated complete evidence cannot repair the affected required
criterion. Under Dailies' accepted precedence, a complete admissible blocking
failure still outranks unrelated incompleteness. Thresholds, minimum support,
freshness, provider strength, criterion roles, and release consequences remain
customer policy in Dailies and never enter this artifact.

This is normative TARGET behavior for the consumer. Coeval Batch 5A does not
claim that Dailies has vendored the bytes or that the cross-product exit gate
is closed.

## Portable conformance corpus

`fixtures/binary-calibration-v1.conformance.json` is a language-neutral test
program. `baseFixture` selects the default exact artifact;
`expectedIdentityByFixture` supplies the complete consumer expectation for
every selectable base; a case may select another `baseFixture` and apply
closed `expectedOverrides`. Consumers must prove that the portable expectation
equals the corresponding base fixture before running cases.

Mutations apply in listed order to a deep copy using RFC 6901 JSON pointers.
`add`, `replace`, `remove`, and `copy` use RFC 6902 behavior; `reverse` reverses
the addressed array; `recompute-evidence-digest` recomputes only the public
artifact evidence digest. A JSON literal `-0` must retain negative-zero
semantics in runtimes that distinguish it. Each case declares independent
structural and semantic outcomes plus a stable error substring for semantic
rejection. This corpus, not the TypeScript test harness, is the consumer
interoperability boundary.

## Compatibility

The complete/repeated/incomplete artifact fixtures are exact canonical
transport bytes with no trailing newline. The conformance corpus is
human-readable formatted JSON and is not itself an artifact transport vector.

Artifact v1 is closed. New metric fields, interval methods, provider
observation surfaces, private-ledger reads, nonsealed evidence classes,
categorical/scalar calibration, or policy fields require a new version and a
coordinated producer/consumer compatibility window. Assessment receipt v1 and
evaluator suite manifest v1 remain independently frozen contracts.
