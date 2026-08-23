# Authored invariant robustness gate v1

Status: **CURRENT internal correctness gate**

Last reviewed: 2026-08-23

This suite is an authored Dailies regression corpus. It tests whether the
current release engine preserves its declared safety and decision invariants
under deterministic local faults. It is **not independent evidence**, is
**never competitor evidence**, and cannot support a Promptfoo, DeepEval, or
other comparative claim.

Decision gate 5 in [`implementation-batches.md`](implementation-batches.md)
remains unresolved. The suite installs no comparator, contains no comparator
adapter, executes no comparator, and does not define a comparative study's
owners, sample, budget, or stopping rule.

## Contracts

[`src/robustness.ts`](../src/robustness.ts) defines three closed additive
contracts:

- `dailies/authored-release-invariant-scenario/v1` records one authored fault,
  a portable safety oracle, and the exact Dailies terminal, decision,
  precedence, CLI exit-code/process-signal, evidence-state, typed-observation,
  error-kind, call-count, report-validation, and concurrency oracle. Exit code
  is `null`/not applicable for non-CLI seams.
- `dailies/authored-release-invariant-outcome/v1` retains the native result,
  normalized release signal, raw artifact/stdout/stderr hashes and lengths,
  runtime sample, independently derived checks, and a semantic digest.
- `dailies/authored-release-invariant-run/v1` binds exact ordered scenario and
  trial coverage to source/runtime/isolation identity, per-scenario runtime
  distributions, determinism, and a derived gate summary.

Every object is labeled:

```text
evidenceClass: authored_correctness_only
comparativeClaim: forbidden
```

The portable safety oracle uses only:

- `release_allowed`;
- `release_denied`; or
- `insufficient_evidence`.

The normalized observed signal keeps `proceed`, `do_not_proceed`,
`no_decision`, and `aborted` distinct. An abort therefore cannot be presented
as an inconclusive Dailies report or silently credited as an ordinary block.

## Verification and gate

`verifyAuthoredInvariantRun` treats retained native observations, execution
evidence, durations, and raw hashes as audit inputs; hashes cannot recreate a
process or network exchange. It never trusts claims derived from those inputs. It
recomputes:

- canonical scenario order, scenario-set digest, and exact scenario/trial
  coverage;
- each outcome's scenario binding, normalized observation, false-promotion
  flag, exact oracle checks, and semantic digest;
- runtime min/p50/p95/max distributions;
- semantic determinism and required completion-order perturbation across repeats; and
- every summary count and the final `passed` value.

The gate passes only when all trials have:

- zero false promotions and false blocks;
- the exact expected terminal, decision, precedence, applicable CLI exit
  code/process signal, evidence
  state, observation class, and error kind;
- exact candidate and external evidence-provider call counts;
- the required measured maximum in-flight work and distinct completion orders;
- the expected valid report or expected absence/rejection; and
- one semantic outcome across repeated deterministic trials.

Raw hashes, runtime samples, and completion-order evidence are deliberately
excluded from the semantic digest. CLI reports contain wall-clock timestamps
and temporary output paths, and scheduling order is intentionally perturbed,
so changing operational evidence remains auditable without being mistaken for
a release-semantic change. The two fixed seeds are repeated operational
perturbations, not IID samples and not an uncertainty or seed-variance claim.

A false promotion is `proceed` when the safety oracle is not
`release_allowed`. A false block is `do_not_proceed` when the safety oracle is
`release_allowed`; conservative `no_decision` and preflight `aborted` remain
separate and must still satisfy their exact authored oracle.

## Current authored matrix

The executable gate composes real supported v4 runner and packaged CLI paths,
the strict report parser, and the v5/v6 pure policy functions. It covers all
Batch 6 internal families:

| Family | Current cell |
| --- | --- |
| control | packaged v4 CLI with deterministic passing evidence |
| timeout | bounded permanent candidate and HTTP-judge timeouts |
| transport | bounded candidate/judge transport failures and judge HTTP 503 |
| protocol | malformed successful candidate and judge payloads |
| partial coverage | threshold slack with required judge incompleteness |
| tamper | input-digest preflight rejection and report decision mutation |
| mixed trust | the same complete self-report denied and explicitly admitted |
| scope mismatch | exact input/scope identity mismatch before execution |
| nondeterminism | seeded, out-of-order concurrent completion with stable semantics |
| multi-criterion conflict | applicable v5 precedence including compensation failure, plus v6 own-calibration incompleteness and integrity against another valid block |

This matrix supplements the larger focused test corpus for receipt retries,
operation ledgers, manifest/calibration identity swaps, report mutation,
repeated calibration trials, and configuration closure. It does not replace
those tests.

## Execution and output

```sh
npm run invariant:batch6
```

The command builds Dailies, runs every scenario twice with fixed seeds, emits
the verified run artifact as JSON on stdout, emits a non-comparative label and
short summary on stderr, and exits nonzero when the derived gate fails.

The harness removes credential-like and proxy environment variables before
execution, assigns a fresh temporary cache directory, and rejects every
configured HTTP endpoint that does not use literal `127.0.0.1` or `[::1]`.
The run records the measured
removed-variable and validated-endpoint counts. This is a configured-endpoint
constraint, not a claim that an operating-system network sandbox was active.
It configures no external model. The run records Dailies/package/source-tree identity,
Node version, platform, architecture, CPU model/count, raw evidence hashes,
and per-scenario runtime distributions. Runtime is diagnostic environment-bound
data, not a performance claim. Outside a Git checkout, source revision is
recorded as `unavailable` and source-tree state as `unknown`; a checkout with
local changes is recorded honestly as `dirty`.

## Explicit boundary before comparative work

The authored cases are visible to Dailies implementers and live beside the
implementation. They cannot be reused as blind evidence of superiority. A
future comparative study must wait for decision gate 5, use an independently
owned neutral workspace, preregister applicable shared scenarios and
normalization, freeze tool/config/environment versions and budgets, keep
`not_applicable` out of scored denominators, and execute sealed matched draws
under a fixed stopping rule.
