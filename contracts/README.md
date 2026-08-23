# Vendored Coeval evidence contracts

Dailies vendors Coeval's frozen assessment-receipt v1 JSON Schema, digest
specification, positive fixture, and conformance corpus. The runtime schema in
`src/coeval.ts` is intentionally strict, and the contract test verifies JSON
Schema/runtime-schema agreement plus the independent digest, ordering,
coverage, and candidate-content checks applied by Dailies. See
[`assessment-receipt-v1.md`](assessment-receipt-v1.md) for the pinned bytes
and mutation rules.

Dailies also vendors Coeval's policy-free
`coeval/evaluator-suite-manifest/v1` schema, specification, positive fixture,
and adversarial corpus. The manifest binds ordered criterion definitions to
exact evaluator versions while each criterion continues to produce its own
unchanged receipt-v1 artifact. Dailies pins and verifies the manifest before
candidate or provider execution, then supplies the customer-owned release
roles and thresholds that the producer contract deliberately excludes.

Dailies now also vendors the frozen public
`coeval/binary-calibration/v1` schema and normative specification, exact
complete/repeated/incomplete transport fixtures, the 96-case portable
conformance corpus, and the independent Wilson-score reference. The pure
consumer in `src/binary-calibration.ts` verifies exact canonical bytes,
artifact and requested-binding digests, aggregate conservation, metric and
binary64 interval recomputation, provider grouping, lifecycle state, and the
complete expected-identity tuple without importing Coeval runtime code.

The private `coeval/binary-calibration-private-ledger/v1` schema and fixture
are intentionally not vendored and are inaccessible to Dailies. The public
artifact exposes only its opaque commitment. Dailies must not attempt to
dereference that commitment or treat it as per-observation evidence.

## Compatibility policy

- Coeval owns the canonical assessment-receipt contract. Dailies vendors and
  independently verifies a pinned copy rather than importing Coeval runtime
  types. See Dailies' [decision index](../docs/decisions/README.md) and
  Coeval ADR-0001.
- Receipt v1 is closed. An additive field is breaking because unknown fields
  could change signed evidence without being understood by the release layer.
- Coeval receipt v1 must remain byte-compatible. A deliberate v2 requires new
  fixtures and coordinated support; v1 support is not silently widened.
- Calibration and uncertainty do not extend receipt v1. They use the separate,
  closed `coeval/binary-calibration/v1` artifact; receipt v1 and suite manifest
  v1 remain independently frozen.
- Dailies owns release policy. Receipt fixtures must never contain thresholds,
  promote/block decisions, rollout configuration, or overrides.
- Suite manifest v1 is independently closed and content addressed. Dailies
  accepts only exact canonical bytes with the configured manifest identity and
  digest. It never selects an unpinned latest suite.
- Criterion identity is bound to receipt evidence through manifest
  `projectId`, `skillId`, `skillVersionId`, and `skillDigest`; criterion fields
  do not alter the frozen receipt-v1 digest basis.

The contract is vendored rather than imported as a runtime dependency so
Coeval and Dailies retain independent release cadences. Producer and consumer
tests pin identical schema and fixture file digests.

Passing the vendored corpus closes Dailies' public contract-conformance
checkpoint. The additive config-v6, policy-v2, report-v6, runner, and CLI path
now consumes explicitly configured local artifact bytes, verifies freshness
and runtime admissibility, and applies customer release policy. It performs no
network latest-artifact or current-revocation lookup and has no private-ledger
access. The frozen local cross-product exit gate is closed; live status and
revocation reads remain outside this slice.
