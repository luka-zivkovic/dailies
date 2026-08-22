# ADR-0004: Multi-criterion release policy

Status: **Accepted**

Date: 2026-08-22

## Context

AI quality has multiple dimensions, but Coeval deliberately emits separate
policy-free evidence for each criterion. Dailies needs to decide how those
measurements affect a release without hiding a catastrophic failure inside an
average or treating missing evidence as a low score.

## Decision

Dailies consumes criterion-level evidence and an optional pinned Coeval suite
manifest. Customer policy assigns each criterion one or more explicit release
roles:

- **mandatory:** complete, admissible evidence is required to decide;
- **blocking:** a declared failure blocks regardless of other criteria;
- **advisory:** reported but has no release consequence unless policy says
  otherwise; and
- **compensatory:** only when policy explicitly defines how evidence may trade
  off, including units and thresholds.

There is no default weighted average. A missing or unverifiable mandatory
criterion yields `inconclusive`. A completed blocking failure yields `block`.
An advisory success cannot rescue either condition. If policies for different
criteria or scopes conflict, the report preserves the individual outcomes and
applies only the declared combination rule.

When evidence contains repeated trials, policy declares whether it uses a
worst case, quantile, confidence bound, stability requirement, or another
versioned rule. Dailies does not silently collapse variance into an
unqualified mean.

## Consequences

- The same Coeval suite can support different customer policies.
- Criterion-level incompleteness remains visible through the final decision.
- Non-compensatory safety or correctness requirements cannot be averaged away.
- Report and policy schemas need explicit criterion, scope, trust, and
  combination identities.
