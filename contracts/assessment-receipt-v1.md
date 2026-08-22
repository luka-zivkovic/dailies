# Assessment receipt v1 digest and conformance specification

This document is normative for Coeval assessment-receipt v1 alongside
`assessment-receipt-v1.schema.json`. The schema defines structure; this
document defines canonical bytes and semantic linkage.

## Canonical JSON and digests

Canonical JSON accepts JSON values only. It serializes `null`, booleans,
strings, and finite numbers exactly as ECMAScript `JSON.stringify` does. This
is the RFC 8785 string/number representation: control characters are escaped,
non-ASCII characters are otherwise emitted without Unicode normalization, and
finite numbers use ECMAScript's shortest round-trippable spelling. Arrays
retain their existing order. Object keys are sorted recursively by exact
UTF-16 code unit order, equivalent to JavaScript string `<` and `>`
comparisons, then serialized without insignificant whitespace. No locale-aware
sorting is applied.

A digest is SHA-256 over the UTF-8 bytes of that canonical JSON, rendered as
`sha256:` followed by 64 lowercase hexadecimal characters.

- `contentDigest` hashes `{ "input": input, "output": output }` from the
  submitted JSON values before import normalization or redaction.
- Receipt items are sorted by exact `clientItemId` code-unit order.
- `datasetDigest` hashes the ordered array of
  `{ "clientItemId": clientItemId, "contentDigest": contentDigest }` objects.
- `evidenceDigest` hashes the complete receipt object with only the
  `evidenceDigest` member omitted.
- `skillDigest` hashes the governed skill descriptor containing
  `rubricMarkdown`, `prompt`, `modelBinding`, `outputSchema`,
  `verdictKind`, `scalarRange`, and `categoricalChoiceScores`. Optional
  members that are absent from the descriptor remain absent.

Receipt semantics additionally require unique, exactly covered client item
identities, matching content digests, consistent run counters, and a pinned
`evalRunId` and `skillVersionId`. A structurally valid receipt is not trusted
until those checks pass.

## Portable fixtures

`fixtures/assessment-receipt-v1.complete.json` is the positive
interoperability vector.
`fixtures/assessment-receipt-v1.conformance.json` is the portable mutation
corpus. Each case starts from `baseFixture` and applies its mutations in order:

- `add`, `replace`, and `remove` target an RFC 6901 JSON Pointer;
- `reverse` reverses the target array;
- `recompute-dataset-digest` and `recompute-evidence-digest` apply the
  algorithms above to the current mutated receipt.

`structural` states the required result from both JSON Schema and runtime
schema validation. `semantic` states the required result after structural
acceptance, using the case's optional expected identities. The corpus includes
positive controls so accidental over-tightening is detected as well as
under-validation.

The pinned SHA-256 file digests are:

- schema: `ca18a7b3bfa4610ff56ab88d60044f4357df2d035ac5e072356becc20250e9e7`;
- positive fixture:
  `530e7322feb5bc16d025daaef14bec8d73488a168a602d82b37fae2a06d12274`;
- conformance corpus:
  `9a9ba86d54e78a6cc8d63d592712791f21984e68f09bbbe011d8903296af3e07`.
