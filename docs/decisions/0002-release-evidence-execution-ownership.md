# ADR-0002: Release-evidence execution ownership

Status: **Accepted**

Date: 2026-08-22

## Context

Dailies coordinates a release run while Coeval executes governed evaluator
work. Without an explicit boundary, both products can retry the same
non-idempotent operation or each can assume the other records failure detail.

## Decision

Dailies owns the lifecycle of the release run:

- candidate and baseline execution;
- the stable mapping from release item to evidence-provider item;
- the overall deadline and release-run cancellation state;
- whether to request, poll, or stop waiting for evidence;
- evidence sufficiency; and
- final policy evaluation and release decision.

An evidence provider such as Coeval owns its internal assessment lifecycle:

- idempotency and retries inside an accepted assessment;
- evaluator-provider calls;
- per-item terminal state;
- assessment completeness; and
- the provider's immutable evidence artifact.

Dailies submits a non-idempotent assessment request once unless the provider
offers and Dailies supplies an explicit idempotency key. Safe reads may retry
within the release-run deadline. Dailies records its actual operations; it
does not fabricate provider-internal attempts.

Timeout is scoped: Dailies may stop waiting while the provider assessment
continues. That yields an inconclusive Dailies run unless a later resume flow
retrieves and verifies the same assessment identity.

## Consequences

- Retry behavior can be audited without double counting or duplicate runs.
- Coeval remains responsible for judge execution while Dailies remains
  responsible for the release consequence.
- A future cancellation or resume protocol requires explicit provider support
  rather than implicit assumptions.
