# AI contributor context

Before planning, auditing, or changing Dailies, read:

1. `PRODUCT.md` — authoritative target product scope;
2. `docs/glossary.md` — shared terminology;
3. `docs/decisions/README.md` and the relevant ADRs;
4. `docs/implementation-batches.md` — independently audited work sequencing;
   Batches 0, 1A, and 1B are complete; Batch 1B's precedence is fixed in
   ADR-0005;
5. `README.md` and `PLAN.md` — current implementation and local sequencing;
6. code and tests — current behavior.

For competitor or market claims, also read `docs/positioning.md` and refresh
its dated sources. It is context, never product authority.

## Authority and evidence labels

- Accepted ADRs and `PRODUCT.md` define intended direction.
- Proposed ADRs are unresolved. Do not implement behavior that depends on one
  without explicit approval.
- README, plans, CLI copy, comments, and code can describe **CURRENT** behavior
  but cannot establish **TARGET** product intent when they conflict with the
  charter.
- In audits and plans, label material claims as `TARGET`, `CURRENT`, or
  `ASSUMPTION`.

## Product boundary

Dailies coordinates release evaluation over declared evidence scopes,
preserves evidence trust and incompleteness per criterion, applies
customer-owned release policy, and emits `promote`, `block`, or
`inconclusive`. Its decision claim never exceeds those scopes. It does not
author rubrics, establish human truth, or govern evaluator quality. Rubrist owns
governed assessment evidence.
Casefile owns deterministic no-execution trust intake for capability artifacts.

A hosted control plane and staged rollout are demand-gated delivery options,
not permission to put Dailies on the serving inference path. Semantic
clustering is deferred.

## Working tree

The repository may contain uncommitted work from coordinated batches. Preserve
unrelated changes, inspect diffs before editing, and never treat an uncommitted
document as accepted merely because it exists.
