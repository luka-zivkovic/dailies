# PLAN

> Named **greenroom** (2026-08-12): the greenroom is where a performer waits and rehearses before being allowed on stage — shadow evaluation before promotion.

## Thesis

**CI/CD for model behavior.** Teams ship AI changes — prompt edits, model swaps, config tweaks — with less rigor than they ship code, because the failure mode isn't a compile error, it's a behavior regression that no existing pipeline can see. The release layer makes shipping an AI change as disciplined as shipping code: every candidate change is evaluated in shadow against real traffic, judged against the production baseline, and promoted through explicit, reversible stages.

The full product is two halves:

- **Control plane (hosted):** rollout definitions, judge-gate configs, the promotion state machine (`shadow → 1% → 10% → 100%`), and auto-rollback rules. It holds the desired state of every AI release and the evidence that justified each promotion.
- **Customer-side data plane:** SDK middleware or a sidecar running inside the customer's infrastructure. It enforces the rollout spec from a locally-cached copy (no hard runtime dependency on us) and asynchronously mirrors traffic to shadow candidates. **Never a hosted proxy.** Customer traffic, prompts, and outputs do not flow through our servers on the serving path — that is both a latency/availability non-starter and a trust non-starter for the customers we want.

## Judge-agnostic gate contract

Promotion decisions are delegated to a judge behind a minimal HTTP contract:

```
POST /judge
{ "input": ..., "candidate_output": ..., "baseline_output": ... }   // baseline_output optional
→ { "score": number, "pass": boolean, "reason": "optional string" }
```

- **Coeval is the first-class judge** — it already owns rubric-based evaluation — but the contract is deliberately pluggable: any endpoint that speaks it can gate a rollout (in-house judges, other eval vendors, a regex).
- **Trace-store-agnostic** on the input side: historical inputs can come from anywhere. **Ironside is first-class** — pull replay inputs via its raw-events endpoint, and write shadow results back tagged with the `environment: 'shadow'` convention so shadow traffic never pollutes production analytics.

## v0 wedge (built now): greenroom CLI

A standalone CLI: **run a candidate against historical inputs, judge candidate vs. production, emit a promote/block report.**

- No serving-path changes, no SDK integration, no hosted anything. A team can adopt it in an afternoon.
- It exercises the two contracts that matter (judge gate, replay inputs) so the interfaces are proven before the expensive parts exist.
- **The CLI is itself the demand probe.** Usage of the manual loop is the signal that the automated loop is worth building.

## Build trigger for the full product

The control plane + data plane (canary percentages, auto-rollback, promotion state machine) is **demand-gated and not built now**. Build it when **≥3 design partners** are either (a) running the manual greenroom loop as part of their real release process, or (b) explicitly asking for auto-blocking / staged rollout. Until then, every feature request routes back to making the CLI loop sharper.

## Why standalone (not a feature of Ironside or Coeval)

- **Ironside must stay a passive record.** The moment the trace store can block or mutate deployments, it stops being the neutral system of record customers trust it to be.
- **Coeval must stay judge-not-deployer.** A judge that also executes promotions has a conflict of interest baked into its product; separation is what makes its verdicts credible.
- The release layer is the actor that *consumes* both: reads history from the record, asks the judge for verdicts, and owns the deployment consequences. Three roles, three products, clean trust boundaries.
