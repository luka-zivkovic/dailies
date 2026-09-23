# ADR-0001: Evidence trust classes

Status: **Accepted**

Date: 2026-08-22

## Context

Dailies currently accepts exact-match results, verified Rubrist receipts, and a
minimal HTTP judge response. These sources do not have equivalent provenance
or reproducibility. Aggregating them without retaining that distinction can
make self-reported evidence look governed.

## Decision

Every judge result used by a release report has one trust class:

- **verified:** a versioned evidence contract is independently verified,
  including identity, provenance, completeness, and digest semantics;
- **deterministic:** the result can be reproduced locally from identified
  inputs and an identified deterministic evaluator;
- **self-reported:** an external service asserted a result without a
  verifiable evidence envelope.

Trust class is report evidence, not a quality score. Dailies never silently
upgrades one class to another.

Customer policy declares which trust classes are admissible and whether a run
requires verified evidence. The safe default for an automated promotion
rejects self-reported evidence as insufficient: it cannot independently
support `promote`. During an explicit migration, customer policy may allow
self-reported evidence only through a visible override, and the report must
retain both the trust class and override. Self-reported evidence may supplement
admissible evidence but cannot be silently averaged into a stronger class.

An incomplete or invalid evidence contract is not `self-reported`; it is
incomplete evidence and yields `inconclusive`.

## Consequences

- The generic HTTP judge can remain an integration surface without pretending
  to provide Rubrist-grade provenance.
- Reports and policy schemas must eventually retain trust class through
  aggregation.
- Generalizing Rubrist's receipt into a universal signed protocol is not
  required for the first implementation.
