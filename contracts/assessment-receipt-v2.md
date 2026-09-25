# Assessment receipt v2 digest and conformance specification

This document is normative for Rubrist assessment receipt v2 alongside
`assessment-receipt-v2.schema.json`. The schema defines structure; this
document defines canonical bytes, digests, and the semantic rules a
structurally valid receipt must also satisfy. Rubrist ADR-0014 section 7
decides the contract. Receipt v2 replaces receipt v1 (ADR-0014 decision 6);
the v1 documents are deleted with the v1 code, and at the launch baseline
this contract takes the v1 name (decision 7).

## Canonical JSON and digests

Canonical JSON is the same as in receipt v1. It accepts JSON values only and
serializes `null`, booleans, strings, and finite numbers exactly as
ECMAScript `JSON.stringify` does, which is the RFC 8785 string and number
representation. Arrays keep their order. Object keys are sorted recursively
by exact UTF-16 code unit order, with no insignificant whitespace and no
locale-aware sorting. A digest is SHA-256 over the UTF-8 bytes of that
canonical JSON, written as `sha256:` followed by 64 lowercase hexadecimal
characters.

- `contentDigest` hashes `{ "input": input, "output": output }` from the
  submitted JSON values, before import normalization or redaction.
- Items are sorted by exact `clientItemId` code unit order.
- `datasetDigest` hashes the ordered array of
  `{ "clientItemId": clientItemId, "contentDigest": contentDigest }`.
- `evidenceDigest` hashes the complete receipt with only the
  `evidenceDigest` member omitted.
- `evaluator.definitionDigest` hashes the evaluator definition object. The
  definition itself is not in the receipt; `skill-format/v2` carries it and
  defines its shape, and both vectors below carry one. A typed-question
  definition holds its question as `question.digest`, the digest of the
  canonical object `{ "type": "noul", "instructions": ..., "criteria":
  { "true": ..., "false": ... } }`.
- `skillDigest` hashes the `evaluator` object:
  `{ "basis": "rubrist/evaluator-identity/v2", "definitionDigest": ...,
  "executionBinding": ... }`. A verifier recomputes it from the receipt
  alone and needs the definition only to check `definitionDigest`.

Every string is a sequence of Unicode scalar values; a lone surrogate is
refused anywhere in the receipt, keys included. JSON Schema can't express
that, so runtime validators check it. Model ids and versions are at most 240
UTF-16 code units. JSON Schema's `maxLength` counts code points, so
producers must stay within both. Every integer is at most 2^53 − 1. No object
has a `__proto__` key, which many JSON parsers would silently drop. A receipt
has at least one item.

A stored or served copy is exactly the UTF-8 bytes of the canonical JSON,
with no byte-order mark.

## Evaluator and execution binding

The receipt carries the execution binding and the definition digest, never
rubric, prompt, or question text. Every setting in the binding is present,
and `null` means it was not sent. The schema encodes the binding's rules:

- the verdict protocol belongs to the provider family;
- a `custom` provider names a custom endpoint by digest, an `openai`
  binding may name one for a platform base-URL override, and every other
  provider is `managed`;
- only `openrouter` bindings have routing, and they must;
- the reasoning shape matches the provider family, and `typesafe` and
  `mock` have none;
- Anthropic bindings have an output token limit;
- `typesafe` and `mock` bindings send no sampling settings or token limit;
- OpenRouter reasoning states an effort or a token budget, not both, and
  neither when it is disabled.

## Items

Each item has exactly one `result`: an outcome (`pass`, `fail`, or
`abstain`), a failure with one closed `failureKind`, or `not_attempted`.
An abstention is never a failure, and a failure is never an abstention.
Receipts carry no rationale.

- `verdictId` is present exactly when the item has an outcome.
- `evaluatorScore` is recorded only with an outcome. Its `kind` is
  `native_probability` for `typed-question/v1` and
  `self_reported_score` for every other protocol. Neither is calibrated.
- A `typed-question/v1` outcome is `pass` or `fail` and always has a
  score.
- `observed` is `null` exactly when the item was not attempted. Its fields
  are `null` when the provider didn't report them.
  `observed.upstreamProvider` is recorded only for OpenRouter bindings.

## Counters and completeness

`run.totalItems` equals the number of items, and the pass, fail, abstained,
failed, and not-attempted counters equal the items in each state.
`run.agreedItems` is at most `passItems + failItems`.

A receipt is `complete` exactly when `run.status` is `completed` and every
item has an outcome. An abstention is an outcome, so it leaves the receipt
complete. It lowers coverage, which is `(passItems + failItems) / totalItems`.
Any failure or `not_attempted` item makes the receipt `incomplete`.

## Consumer checks

A structurally valid receipt is trusted only after every rule above passes.
A consumer that holds the submitted candidates also checks exact
`clientItemId` coverage and each `contentDigest`. A consumer that holds a
suite manifest checks `skillDigest` against the manifest member's, and
checks the expected `evalRunId` and `skillVersionId`.

## Portable fixtures

- `fixtures/assessment-receipt-v2.complete.json`: a prompted evaluator on the
  seeded default binding, with a pass, a fail, and an abstention. The receipt
  is complete. The vector also carries the definition and the candidates.
- `fixtures/assessment-receipt-v2.incomplete.json`: a typed-question
  evaluator on a canceled run, with an outcome, a timeout, and an item that
  was not attempted. The vector also carries the definition, the question
  text, and the candidates.
- `fixtures/assessment-receipt-v2.conformance.json`: the mutation corpus.

Each corpus case starts from its `baseFixture`, or the corpus's, and applies
its mutations in order:

- `add`, `replace`, and `remove` target an RFC 6901 JSON Pointer. `add` and
  `replace` create an own member, even for a `__proto__` key, as `JSON.parse`
  does;
- `reverse` reverses the target array;
- `recompute-dataset-digest`, `recompute-skill-digest`, and
  `recompute-evidence-digest` apply the algorithms above to the current
  mutated receipt.

`structural` states the required result from both JSON Schema and runtime
schema validation. `semantic` states the required result after structural
acceptance, using the case's optional expected identities
(`expectedEvalRunId`, `expectedSkillVersionId`, `expectedSkillDigest`).
Positive controls catch over-tightening as well as under-validation.

The pinned SHA-256 file digests are:

- schema: `701aed7aa5931fad30e876ce3e075c7b3d4de992e0b5eb4537ed26d26c5b7826`;
- complete fixture:
  `23b972a1ba9e78c5ea074ea9fb9abf7df74c108c8a58d14f473ee82d910e00eb`;
- incomplete fixture:
  `bdfb4378c78410274a78cf6f7545ed7440e10b67693161a0c211123e10f317b0`;
- conformance corpus:
  `f9269a1b5d35fa76ddb05a9d47d3722c7abc121d5437237c3e3fb0dba0f54432`.
