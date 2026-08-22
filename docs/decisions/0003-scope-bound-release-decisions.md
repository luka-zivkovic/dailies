# ADR-0003: Scope-bound release decisions

Status: **Accepted**

Date: 2026-08-22

## Context

A curated regression corpus, a sealed representative evaluation, a production
sample, and a manual review set answer different questions. A successful gate
over one of them does not justify a broader quality or safety claim. If scope
is absent from a report, `promote` can be misread as universal approval.

## Decision

Every evidence set used in release policy has a declared scope. The scope
records at least:

- scope kind: regression corpus, sealed representative evaluation, production
  sample, manual review set, or a future versioned kind;
- immutable dataset or sample identity;
- collection or sampling procedure and applicable population;
- relevant time window for sampled evidence;
- expected and observed coverage; and
- exposure or review provenance supplied by the evidence producer.

A Dailies decision is read as:

> This candidate satisfies policy P on evidence scope S.

When policy requires several scopes, Dailies retains the result for each scope
and records the explicit combination rule. It never silently pools them into a
broader population or lets a favorable regression set stand in for production
sampling. Missing or unverifiable evidence for a required scope yields
`inconclusive`; a known policy failure on complete admissible evidence yields
`block`.

The initial CLI's historical JSONL input is treated as a regression-corpus
wedge during migration, but target reports must identify scope explicitly.

## Consequences

- Release claims become precise and auditable.
- Teams can require regression, sealed validation, and production evidence
  together without pretending they are interchangeable.
- Dataset representativeness remains an evidence-producer claim that Dailies
  preserves and subjects to policy; Dailies does not manufacture it.
- Production sampling execution can remain demand-gated while the scope
  contract is implemented first.
