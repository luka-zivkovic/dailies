# Contributing to Dailies

Dailies coordinates release evaluation over declared evidence scopes, keeps
evidence trust and incompleteness visible per criterion, applies
customer-owned release policy, and emits `promote`, `block`, or
`inconclusive`. Contributions must preserve that boundary: Dailies never
authors rubrics, establishes human truth, governs evaluator quality, or sits
on the serving inference path.

## Before opening a change

1. Read `AGENTS.md`, then `PRODUCT.md`, `docs/glossary.md`, the decision
   index in `docs/decisions/README.md`, and `docs/implementation-batches.md`.
   `PRODUCT.md` and accepted ADRs define target behavior; the README, `PLAN.md`,
   CLI copy, comments, and code describe current behavior only.
2. Label material claims in audits and plans as `TARGET` (charter or accepted
   ADR), `CURRENT` (observed behavior), or `ASSUMPTION` (unverified).
3. Do not implement behavior that depends on a proposed ADR without explicit
   approval. A proposed ADR records an open decision, not a commitment.
4. Keep release policy customer-owned and outside the evidence artifacts.
   Receipts, manifests, and calibration artifacts must never carry thresholds,
   decisions, or overrides.
5. Preserve the decision precedence fixed in ADR-0005. Missing or failed
   evidence becomes `inconclusive`; it is never a synthetic pass or failure.
6. Treat `docs/positioning.md` as dated market context, never as product
   authority.

## Local checks

Requires Node.js 20 or newer.

```bash
npm ci
npm run build
npm test
npm run invariant:batch6
```

All four commands must pass; continuous integration runs them on Node.js 20
and 22. `npm test` reports the current test count. `npm run invariant:batch6`
is the authored invariant robustness gate for decision precedence and
execution evidence; it is a correctness gate, not a competitor benchmark.

When a change touches runner scheduling, retries, or deadline handling, also
run `npm run benchmark:batch3` and compare the reported latencies against the
previous run. Before publishing, confirm the package contents with
`npm pack --dry-run`.

Add positive, negative, and near-miss fixtures for new verification or policy
behavior. Vendored contracts under `contracts/` are frozen; a change to a
schema, fixture, or digest must be coordinated with the producer and called
out explicitly.

## Pull requests

Keep changes narrowly scoped, state which evidence or policy boundary is
affected, and call out any config-schema, report-schema, contract, invariant
suite, or exit-code change explicitly. Record notable changes under
`Unreleased` in `CHANGELOG.md`. Do not include credentials, private customer
corpora, candidate outputs, or generated reports from third-party systems.

Report security problems through `SECURITY.md`, not a public pull request.
