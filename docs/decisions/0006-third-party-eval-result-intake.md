# ADR-0006: Third-party eval-platform result intake

Status: **Proposed**

Date: 2026-09-22

## Context

Teams that already run Promptfoo, DeepEval, or Braintrust want to adopt
Dailies as their release gate without first replacing their eval platform.
CURRENT Dailies has two ways to reach such a team: wrap the platform behind the
generic HTTP judge, or rebuild the evaluation around exact-match or Coeval
evidence. The first is visibly self-reported per ADR-0001; the second is a
migration, not an on-ramp.

The obvious shortcut is a result adapter that parses the platform's own output
file (for example Promptfoo `eval -o results.json`, a DeepEval test-run JSON,
or a Braintrust experiment summary/export) into Dailies per-case evidence. The
accepted ADRs settle part of that question and leave the rest open.

### What the accepted ADRs already settle

- **Trust class is `self_reported` (ADR-0001).** `verified` requires "a
  versioned evidence contract [that] is independently verified, including
  identity, provenance, completeness, and digest semantics." None of these
  platforms emits such a contract that Dailies can verify. A SHA-256 over the
  output file proves which bytes Dailies read; it does not verify who produced
  the results, which candidate outputs were judged, or that the file is
  complete. `deterministic` requires reproducing the result "locally from
  identified inputs and an identified deterministic evaluator"; platform
  assertions include model-graded and arbitrary-code checks that Dailies
  cannot re-run, and Dailies "never silently upgrades one class to another."
- **Running the tool does not change the class.** If Dailies itself executed
  `promptfoo eval -o results.json` and digested the file, the result would
  still be a third-party tool asserting pass/fail without a verifiable
  envelope. Execution ownership (ADR-0002) is about lifecycle and retry
  accountability, not evidence provenance.
- **Admissibility (ADR-0001, ADR-0005).** Such evidence is inadmissible by
  default and participates in a decision only through a visible customer
  override with a reason. The report keeps the class and the override.
- **Integrity (ADR-0005 row 1).** An unreadable file, unknown platform schema
  version, digest mismatch, or unmapped required case is an evidence-channel
  integrity failure and yields `inconclusive`, never a fabricated block or
  pass.

### What the accepted ADRs do not settle

1. **Candidate execution ownership (ADR-0002, charter principle 5).** Dailies
   "owns ... candidate and baseline execution" and "the stable mapping from
   release item to evidence-provider item." A platform result file bundles
   candidate execution and judging that Dailies did not perform or observe.
   Consuming it means Dailies coordinates, rather than executes, the candidate,
   and cannot separate candidate failure (ADR-0005 row 2, `block`) from judge
   or harness failure (row 1, `inconclusive`) using its own operation ledger.
   No accepted ADR says whether, or under which report semantics, that is
   allowed.
2. **Scope identity (ADR-0003).** CURRENT scope identity is the exact bytes of
   a Dailies JSONL file. A platform result file carries its own test set,
   variables, and ordering. Whether the declared scope is the Dailies JSONL
   (with a strict ID mapping), the platform's embedded test set, or both is not
   decided.
3. **Score-to-outcome mapping (ADR-0004).** DeepEval and Promptfoo emit
   per-case success booleans computed from thresholds configured in the
   platform; Braintrust primarily emits continuous scores. Taking the
   platform's `success` bit imports platform-side release policy; re-applying a
   Dailies threshold to a score needs an explicit per-criterion unit and rule.
   Repeated trials (Promptfoo `repeat`, Braintrust trials) need a declared
   ADR-0004 trial rule.
4. **Relation to decision gate 5.** `PLAN.md` states that "no comparator
   adapter, runtime, result, or claim belongs in the repository" while gate 5
   is open. That sentence targets the comparative benchmark, but a
   Promptfoo/DeepEval parser in this repository is close enough to it that the
   boundary should be stated explicitly rather than inferred.

## Options

**A. Status quo.** Document the generic HTTP judge as the only on-ramp. A team
writes a small service that calls its platform per item. No new semantics;
high adoption friction; still `self_reported`.

**B. Import-only result adapters (recommended).** Add a new additive
configuration and report generation with an `evidence.kind` of
`promptfoo-results`, `deepeval-test-run`, or `braintrust-experiment`, each
pinned to an exact local file digest and an explicitly supported platform
schema version. Proposed semantics:

- trust class is fixed to `self_reported` by the adapter kind and cannot be
  configured or asserted by the file;
- the report records a distinct execution mode, `imported`, in which Dailies
  attests only to the bytes it read and records the candidate as producer
  asserted; no candidate operation ledger is fabricated;
- the declared scope remains the digest-pinned Dailies JSONL; every JSONL `id`
  must map to exactly one platform case by an explicitly configured exact key,
  with no fuzzy or positional matching; missing, duplicate, or extra required
  cases are incomplete evidence;
- each platform metric maps to a named Dailies criterion. The customer chooses
  per criterion whether to accept the platform's success bit (recorded as
  imported platform policy) or apply a Dailies threshold to a declared score
  unit; repeated trials require an ADR-0004 trial rule;
- a platform error, unknown schema version, or unmapped required case is an
  integrity failure and yields `inconclusive`; a case whose candidate errored
  inside the platform is also `inconclusive`, because Dailies cannot attribute
  it to the candidate; and
- the adapters are evidence intake only. They never execute a platform, never
  produce comparative results, and cannot support a comparative claim while
  gate 5 is open.

**C. Dailies-executed platform run.** Dailies runs the platform CLI under its
release-run deadline and then applies option B to the produced file. This adds
ADR-0002 execution ownership (single submission of a non-idempotent run,
deadline, cancellation) and a local command-execution surface, but does not
change the trust class. Defer until B has demand evidence.

**D. Verified third-party evidence.** Define or adopt a versioned, signed
evidence envelope that a platform or a neutral exporter emits and Dailies
verifies. This is the only path to `verified`; it requires producer
cooperation and a separate contract ADR.

## Recommendation

Accept option B as the next additive generation, keep option C deferred, and
treat option D as a separate future contract. Record explicitly that
third-party result intake is `self_reported`, inadmissible without an
override, never upgraded by Dailies' own digest or execution, and distinct
from gate-5 comparator work.

## Consequences if accepted

- Existing platform users can see a scope-bound, trust-labelled Dailies report
  over results they already have, which makes the self-reported gap visible
  rather than hidden.
- A new config/report version, fixtures, and adversarial tests are required
  before runtime code, following the regular batch flow.
- Platform output formats are external and change without notice. Each
  supported version must be pinned, and field-level mappings documented from
  the platform's own documentation or captured artifacts, stating which.

## Until accepted

No runtime behavior, configuration kind, report field, or example that depends
on this ADR may be added. The CURRENT on-ramp is option A.
