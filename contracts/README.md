# Vendored Coeval receipt contract

Dailies vendors Coeval's frozen assessment-receipt v1 JSON Schema, digest
specification, positive fixture, and conformance corpus. The runtime schema in
`src/coeval.ts` is intentionally strict, and the contract test verifies JSON
Schema/runtime-schema agreement plus the independent digest, ordering,
coverage, and candidate-content checks applied by Dailies. See
[`assessment-receipt-v1.md`](assessment-receipt-v1.md) for the pinned bytes
and mutation rules.

## Compatibility policy

- Coeval owns the canonical assessment-receipt contract. Dailies vendors and
  independently verifies a pinned copy rather than importing Coeval runtime
  types. See Dailies' [decision index](../docs/decisions/README.md) and
  Coeval ADR-0001.
- Receipt v1 is closed. An additive field is breaking because unknown fields
  could change signed evidence without being understood by the release layer.
- Coeval receipt v1 must remain byte-compatible. A deliberate v2 requires new
  fixtures and coordinated support; v1 support is not silently widened.
- Calibration and uncertainty do not extend receipt v1. Their future transport
  is intentionally undecided; Dailies must not invent a one-off field or
  artifact before Coeval's receipt-evolution and calibration decisions are
  accepted.
- Dailies owns release policy. Receipt fixtures must never contain thresholds,
  promote/block decisions, rollout configuration, or overrides.

The contract is vendored rather than imported as a runtime dependency so
Coeval and Dailies retain independent release cadences. Producer and consumer
tests pin identical schema and fixture file digests.
