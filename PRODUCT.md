# Dailies product charter

Status: **active target-state charter**

Last reviewed: 2026-09-26

This document is the source of truth for what Dailies is becoming. The README,
PLAN, CLI copy, and code may describe current behavior, but they do not
override this charter. Accepted ADRs in `docs/decisions/` may refine it.
Proposed ADRs record an open decision and are not yet binding.

## User and job

Dailies serves the release owner responsible for deciding whether an AI change
is safe enough to advance.

The job is:

> Run or coordinate a baseline/candidate evaluation over declared evidence
> scopes, account honestly for missing and differently trusted evidence, apply
> customer-owned release policy, and produce an auditable `promote`, `block`,
> or `inconclusive` decision whose claim never exceeds those scopes.

## Product loop

```text
release candidate + declared evidence scopes + evidence providers
→ paired baseline/candidate execution
→ complete, typed, and trust-classified evidence per criterion
→ customer-owned policy
→ promote | block | inconclusive
```

The current CLI is the first delivery surface for this job. A hosted control
plane or rollout integration is a future, demand-gated delivery choice rather
than the definition of the product.

## Dailies owns

- Release-run configuration and stable input identity.
- Evidence-scope identity, sampling/collection provenance, and required scope
  coverage.
- Baseline/candidate execution or coordination.
- Retry, deadline, idempotency, and incomplete-evidence handling at the
  release-run boundary.
- Evidence trust classification and sufficiency checks.
- Customer-owned release thresholds, exceptions, and override records.
- Paired comparison semantics: regression, improvement, stable pass, stable
  fail, and unpaired evidence.
- Mapping policy-free criteria into mandatory, advisory, or blocking release
  rules without erasing criterion-level evidence.
- Auditable release reports and the final tri-state decision.

## Decisions Dailies makes

- Whether the available evidence is sufficient to decide.
- Whether a release satisfies the customer's declared policy on each declared
  evidence scope and, when policy requires several scopes, across that explicit
  combination.
- Whether the result is `promote`, `block`, or `inconclusive`.
- Eventually, if demand justifies it, whether to advance or roll back a staged
  rollout through an explicit deployment integration.

## Decisions Dailies does not make

- What a quality rubric should say.
- Which examples constitute human truth or how reviewers adjudicate them.
- Whether a governed evaluator is calibrated; Dailies verifies or consumes
  that evidence rather than manufacturing it.
- Whether an agent capability artifact is statically safe to install.
- Serving-path inference. Dailies is not a hosted proxy for customer prompts.

## Inputs and outputs

Inputs include a release candidate, declared evidence scopes and their cases,
optional baseline outputs and labels, evidence from Rubrist, reproducible
deterministic checks, external judge results, and customer release policy.

Outputs include item-level execution evidence, paired comparisons, evidence
scope and trust classifications, per-criterion policy evaluation, and an
auditable tri-state release decision. `Promote` means only that the candidate
satisfied the named policy on the named scopes; a regression corpus alone does
not establish representative production quality.

## Relationship to the other products

- **Rubrist** governs and executes evaluators and emits policy-free assessment
  evidence. Dailies verifies that evidence and owns the release consequence.
- **Casefile** emits deterministic trust evidence about capability artifacts.
  Dailies may eventually consume such evidence as one policy input, but it
  does not absorb Casefile's scanner or claim Casefile findings as behavioral
  evaluation.

The products share explicit evidence contracts, not product ownership.

## Current state versus target state

Current Dailies is a local release CLI with command/HTTP candidates, the v4
single-criterion exact-match/HTTP/Rubrist paths, retries, and tri-state reports.
Schema v4 requires exact-byte input identity and one declared evidence scope,
derives and enforces evidence trust, and retains explicitly unavailable
producer provenance. Additive schema v5 consumes an exact pinned Rubrist
policy-free suite manifest and separate receipt-v2 evidence, preserves
criterion/suite/scope/trust identity, and applies explicit mandatory,
blocking, advisory, or same-unit compensatory customer policy. Generic HTTP
evidence remains visibly self-reported and inadmissible without a reasoned
customer override. Additive schema v6 consumes exact local
`rubrist/binary-calibration/v2` artifacts under customer policy v2, preserves a
separate sealed calibration scope, evaluates repeated calibration trials
without pooling, and emits a canonical calibration-aware report while keeping
the receipt unchanged. Rubrist evidence is v2 throughout (ADR-0008), and an
evaluator's abstention counts as not passing (ADR-0009). Repeated
candidate-assessment execution, staged rollout, and hosted control-plane ideas
remain demand-gated.

## Product principles

1. A judge failure is not a product failure and is never fabricated into one.
2. Incomplete or unverifiable evidence cannot promote a release by accident.
3. Release policy belongs to the customer and is visible in the report.
4. Evidence provenance and trust class stay visible through aggregation.
5. Candidate execution, judging, and release policy remain separable stages.
6. A release decision is reproducible from its inputs, evidence, and policy.
7. A decision claim never generalizes beyond the declared evidence scopes.
8. Missing evidence for a mandatory criterion is inconclusive; another
   criterion's score cannot compensate for it implicitly.
9. Semantic clustering is explicitly deferred and outside the current plan.

## Success signals

- A release owner can see exactly why a change promoted, blocked, or remained
  inconclusive.
- Partial infrastructure failure never produces a false promotion.
- Verified, deterministic, and self-reported evidence cannot be confused.
- Dailies can consume the same Rubrist receipt under different customer
  policies without asking Rubrist to make a deployment decision.
- A release report distinguishes known-failure regression coverage, sealed
  representative evaluation, production sampling, and manual review evidence.

## Accepted planning constraints

The accepted ADRs define enforced evidence trust classes, release/provider
execution ownership, scope-bound decisions, and multi-criterion release
policy. Runtime planning may sequence these capabilities, but it must not
weaken their semantics.
