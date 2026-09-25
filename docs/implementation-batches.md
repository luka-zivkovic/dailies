# Portfolio implementation batches

Status: **Batch 6 product foundations complete: Rubrist Analyze → Measure, the Dailies invariant gate, and the neutral blind-contract foundation are implemented; comparative execution remains gated by Gate 5; Batch 7 Rubrist production outcome monitoring is complete under Rubrist ADR-0013; Batch 8 model-agnostic evaluator execution is planned under Rubrist ADR-0014**

Last reviewed: 2026-09-25

This file is intentionally vendored in Rubrist, Dailies, and Casefile. Update
all three copies together.

## Authority and scope

This is a sequencing document, subordinate to each repository's `PRODUCT.md`
and accepted ADRs. It does not turn current code, historical plans, or
competitor behavior into product authority.

The products remain separate:

- Rubrist owns Analyze → Measure: failure taxonomy, governed human truth,
  evaluators and policy-free suites, calibration, pinned execution, and
  immutable assessment evidence. It also owns production outcome monitoring,
  which is ungoverned development feedback kept separate from that evidence.
- Dailies owns scope-bound release decisions: evidence coordination, trust and
  completeness, customer policy, and `promote | block | inconclusive`.
- Casefile owns deterministic no-execution trust intake: static findings,
  artifact identity, operator policy, SARIF, lock/verify, and honest benchmark
  evidence.

Explicit non-goals for these batches are product merger, semantic clustering,
a Dailies serving proxy, release policy in Rubrist, and dynamic execution or MCP
traffic proxying in Casefile.

## Completed foundation to preserve

The completed Batches 0–1C contain correctness and contract work that later
batches must not rebuild or regress:

- Rubrist has immutable exact-byte terminal receipt artifacts, hardened provider
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
- Resolve Rubrist's existing stash explicitly: apply it on its intended branch
  and review it, or retain it with a documented owner and purpose. Never drop it
  merely to make the tree look clean.
- Complete ADR-0001's portable contract corpus: producer-owned negative
  fixtures for unknown fields, unsupported versions, invalid digests,
  ordering, coverage, and identity mismatches; vendor and pin their digests in
  Dailies. Add a shared conformance corpus that exercises JSON Schema and Zod
  acceptance/rejection consistently without claiming proof of full schema
  equivalence.
- Re-run Rubrist with Node 24, Postgres-backed tests, typecheck, full tests, and
  build.
- Re-run Dailies full tests and standalone TypeScript build.
- Re-run Casefile full tests, build, authored benchmark, package dry-run, and
  relocation/permission-sensitive checks.
- Re-run cross-repository positive and negative receipt fixture/digest
  conformance.
- Review migrations for clean-database, upgrade-from-pre-0039, retry, and
  forward-fix paths.
- Audit Rubrist's two gate meanings. Retain and name the golden-set
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

## Batch 1A — Rubrist immutable receipts

Implementation status: **complete and independently reviewed on 2026-08-22**.

Decision gates 1, 2, and 6 were accepted on 2026-08-22 and are recorded in
Rubrist ADR-0006. Exact-byte `bytea` storage, idempotent historical freeze with
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
- classify exact-match as deterministic, a fully verified Rubrist receipt as
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

Rubrist implements the four accepted immutable dataset roles:

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

Status: **Complete (2026-08-23).** Rubrist now supports immutable criterion
definitions, exact evaluator bindings, criterion-scoped evidence, explicit
multi-criterion imports and UI selection, and canonical policy-free suite
manifest v1 artifacts while leaving receipt v1 unchanged. Dailies v5 vendors
and verifies that contract, collects separate criterion receipts, and applies
explicit mandatory, blocking, advisory, or formula-defined compensatory
customer policy without a default weighted average. V3/v4 Dailies artifacts
remain read-only/compatible.

### Rubrist

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

Rubrist's producer contract and adversarial fixtures must pass before Dailies
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

Rubrist exit gate: multiple criteria can coexist in one project without an
ambiguous "current skill," and reordered, missing, substituted, duplicated,
or unknown criterion fixtures fail verification.

Dailies exit gate: identical Rubrist criterion evidence supports different valid
policies, advisory evidence cannot rescue mandatory-incomplete or
blocking-fail evidence, and no criterion is silently compensated.

## Batch 4 — governed human truth

Implementation status: **complete and independently reviewed on 2026-08-23**.

Decision gate 7 was accepted on 2026-08-23 and is recorded in Rubrist
ADR-0008. Governed review uses a separate append-only evidence path; legacy
verdicts and queues are never upgraded to blind or representative truth.

Rubrist makes review a first-class governed workflow:

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
`rubrist/binary-calibration/v1` artifact referenced by exact evaluator,
criterion, truth revision, exposure, selection, and execution identities. The
closed schema, canonical builder/parser/verifier, exact transport fixtures,
adversarial corpus, and Wilson reference implementation were completed,
independently reviewed, and frozen in Batch 5A. Dailies vendors those exact
bytes and passes the shared conformance corpus in its own JavaScript runtime.
The artifact is not inserted into closed receipt v1.

### Rubrist (single-trial Batch 5B runtime complete and independently reviewed)

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

Undefined and weakly supported metrics remain explicit. Rubrist does not issue a
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

### Rubrist

Contract status: **accepted in Rubrist ADR-0010; the finite-frame Analyze → Measure runtime is implemented through candidate lifecycle and digest-bound component measurement**.

The implemented non-clustering Analyze → Measure loop now:

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
data never become sealed calibration truth, and Rubrist does not invent a
universal trusted-evaluator threshold.

Rubrist uses internal and customer-task validation rather than a forced
competitor leaderboard.

The PostgreSQL integration gate covers promotion, independent governed truth,
candidate creation, sealed calibration, complete retained regression,
activation, component measurement, revocation, and the resulting read-time
loss of current admissibility without rewriting historical evidence.

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

## Batch 7 — Rubrist production outcome monitoring

Implementation status: **complete and independently reviewed on
2026-09-24**. Decision gate 11 was accepted on 2026-09-23 and is recorded in
Rubrist ADR-0013. Every slice was reviewed by an independent agent against its
exact diff, and each review's correctness findings were resolved before merge.

This batch is Rubrist-only. Dailies and Casefile runtimes do not change, and
production monitoring reports are not a Dailies evidence contract. Monitoring
is ungoverned development feedback: nothing in this batch writes human truth,
dataset revisions, exposure events, receipts, suites, or binary-calibration
artifacts.

### 7A — report contract settlement

- Score-question (ordinal) analysis in the pure production-calibration
  module, with explicit exclusion counts for malformed distributions and
  out-of-range outcomes.
- The report states the time window it covers.
- The `production-calibration` report version is settled before any snapshot
  is saved or any stored-record read exists.

### 7B — records, ingest, reports, and snapshots

- Append-only, project-scoped decision, action, and outcome records with
  canonical content digests and submitter provenance kept outside the record
  content. The record contract stays `production-decision-record/v1`.
- Write-time conflict rejection, idempotent duplicate records, orphan
  actions and outcomes that join when their decision arrives, and rejection
  of records dated more than five minutes after receipt.
- API key capabilities. An ingest-only key appends records and nothing else;
  existing keys gain no ingest capability.
- An atomic JSON Lines batch append under `/api/v1/` (at most 10,000 records
  and 4 MiB) with its own configurable records-per-minute budget, and an
  owner import through the session UI over the same write path.
- Reports computed on read over a stated window (either bound may be open) with server-supplied
  `now`, a deterministic record order, and an explicit record ceiling that
  fails instead of sampling.
- Member-saved snapshots of stored-record reports holding exact canonical
  report bytes, their digest, build parameters, window, report version, and
  record-set digest.
- Scheduled retention by receive time (90 days by default, owner-adjustable
  between 1 and 730 days), owner erasure of one decision's records with a
  tombstone, owner purge of a revoked key's records, and owner snapshot
  deletion, each with an audit entry written in the same transaction.
- The web view reads stored records and snapshots. The preview route stays
  compute-only.

Not in this batch: Ironside ingest, governed-review routing of a
low-confidence production sample, and drift or model-change notifications.
ADR-0013 records them as follow-ups that each need their own decision.

Exit gate: an identical retry writes nothing new; a conflicting decision is
rejected without affecting later reports; a future-dated record is rejected;
an ingest key cannot judge or read and an existing key cannot ingest; no
stored row holds state or question text; two builds over the same records at
the same server time are byte-identical; a build over the ceiling fails
explicitly; a saved snapshot's
bytes and digest never change; an erased decision ID cannot be re-ingested; a
purge removes exactly the revoked key's records, including a request that
authenticated before the revoke; retention runs, erasure, purge, and snapshot
deletion leave audit entries; and receipt v1, suite manifest v1,
and binary-calibration v1 bytes are unchanged.

## Batch 8 — Model-agnostic evaluator execution and evidence v2

Implementation status: **planned**. Decision gate 12 was accepted on
2026-09-25 and is recorded in Rubrist ADR-0014, including the founder's
answers to its four open questions and two later decisions: receipts carry a
definition digest, and v2 replaces v1. The first 8A slice (#125, shared
identity contracts) is merged; its `skillDigestV2` moves to the
definition-digest construction (#127) before first use. Every slice gets an independent review
against its exact diff, and each review's correctness findings are resolved
before merge.

This batch changes Rubrist and Dailies. Both switch to the v2 contracts in
one window and drop v1 support; Casefile's runtime does not change.

Goal: anyone can bind any model as an evaluator. Evidence states exactly what
was sent, with which verdict protocol and reasoning. A typed-question model
such as TypeSafe Jev can be an optional evaluator provider.

### 8A — contract settlement (Rubrist and Dailies)

- Evaluator definition and execution binding, which are identity, kept
  separate from the resolution record, which is not. Unset values are
  canonical `null`.
- `assessment-receipt/v2`:
  - the shared outcome and failure taxonomy, with `not_attempted`;
  - completeness that counts an abstention as an outcome;
  - `evaluatorScore` with its source;
  - the execution binding and the definition digest, never the rubric,
    prompt, or question text;
  - `skillDigest` v2, computed from the basis, the definition digest, and
    the binding.
- `binary-calibration/v2` and its private ledger v2,
  `evaluator-suite-manifest/v2`, and `skill-format/v2`, which carries the
  full definition and, for a typed-question evaluator, the question text.
- Schemas, canonicalization, positive and negative fixtures, and
  conformance vectors.
- v2 replaces v1. Dailies switches to v2 in the same window, and neither
  repository keeps code that emits or verifies v1. The v1 contract documents
  and fixtures stay unchanged in `contracts/` as superseded history.
- A Dailies decision, on the pre-launch basis of its ADR-0007, for the
  Dailies-owned side: a report and configuration version with v2 evidence
  kinds, and removal of v1 re-verification from historical-report
  inspection.

### 8B — judge runtime

- Versioned verdict protocols: `anthropic.structured-output/v1`,
  `anthropic.forced-tool/v1`, `openai.structured-output/v1`,
  `openai.forced-function/v1`, `prompted-json/v1` with a strict
  single-object parse, `typed-question/v1`, and `mock/v1`. Each pins:
  - the judge preamble, protocol and verdict-instruction text;
  - the user-message wrapper and evidence serialization;
  - the output schema and its descriptions, and the schema transform;
  - the token-limit parameter;
  - the parse rule.
- The default, seed, and web starter prompt templates stop naming the
  verdict mechanism; the protocol text supplies it.
- Optional sampling parameters, where unset means not sent; a typed
  reasoning shape per provider family; the output token limit in the
  binding; the endpoint identity; and OpenRouter
  `require_parameters` with fallbacks off.
- No parameter-changing retries, and the "retry without temperature"
  fallback removed. Observed reasoning and the observed OpenRouter upstream
  recorded as provenance.

### 8C — capability resolution

- Capability data where the provider publishes it: Anthropic
  `capabilities` and OpenRouter `supported_parameters`.
- The dated `rubrist-reasoning-defaults/v1` table of documented default
  reasoning, with its sources.
- A capability check before save, with at most 6 probes. Protocol probes
  send no optional settings. On the protocol that succeeds, it tests
  temperature with the default reasoning, and tests the default (or a
  middle) reasoning value and the no-reasoning setting. Mechanism
  rejections, and any unattributed rejection of a protocol probe, move to
  the next protocol. Parameter and value rejections mark that parameter or
  value rejected, and an unattributed rejection of a temperature or
  reasoning probe counts as a value rejection.
- Resolution after save sends one confirming probe with the exact saved
  request, plus a temperature probe with the saved reasoning where
  temperature is unset and no such probe has a recorded outcome, and never
  changes the binding. An unresolved
  binding resolves at the first governed gate or run that needs it, or on
  demand, with at most 3 probes. All probes use a fixed, non-sensitive
  input.
- Resolution records with status `resolved`, `unresolved`, or `failed`, the
  settings each probe sent, the credential source, and the probe cost. Only
  a rejected or protocol-breaking confirming probe sets `failed`; transient,
  authentication, and invalid-output errors leave a binding unresolved.
  The record keeps the latest attempt; an earlier unresolved attempt is
  recorded against what triggered it.
- Deterministic protocol defaults when probes can't run.
- A re-check before sealed calibration authorization and before any
  governed run starts, with one to three probes that also re-test unset
  temperature and reasoning, so no sealed item is exposed when the
  resolution no longer holds. It is recorded with the run it guards and
  never changes the resolution record.

### 8D — persistence, gates, and evidence emission

- v2 bindings and resolution records persisted, with the baseline edited
  in place under ADR-0011.
- Governed gates require:
  - a resolved binding;
  - an explicit temperature unless the family takes no sampling settings
    (`typesafe`, `mock`) or the model rejects the parameter itself with the
    saved reasoning;
  - explicit reasoning unless the provider family has no reasoning shape
    or the model rejects the reasoning parameter itself.
- The seeded default binding: `anthropic` on its managed endpoint, model id
  and version `claude-sonnet-4-6`, temperature 0 with `topP` unset,
  thinking `disabled` at effort `high`, `anthropic.structured-output/v1`,
  and an output token limit of 1,200. It is saved unresolved.
- Every evaluator version emits v2 receipts, calibration, and manifests.
  The v1 emitters are removed.

### 8E — typed-question evaluators (#101)

- An optional `typesafe` provider covering binary `noul` questions only.
- The definition holds the question-set digest, the polarity, a
  **required** decision threshold chosen on non-sealed data, and the output
  contract.
- `rationale: not_provided`, the pinned model, and #108's alias rule.
- Criterion-author guidance from the spike.

### 8F — authoring UI

- A model picker driven by the capability check. It hides a sampling or
  reasoning field the model rejects outright, offers the family's reasoning
  modes except those the model rejects, and marks untested modes
  "confirmed at resolution". It pre-fills the documented default reasoning,
  which the author saves explicitly.
- Resolution status and probe outcome shown to the author, and
  typed-question evaluator authoring.

Not in this batch: #102 uncertainty selection, which needs its own decision
on ADR-0008 selection provenance; `choice` and `score` typed questions,
which wait for ADR-0004 categorical and scalar calibration; and any
trace-length gate.

Exit gate:

**Models and resolution**

- A `claude-opus-5-5`, `claude-sonnet-5`, and OpenRouter binding each
  resolve, judge, and run sealed calibration with one physical call per
  item.
- A binding requesting a parameter or reasoning mode the model rejects
  fails resolution with the provider's message. Resolution never changes a
  saved binding.
- A resolution that no longer holds stops a governed run before any sealed
  exposure. A transient probe error never fails a binding.
- `OPENAI_BASE_URL` is never applied unless the binding records it.
- `jev-latest` is refused at governed gates.

**Evidence**

- The evidence states exactly what was sent, including unset parameters,
  the protocol, and reasoning.
- A change to injected text produces a new protocol version and a new
  `skillDigest`.
- A receipt with an abstention is `complete`. Any failure or
  `not_attempted` item makes it `incomplete`.
- A receipt carries the definition digest and never the rubric, prompt, or
  question text. Dailies recomputes `skillDigest` v2 from the receipt's
  binding and definition digest.
- No code in Rubrist or Dailies emits or verifies a v1 receipt,
  calibration, calibration private ledger, suite manifest, or
  `skill-format/v1`. The frozen v1 documents and fixtures in `contracts/`
  are unchanged.
- Dailies verifies v2, and its report and configuration contracts name v2
  evidence kinds under its own recorded decision.

**The founder's four decisions**

- Q1: a governed gate refuses an unset temperature or reasoning setting
  unless the family has no such setting or the resolution record shows the
  model rejecting that parameter itself (for temperature, with the saved
  reasoning). A value-only or unattributed rejection still requires an
  explicit value. For `claude-opus-5-5`, the picker hides the temperature
  field the capability check shows it rejects.
- Q2: a new binding starts from the documented default reasoning, saved
  explicitly and covered by `skillDigest`.
- Q3: `prompted-json/v1` rejects JSON wrapped in prose as
  `invalid_evaluator_output`.
- Q4: a Jev evaluator without a threshold is refused. One with a threshold
  calibrates on sealed truth, and its receipts carry `evaluatorScore` with
  kind `native_probability`.

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
   persisted Rubrist receipt bytes (Rubrist ADR-0006).
2. **Resolved for Batch 1A:** historical v1 one-time freeze and
   divergence-reporting behavior (Rubrist ADR-0006).
3. **Resolved:** the simultaneous blocking-failure plus mandatory-incomplete
   precedence table is fixed in Dailies ADR-0005.
4. **Resolved for Batch 5A:** calibration transport, canonicalization, and
   compatibility are fixed by Rubrist ADR-0009 as a separate artifact v1;
   assessment receipt v1 remains unchanged.
5. Independent owners, sampling frames, budgets, and stopping rules for the two
   comparative benchmarks.
6. **Resolved:** deprecated product-release writes remain through the Dailies
   v4 migration and become `410 Gone` in Batch 2; historical reads remain.
   The evaluator-version regression gate remains in Rubrist (Rubrist ADR-0006).
7. **Resolved for Batch 4:** the collection, independent-review, abstention,
   resolution, selection, and separation-of-duty plan for the first genuinely
   sealed validation revision is fixed by Rubrist ADR-0008.
8. **Resolved for Batch 1C:** ownership and isolation of the neutral benchmark
   workspace is fixed by Casefile ADR-0002; comparator execution never becomes
   Casefile product behavior.
9. **Resolved for Batch 2:** the directional compatibility, declassification,
   sealed-successor, exact-input identity, and public sealed-intake boundary
   are fixed by Rubrist ADR-0007.
10. **Resolved for Batch 6:** representative finite-frame sampling,
    append-only open coding, flat taxonomy revision, failure-code promotion,
    candidate evaluator lifecycle, and honest component measurements are fixed
    by Rubrist ADR-0010.
11. **Resolved for Batch 7:** record persistence, ingest key capabilities,
    report snapshots, retention, and erasure for production outcome
    monitoring, which Rubrist's `PRODUCT.md` places in its charter, are fixed
    by Rubrist ADR-0013.
12. **Resolved for Batch 8:** Rubrist ADR-0014 fixes these parts of
    model-agnostic evaluator execution:
    - exact bindings;
    - capability resolution;
    - versioned verdict protocols;
    - the shared failure taxonomy;
    - `assessment-receipt/v2`, `binary-calibration/v2`,
      `evaluator-suite-manifest/v2`, and `skill-format/v2`;
    - typed-question evaluators.

Resolve each in the contract phase of its owning batch before runtime code.
