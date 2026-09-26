# Vendored Rubrist evidence contracts

Rubrist ADR-0014 replaced the v1 evaluator identity with a definition digest
plus the exact execution binding. Dailies vendors Rubrist's v2 evidence
contracts byte-identically and verifies them independently, and every report
format consumes them (Dailies ADR-0008). No v1 verifier, contract, or fixture
remains.

- `rubrist/assessment-receipt/v2`: schema, specification, complete and
  incomplete fixtures, and conformance corpus, verified by
  `src/rubrist-receipt-v2.ts`. Reports v4 to v6 consume it through the
  `rubrist_receipt_v2` evidence kind. Each item has exactly one outcome
  (`pass`, `fail`, or `abstain`), failure, or `not_attempted` result; an
  abstention leaves a receipt complete, and Dailies counts it as not passing
  (ADR-0009).
- `rubrist/evaluator-suite-manifest/v2`: schema, specification, fixture, and
  corpus, verified by `src/suite-manifest-v2.ts`. The manifest binds ordered
  criterion definitions to exact evaluator versions while each criterion
  produces its own receipt. Dailies pins and verifies the manifest before
  candidate or provider execution, then supplies the customer-owned release
  roles and thresholds that the producer contract deliberately excludes.
- `rubrist/binary-calibration/v2`: schema, specification, complete, repeated,
  incomplete, and typed-question fixtures, the 114-case corpus, and the
  independent Wilson-score reference, verified by
  `src/binary-calibration-v2.ts`. Report v6 consumes it through the
  `rubrist_binary_calibration_v2` evidence kind. The verifier checks exact
  canonical bytes, artifact and requested-binding digests, aggregate
  conservation, metric and binary64 interval recomputation, provider grouping,
  lifecycle state, and the complete expected-identity tuple without importing
  Rubrist runtime code.

`src/rubrist-v2.ts` holds what the three share: the evaluator identity and
execution binding schema, `skillDigest` v2, and the raw-document guards, and
`src/rubrist-canonical.ts` holds Rubrist's canonical JSON. v2 evidence carries
the definition digest, never rubric text.

The private `rubrist/binary-calibration-private-ledger/v2` schema and fixture
are intentionally not vendored and are inaccessible to Dailies. The public
artifact exposes only its opaque commitment. Dailies must not attempt to
dereference that commitment or treat it as per-observation evidence.

## Compatibility policy

- Rubrist owns the canonical evidence contracts. Dailies vendors and
  independently verifies pinned copies rather than importing Rubrist runtime
  types. See Dailies' [decision index](../docs/decisions/README.md) and
  Rubrist ADR-0001.
- Every contract is closed. Every vendored file is pinned by digest, an unknown
  field is refused, and an additive field is breaking because it could change
  signed evidence without being understood by the release layer.
- Dailies owns release policy. Receipt fixtures must never contain thresholds,
  promote/block decisions, rollout configuration, or overrides.
- Calibration and uncertainty do not extend the receipt. They use the
  separate, closed `rubrist/binary-calibration/v2` artifact.
- The suite manifest is independently closed and content addressed. Dailies
  accepts only exact canonical bytes with the configured manifest identity and
  digest. It never selects an unpinned latest suite.
- Criterion identity is bound to receipt evidence through manifest
  `projectId`, `skillId`, `skillVersionId`, and `skillDigest`, which the
  receipt recomputes from its evaluator identity.
- Before launch, Rubrist's Batch 8G restarts every versioned identifier at v1,
  and these contracts take their v1 names (ADR-0008 decision 4).

The contracts are vendored rather than imported as a runtime dependency so
Rubrist and Dailies retain independent release cadences. Producer and consumer
tests pin identical schema and fixture file digests.

The config-v6, policy-v2, report-v6, runner, and CLI path consumes explicitly
configured local calibration artifact bytes, verifies freshness and runtime
admissibility, and applies customer release policy. It performs no network
latest-artifact or current-revocation lookup and has no private-ledger access.
