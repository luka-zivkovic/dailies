# Portfolio implementation batches

Status: **Batch 6 underway: Coeval finite-frame sampling and governed coding are implemented; Dailies invariant gate and neutral blind-contract foundation are complete; comparative execution remains gated**

Last reviewed: 2026-08-23

This file is intentionally vendored in Coeval, Dailies, and Casefile. Update
all three copies together.

## Authority and scope

This is a sequencing document, subordinate to each repository's `PRODUCT.md`
and accepted ADRs. It does not turn current code, historical plans, or
competitor behavior into product authority.

The products remain separate:

- Coeval owns Analyze → Measure: failure taxonomy, governed human truth,
  evaluators and policy-free suites, calibration, pinned execution, and
  immutable assessment evidence.
- Dailies owns scope-bound release decisions: evidence coordination, trust and
  completeness, customer policy, and `promote | block | inconclusive`.
- Casefile owns deterministic no-execution trust intake: static findings,
  artifact identity, operator policy, SARIF, lock/verify, and honest benchmark
  evidence.

Explicit non-goals for these batches are product merger, semantic clustering,
a Dailies serving proxy, release policy in Coeval, and dynamic execution or MCP
traffic proxying in Casefile.

## Completed foundation to preserve

The completed Batches 0–1C contain correctness and contract work that later
batches must not rebuild or regress:

- Coeval has immutable exact-byte terminal receipt artifacts, hardened provider
  prompt boundaries, observed provider metadata, terminal-failure handling,
  and portable producer contract fixtures.
- Dailies has scope-bound report/config schema v4, tri-state decisions, enforced
  evidence trust, strict receipt verification, typed retries and actual-operation
  ledgers, deterministic reports, and adversarial decision tests.
- Casefile has deterministic reports, strict completeness, SARIF, lock/verify,
  static-analysis hardening, a 31-artifact authored regression corpus, and its
  public no-execution benchmark adapter protocol.
- The separate neutral benchmark repository owns qualification execution, raw
  evidence, replay verification, and claim-free synthetic conformance results.

These are CURRENT implementation facts. The accepted charters and ADRs remain
the TARGET for later batches.

## Regular batch flow

Every implementation batch follows the same flow:

1. Re-read `PRODUCT.md`, the shared glossary, accepted ADRs, this plan, and the
   current diff.
2. Write or update the versioned schema, migration, state machine, truth table,
   and positive/negative fixtures before changing behavior.
3. Implement the smallest end-to-end vertical slice, preserving historical
   parsers and artifacts where the contract promises compatibility.
4. Add unit, property, failure-injection, concurrency, tamper, and migration
   tests proportional to the change.
5. Run focused tests, the complete local suite, database-backed tests where
   applicable, build/typecheck, package or benchmark gates, and
   `git diff --check`.
6. Update CURRENT documentation separately from TARGET documentation.
7. Run an independent agent audit against the exact diff and resolve all
   correctness findings before the batch is considered complete.
8. Stop at a reviewable commit boundary. Do not mix the next batch into an
   unreviewed working tree.

No batch is complete merely because the happy-path test passes.

## Batch 0 — foundation checkpoint

Implementation status: **complete and independently reviewed on 2026-08-22**.

Goal: establish a reviewable baseline before adding the newly accepted target
work.

- Inventory the existing uncommitted implementation by product, branch, stash,
  migration, and contract artifact. Record which changes belong to the
  completed foundation and which are documentation-only.
- Preserve the founder-approved TARGET documents in a docs-only commit before
  new runtime work. Use a feature branch in each repo; Dailies must leave
  `main` before implementation. Zero authority files may remain untracked.
- Resolve Coeval's existing stash explicitly: apply it on its intended branch
  and review it, or retain it with a documented owner and purpose. Never drop it
  merely to make the tree look clean.
- Complete ADR-0001's portable contract corpus: producer-owned negative
  fixtures for unknown fields, unsupported versions, invalid digests,
  ordering, coverage, and identity mismatches; vendor and pin their digests in
  Dailies. Add a shared conformance corpus that exercises JSON Schema and Zod
  acceptance/rejection consistently without claiming proof of full schema
  equivalence.
- Re-run Coeval with Node 24, Postgres-backed tests, typecheck, full tests, and
  build.
- Re-run Dailies full tests and standalone TypeScript build.
- Re-run Casefile full tests, build, authored benchmark, package dry-run, and
  relocation/permission-sensitive checks.
- Re-run cross-repository positive and negative receipt fixture/digest
  conformance.
- Review migrations for clean-database, upgrade-from-pre-0039, retry, and
  forward-fix paths.
- Audit Coeval's two gate meanings. Retain and name the golden-set
  `regression_gate` as evaluator-version governance. Freeze the deprecated
  product-release surfaces (`product_gate`, `/api/v1/gate-checks`, and
  `gate.mjs --product`). Here, freeze means document "no new callers" and pin
  unchanged deprecated behavior with tests—not add new runtime behavior in
  Batch 0. Decide their removal window in decision gate 6 before Batch 1A. Do
  not misclassify evaluator-governance overrides as deployment overrides.
- Bound the retained evaluator regression gate explicitly: it checks known
  failures on a regression/golden revision and never serves as calibration
  evidence or a broad evaluator-validity claim. Its threshold governs the
  evaluator lifecycle, not a customer's product release.
- Create founder-approved commit boundaries; do not rewrite unrelated work.

Exit gate: the current foundation is reproducible and reviewable with no
unknown dirty-worktree dependency, every portable negative fixture is rejected
by both producer and consumer, and no untracked authority document remains.

## Batch 1A — Coeval immutable receipts

Implementation status: **complete and independently reviewed on 2026-08-22**.

Decision gates 1, 2, and 6 were accepted on 2026-08-22 and are recorded in
Coeval ADR-0006. Exact-byte `bytea` storage, idempotent historical freeze with
divergence records, and the post-Dailies-v4 legacy write-removal window are
binding for this batch.

Persist the exact canonical bytes and digest of every externally consumable
terminal receipt:

- append-only receipt artifact keyed by assessment identity and contract
  version;
- atomic minting at terminalization, including terminal incomplete evidence;
- idempotent concurrent mint/read behavior;
- reads return persisted bytes rather than reconstructing mutable rows;
- corrections create linked successor artifacts instead of mutation; and
- historical v1 runs use a documented one-time freeze path. The CURRENT
  `receiptId` is deterministically derived from the eval-run identity, but the
  freeze still records source-row/freeze provenance outside receipt v1. When a
  consumer-held copy exists, compare exact bytes and record divergence rather
  than replacing history silently.

Do not add calibration, suite, uncertainty, or policy fields to receipt v1.

Exit gate: receipt v1 stays byte-compatible; a concurrent terminal mint stores
one artifact; later source-row mutation cannot change a stored receipt; and a
correction creates a linked successor.

## Batch 1B — Dailies scope and trust

Implementation status: **complete and independently reviewed on 2026-08-22**.

Decision gate 3 was accepted on 2026-08-22 and is recorded in Dailies
ADR-0005. Operational/protocol integrity failure remains `inconclusive`, while
a complete admissible blocking result outranks unrelated missing evidence.

Introduce report/config schema v4 with first-class evidence scope and enforced
trust class:

- require Dailies/customer-declared scope kind, immutable local dataset/sample
  identity such as exact JSONL bytes, collection procedure, expected coverage,
  and applicable population/time window;
- distinguish customer-declared scope from producer-supplied revision,
  exposure, or review provenance. Receipt v1 does not carry the latter, so v4
  records `not_provided` without inferring or upgrading it;
- derive trust class from the verified integration path, never from a
  provider's self-assertion;
- classify exact-match as deterministic, a fully verified Coeval receipt as
  verified, and the generic HTTP judge as self-reported;
- make verified and deterministic evidence admissible by default;
- make self-reported evidence insufficient for automated promotion unless a
  visible customer override and reason are recorded;
- rename the target report field from `verdict` to `decision` while retaining
  the tri-state values;
- add an explicit read-only v3 parser before emitting v4, reject unsupported
  v1/v2 with a clear diagnostic, and never silently upgrade a legacy report.
  The named use is offline report inspection/diff; release-policy execution
  accepts v4 only; and
- bind the decision statement to the named scope.

Exit gate: no required self-reported evidence can produce `promote` without a
recorded override; trust cannot be asserted by a judge response; scope-less or
masquerading legacy evidence cannot become v4; and output remains deterministic.

## Batch 1C — neutral Casefile benchmark protocol

Implementation status: **complete and independently reviewed on 2026-08-22**.

Ownership/isolation is resolved by accepted Casefile ADR-0002: the separately
owned `agent-artifact-trust-bench` repository owns the harness, comparator
execution, and raw results. Casefile owns only its public protocol, adapter, and
synthetic qualification corpus. Gate 5 remains open for the blind-run design.

The comparator harness lives in a separately owned benchmark workspace or
repository, not inside Casefile's product runtime or CI. Casefile ships only
its adapter, public protocol, and synthetic qualification corpus. Build no
hidden corpus in the product repository.

- neutral case envelope, label ontology, rule-equivalence process, and
  tool-adapter interface;
- pinned tool/config/environment identity;
- explicit network, credential, cloud, execution, and sandbox conditions;
- common static-skill track separated from unsupported-format/breadth reporting;
  unsupported or incomplete analysis on a common-track case counts as a miss;
- deterministic normalization and raw result retention;
- preregistered metric definitions and interval methods; and
- a synthetic public qualification corpus that tests the harness, not detector
  quality.

Exit gate: Casefile CI never executes a comparator or assessed artifact; the
neutral harness rejects unfrozen tool versions; all-positive and
all-unsupported adapters visibly fail named qualification expectations; and
qualification cannot emit a performance claim.

## Batch 2 — dataset revisions and exposure

Implementation status: **complete and independently reviewed on 2026-08-22**.

Coeval implements the four accepted immutable dataset roles:

- analysis/authoring;
- iterative development;
- sealed validation; and
- regression/golden.

The slice includes content identity, revision lineage, input-only exact leakage
identity, append-only exposure events, role transition rules, and clear CURRENT
UI/API labels. Every pre-existing case is recorded as exposed with legacy or
lower provenance; it cannot be relabeled sealed. Opening sealed cases for later
tuning marks them exposed for subsequent evaluator versions. Regression results
never claim representative production accuracy. Semantic-near-duplicate
detection remains explicitly unsupported.

The first valid sealed-validation revision must be collected after exposure
tracking exists and receive governed blind review in Batch 4. Batch 2 may
create the revision and isolation boundary, but it cannot manufacture
historical blindness or full review provenance for legacy cases.

Move the retained evaluator regression gate from the CURRENT mutable golden set
to an immutable regression/golden revision identity. This remains
known-failure governance, not sealed validation or calibration.

The ordinary collection-freeze API creates only analysis/authoring and
iterative-development revisions. Regression/golden revisions are materialized
only by promotion/retirement governance, and the database enforces the same
source-role invariant. Pre-migration in-flight evaluator jobs are late-pinned
once with audit evidence rather than failed during rolling deployment.

In parallel, an independent benchmark owner may begin Casefile corpus
collection under the accepted protocol. Detector authors do not receive the
hidden cases.

Exit gate: mutable collections cannot be named as sealed revisions; exact input
overlap across incompatible roles is rejected; exposure is append-only; and
legacy or visible regression data cannot be re-roled sealed.

## Batch 3 — single criteria, policy-free suites, and release policy

Status: **Complete (2026-08-23).** Coeval now supports immutable criterion
definitions, exact evaluator bindings, criterion-scoped evidence, explicit
multi-criterion imports and UI selection, and canonical policy-free suite
manifest v1 artifacts while leaving receipt v1 unchanged. Dailies v5 vendors
and verifies that contract, collects separate criterion receipts, and applies
explicit mandatory, blocking, advisory, or formula-defined compensatory
customer policy without a default weighted average. V3/v4 Dailies artifacts
remain read-only/compatible.

### Coeval

Add a versioned criterion model and policy-free suite manifest:

- replace the CURRENT one-skill-per-project constraint from migration 0016 and
  audit every API, repository, worker, onboarding, import, and UI assumption
  that selects a single current skill;
- one evaluator version measures one named criterion;
- criterion identity becomes immutable evaluator metadata and part of suite
  identity without changing receipt v1. The v1 `skillDigest` field set and
  digest basis are frozen; the suite manifest binds criterion identity to the
  existing evaluator/skill version;
- suite identity pins criterion definitions, evaluator versions, ordering,
  applicability, and optional trial plan;
- assessment evidence remains separate and verifiable per criterion;
- a suite groups evidence but emits no weight, threshold, mandatory/advisory
  role, composite score, or release result; and
- contract fixtures cover reordered, missing, substituted, duplicated, and
  unknown criteria.

The first integration should prefer a suite manifest plus separate criterion
receipts. Do not mutate receipt v1 to create a shortcut.

Coeval's producer contract and adversarial fixtures must pass before Dailies
starts the paired consumer slice.

### Dailies

Introduce the next report/policy version for criterion-level rules:

- mandatory, blocking, advisory, and explicitly compensatory roles;
- no default weighted average;
- missing mandatory evidence yields `inconclusive`;
- a complete blocking failure yields `block`;
- compensation requires an explicit versioned formula and compatible units;
- criterion, suite, scope, and trust identities survive aggregation; and
- a complete truth table defines precedence for simultaneous block and
  incomplete conditions before implementation.

Coeval exit gate: multiple criteria can coexist in one project without an
ambiguous "current skill," and reordered, missing, substituted, duplicated,
or unknown criterion fixtures fail verification.

Dailies exit gate: identical Coeval criterion evidence supports different valid
policies, advisory evidence cannot rescue mandatory-incomplete or
blocking-fail evidence, and no criterion is silently compensated.

## Batch 4 — governed human truth

Implementation status: **complete and independently reviewed on 2026-08-23**.

Decision gate 7 was accepted on 2026-08-23 and is recorded in Coeval
ADR-0008. Governed review uses a separate append-only evidence path; legacy
verdicts and queues are never upgraded to blind or representative truth.

Coeval makes review a first-class governed workflow:

- full relevant trace and criterion instructions;
- open failure codes and rationale;
- independent blind labels before reviewer alignment;
- reviewer and instruction-version provenance;
- defer, undo, disagreement, alignment, and adjudication history;
- no deletion or retroactive rewriting of independent labels;
- selection provenance distinguishing random/stratified samples from
  convenience, uncertainty, and failure-hunting queues; and
- imported truth with equivalent provenance or an explicit lower evidence
  status.

Start with the smallest end-to-end binary-review slice. Fast review UX matters,
but semantic clustering remains deferred. A sealed-validation review task never
shows the evaluator's label to the reviewer.

Exit gate: resolved human truth can be reproduced without erasing disagreement,
independent labels remain immutable after adjudication, and a biased review
queue cannot be presented as a representative sample.

## Batch 5 — calibration evidence and consumption

### Contract gate

ADR-0009 accepts the separate immutable, aggregate-only
`coeval/binary-calibration/v1` artifact referenced by exact evaluator,
criterion, truth revision, exposure, selection, and execution identities. The
closed schema, canonical builder/parser/verifier, exact transport fixtures,
adversarial corpus, and Wilson reference implementation were completed,
independently reviewed, and frozen in Batch 5A. Dailies vendors those exact
bytes and passes the shared conformance corpus in its own JavaScript runtime.
The artifact is not inserted into closed receipt v1.

### Coeval (single-trial Batch 5B runtime complete and independently reviewed)

The current Postgres runtime lets a project owner launch one explicit
`{ kind: "single", trialsPerItem: 1 }` run over an exact complete governed
sealed-validation revision. It durably leases the revision, supplies the
worker only the protected payload, records call start before the one physical
provider dispatch, disables hidden provider retries and parameter-changing
fallbacks, and rejects unsupported non-null `topP` before dispatch. A stranded
started attempt becomes permanent `outcome_unknown` and is never recalled.

At terminalization the repository rechecks exposure and deterministically
mints a public-contract artifact containing:

- declared positive class and explicit false-pass/false-fail definitions;
- full confusion matrix;
- accuracy, precision, recall/TPR, specificity/TNR, and F1;
- total/per-class support, balance, coverage, abstentions, errors, and
  unevaluated counts;
- versioned confidence-interval method and uncertainty;
- evaluator, criterion, truth revision, exposure, metric, trial, and observed
  provider provenance; and
- exact canonical bytes that exclude item identity, protected payloads,
  per-item labels, rationale, and provider request/response identifiers.

Undefined and weakly supported metrics remain explicit. Coeval does not issue a
universal calibrated/un-calibrated release verdict. Current admissibility is
separate from immutable artifact bytes. The private salted ledger has no read
API or export surface. The frozen artifact contract also supports
repeated-trial distributions without hiding variance in an unqualified mean,
but the current producer runtime does not execute repeated trials.

### Dailies (contract verification and local policy consumption CURRENT)

Dailies vendors the frozen contract and adversarial corpus, independently
verifies exact canonical bytes, identity bindings, digest, counts, metrics,
intervals, trial distributions, and unknown-field behavior, and consumes
explicitly configured local artifacts through additive config v6, policy v2,
report v6, runner, and CLI paths. It performs no latest-artifact, network
status, or private-ledger lookup.

Customer policy can require per-criterion metrics, support, confidence,
coverage, freshness, provider identity strength, and every repeated trial to
meet its checks. Calibration uses a separate Dailies calibration scope and
does not upgrade the candidate execution scope: assessment receipt v1
candidate `producerProvenance` remains `not_provided`. A configured required
integrity failure is `inconclusive` before candidate/provider execution;
missing, stale, or insufficient calibration cannot admit that criterion's
block, while an unrelated complete calibrated block may still win under the
accepted precedence. Thresholds and release consequences remain in Dailies.

The Batch 5 product exit gate is closed. Both runtimes pass the shared positive
and adversarial fixtures for revision, exposure, coverage, metric, and
evaluator identity. Dailies proves that identical calibration evidence can
produce different valid results under different customer policies, that every
trial is evaluated without pooling, and that missing, stale, swapped, future,
or unverifiable required evidence cannot falsely promote a candidate.

## Batch 6 — Analyze workflow and comparative evidence

### Coeval

Contract status: **accepted in Coeval ADR-0010; finite population/draw, governed coding/taxonomy, and exact criterion-promotion handoff runtime implemented; candidate lifecycle and measurement pending**.

Complete the non-clustering Analyze → Measure loop:

- sample representative traces with recorded selection provenance;
- open-code failures and revise a human-readable taxonomy;
- track taxonomy/criterion versions and uncategorized cases;
- turn a narrow failure mode into a criterion, review task, evaluator, and
  calibration workflow; and
- measure task completion, reviewer disagreement, taxonomy churn, evaluator
  error direction, time to the first completed calibration artifact, and time
  to the first currently admissible calibration artifact.

The first slice uses a frozen finite trace population, server-executed simple
random sampling, append-only multi-label coding, flat human-authored taxonomy
revisions, and explicit candidate-evaluator lifecycle. Analysis and authoring
data never become sealed calibration truth, and Coeval does not invent a
universal trusted-evaluator threshold.

Coeval uses internal and customer-task validation rather than a forced
competitor leaderboard.

### Dailies invariant and comparative evidence

The Dailies-only authored invariant suite is current. It covers timeout,
transport, protocol, partial coverage, tamper, mixed trust, scope mismatch,
nondeterminism, multi-criterion conflicts, exact call counts, report parsing,
and concurrent ordering. It requires zero false promotions and zero false
blocks and remains a correctness gate, not a competitor claim.

Second, use an independently authored, partially blind study titled **CI
release-gate robustness under infrastructure faults** for tools such as
Promptfoo or DeepEval:

- restrict comparison metrics to scenarios applicable to every participant,
  initially timeout, transport, judge error, partial coverage, and
  nondeterminism over the same deterministic candidate/judge fixtures;
- record `not_applicable` as a first-class result when a tool has no analogous
  trust, scope, tamper, or tri-state semantic; never score that absence as a
  Dailies win;
- report false-promotion, false-block, error/abort, determinism, audit
  completeness, and runtime with model latency separated from release-engine
  overhead; and
- omit operator-effort unless its tasks, raters, scoring, and stopping rule are
  preregistered.

Blind comparative results are reported with uncertainty and framed as release
gate robustness, not evaluator quality or universal product superiority.

### Casefile blind benchmark

The neutral benchmark workspace now has public pre-gate contracts for frozen
applicability, execution settings, label-independent corpus strata,
preregistration, raw-manifest coverage, post-attempt truth release, metrics,
and claim-free reports. It deliberately has no blind runner and cannot mint the
private byte-verified evidence capability required for scoring before Gate 5.

Freeze labels, adjudication, sample size/stopping rule, Casefile and comparator
versions, configurations, and environments before unsealing. Run the common
static track and report unsupported breadth separately. Publish recall,
precision/false positives, family coverage, incomplete-analysis behavior,
determinism, runtime, and confidence intervals together with every tool's
network, cloud, credential, execution, and sandbox conditions.

No detector tuning occurs after unsealing. Any post-hoc rerun is labeled as
such.

Exit gate: comparative claims are reproducible, scope-limited, and supported by
independent evidence rather than the authored regression corpora.

## Cross-product test requirements

- Producer fixtures are generated once and vendored by consumers with pinned
  digests; consumers also maintain independent negative fixtures.
- Every schema version has forward/unknown-field, downgrade, replay, identity
  swap, truncation, and canonicalization tests.
- Database changes have clean-install, upgrade, forward-fix/recovery, retry,
  concurrency, and constraint tests.
- State machines have exhaustive decision tables plus property tests.
- Failure injection covers every external boundary without fabricating product
  outcomes from infrastructure failures.
- Concurrency tests prove actual overlap, deterministic ordering, and byte
  stability.
- Performance tests report distributions and environment identity, not only a
  single wall-clock number.
- Hidden benchmark data never enters prompts, fixtures, source control, or
  implementation-agent context before versions are frozen.

## Decision gates still required

These gates do not reopen product ownership, but several have user-visible or
historical semantics and must be accepted before their runtime batch:

1. **Resolved for Batch 1A:** exact schema and storage representation for
   persisted Coeval receipt bytes (Coeval ADR-0006).
2. **Resolved for Batch 1A:** historical v1 one-time freeze and
   divergence-reporting behavior (Coeval ADR-0006).
3. **Resolved:** the simultaneous blocking-failure plus mandatory-incomplete
   precedence table is fixed in Dailies ADR-0005.
4. **Resolved for Batch 5A:** calibration transport, canonicalization, and
   compatibility are fixed by Coeval ADR-0009 as a separate artifact v1;
   assessment receipt v1 remains unchanged.
5. Independent owners, sampling frames, budgets, and stopping rules for the two
   comparative benchmarks.
6. **Resolved:** deprecated product-release writes remain through the Dailies
   v4 migration and become `410 Gone` in Batch 2; historical reads remain.
   The evaluator-version regression gate remains in Coeval (Coeval ADR-0006).
7. **Resolved for Batch 4:** the collection, independent-review, abstention,
   resolution, selection, and separation-of-duty plan for the first genuinely
   sealed validation revision is fixed by Coeval ADR-0008.
8. **Resolved for Batch 1C:** ownership and isolation of the neutral benchmark
   workspace is fixed by Casefile ADR-0002; comparator execution never becomes
   Casefile product behavior.
9. **Resolved for Batch 2:** the directional compatibility, declassification,
   sealed-successor, exact-input identity, and public sealed-intake boundary
   are fixed by Coeval ADR-0007.
10. **Resolved for Batch 6:** representative finite-frame sampling,
    append-only open coding, flat taxonomy revision, failure-code promotion,
    candidate evaluator lifecycle, and honest component measurements are fixed
    by Coeval ADR-0010.

Resolve each in the contract phase of its owning batch before runtime code.
