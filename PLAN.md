# Dailies plan

Status: **documentation-first target plan**

Last reviewed: 2026-08-22

`PRODUCT.md` defines the product. This plan sequences work; it does not expand
scope. The accepted ADRs are binding inputs to runtime implementation planning.
The concrete cross-product order and batch exit gates are vendored in
[`docs/implementation-batches.md`](docs/implementation-batches.md).

## Thesis

AI releases fail in ways that code compilation cannot see. Dailies makes the
release decision reproducible: run or coordinate the candidate evaluation,
retain evidence scope, provenance, trust, and incompleteness, apply
customer-owned policy, and emit `promote`, `block`, or `inconclusive`.

Coeval may provide governed assessment evidence, but it does not decide the
release. Casefile may provide deterministic artifact-trust evidence, but it
does not decide the release. Dailies owns the consequence of applying release
policy to those inputs.

## Current wedge

The local CLI is the current product surface. It:

- runs command or HTTP candidates over historical inputs;
- supports exact-match, HTTP, and Coeval evidence paths;
- records typed retry and failure evidence;
- compares explicit baseline labels with candidate assessments; and
- requires exact-byte JSONL identity and a declared evidence scope;
- derives deterministic, verified, or self-reported trust and enforces the
  safe admissibility default; and
- emits a scope-bound v4 tri-state release report while retaining a separate
  read-only v3 inspection parser.
- additively consumes a pinned Coeval evaluator-suite manifest with separate
  criterion receipts in v5, applies explicit customer criterion policy, and
  retains v4 execution compatibility; and
- additively consumes exact local binary-calibration artifacts in v6, applies
  per-trial customer policy without pooling, retains calibration and candidate
  scopes separately, and emits canonical calibration-aware tri-state reports;
  and
- runs an authored, local-only invariant robustness gate across the supported
  runner, CLI, report-parser, and policy seams. The gate is internal
  correctness evidence only, requires zero false promotions plus exact
  Dailies-oracle agreement, and is explicitly forbidden from supporting a
  competitor claim.

The CLI is also the demand probe. Improve the integrity and usefulness of this
loop before committing to a hosted control plane or serving integration.

## Documentation gate — closed

Founder review accepted the following constraints on 2026-08-22:

1. Enforce the evidence trust classes in ADR-0001; self-reported evidence is
   insufficient for automated promotion by default.
2. Preserve release/provider execution ownership from ADR-0002.
3. Bind every decision to the evidence scopes in ADR-0003.
4. Apply mandatory, advisory, blocking, and non-implicitly-compensatory criterion policy
   in Dailies as defined by ADR-0004.
5. Consume Coeval's separate policy-free criterion evidence rather than asking
   Coeval for a suite release verdict.

## Inputs to implementation batching

The next planning pass may divide work into batches, but it must cover:

1. first-class evidence scopes and their identity in configuration, items,
   reports, and decision claims;
2. trust class through item results, aggregation, reports, and policy, with the
   safe default enforced;
3. criterion and suite-policy mapping without implicit compensation
   (**implemented in additive v5 for null-trial Coeval suites**);
4. conformance fixtures for scope, trust, incomplete, tampered, and conflicting
   multi-criterion evidence;
5. adversarial decision tests for false promotion, false blocking,
   inconclusive handling, determinism, and retry behavior; and
6. Coeval calibration consumption through the frozen separate v1 artifact
   contract (**implemented as the local-file schema-v6 path**).

The first, Dailies-only portion of Batch 6 comparative-evidence preparation is
implemented as the authored invariant gate. Decision gate 5 remains open, so
no comparator adapter, runtime, result, or claim belongs in the repository yet.

## Proposed, not approved

[ADR-0006](docs/decisions/0006-third-party-eval-result-intake.md) proposes
import-only Promptfoo, DeepEval, and Braintrust result adapters as
`self_reported` evidence. It is **Proposed**, so no dependent runtime,
configuration kind, or example belongs in the repository until it is
accepted. The adapters would be evidence intake, not gate-5 comparator work.

## Demand-gated future

A hosted release control plane, staged rollout (`shadow → canary → broader
traffic`), deployment integrations, and rollback automation are possible
delivery layers. They are not current commitments and must be justified by
design partners using the manual release-decision loop.

Dailies must not become a hosted inference proxy. Customer prompts and outputs
do not need to pass through Dailies on the serving path.

## Explicit deferrals

- Rubric authoring and human-truth adjudication belong to Coeval.
- Static capability scanning belongs to Casefile.
- Semantic clustering is deferred.
- Production sampling/drift execution, cost/latency gates, and
  multi-turn/RAG/tool-stage collection wait until the core evidence model is
  stable. The evidence-scope vocabulary itself is not deferred.
