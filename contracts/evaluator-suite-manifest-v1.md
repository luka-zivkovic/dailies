# Evaluator suite manifest v1 specification

This document is normative for `coeval/evaluator-suite-manifest/v1` alongside
`evaluator-suite-manifest-v1.schema.json`. The manifest is an immutable,
policy-free grouping of separately judged criteria. It is not an assessment
receipt and does not change `coeval/assessment-receipt/v1`.

## Boundary

One manifest member binds one immutable criterion definition to one exact
evaluator version. Member order is meaningful and participates in manifest
identity. A suite may later group separate criterion receipt-v1 artifacts, but
the manifest never collapses them into a score or decision.

The following concepts are forbidden from v1 at every manifest level:
release thresholds, weights, mandatory/advisory/blocking/compensatory roles,
composite scores, promotion or blocking decisions, rollout state, and
overrides. Strict objects and `additionalProperties: false` make those fields
structurally invalid rather than ignored.

## Member fields

Each member contains exactly:

- `position`: zero-based, contiguous array position;
- `criterionId`: stable criterion identity;
- `criterionVersionId`: exact immutable definition revision;
- `criterionName` and `criterionDefinition`: the human-readable definition
  whose bytes participate in identity;
- `criterionDigest`: SHA-256 identity defined below;
- `skillId` and `skillVersionId`: the exact Coeval evaluator lineage/version;
- `skillDigest`: the existing assessment-receipt-v1 evaluator digest;
- `outputContractDigest`: a separate digest of the evaluator's output
  contract; and
- `applicability`: exactly `{ "kind": "all_items" }` in v1.

`criterionId`, `criterionVersionId`, and `skillVersionId` must each be unique
inside a manifest. The array must contain each member exactly once, with
`member.position === its array index`.

## Trial plan

`trialPlan` is required and is either:

- `null`, meaning one assessment per member over every item; or
- `{ "kind": "independent_repetitions", "trialsPerItem": N }`, where `N`
  is an integer from 2 through 10.

Independent repetitions remain distinct criterion assessments. The plan does
not define averaging, voting, thresholding, compensation, or any other
aggregation rule.

## Canonical JSON

All identities use the same canonical JSON algorithm as assessment receipt
v1:

1. object keys sort lexicographically at every depth;
2. arrays retain their declared order;
3. JSON primitives use `JSON.stringify` representation;
4. object properties whose value is `undefined` are omitted; and
5. unsupported or non-finite values fail rather than being coerced.

Exact canonical artifact bytes are UTF-8 bytes of the complete canonical
manifest, including `manifestDigest`. A byte-level reader must reject invalid
UTF-8, non-JSON, and valid JSON that is not in canonical form.

## Digests

All digests use lower-case SHA-256 with the `sha256:` prefix.

`criterionDigest` is SHA-256 over canonical JSON of:

```json
{
  "criterionId": "...",
  "criterionVersionId": "...",
  "criterionName": "...",
  "criterionDefinition": "..."
}
```

`outputContractDigest` is SHA-256 over canonical JSON of the source evaluator
version's:

```json
{
  "outputSchema": {},
  "verdictKind": "binary",
  "scalarRange": null,
  "categoricalChoiceScores": null
}
```

`skillDigest` is frozen by assessment receipt v1 and remains SHA-256 over
canonical JSON of exactly these existing fields:

```text
rubricMarkdown
prompt
modelBinding
outputSchema
verdictKind
scalarRange
categoricalChoiceScores
```

Criterion or suite fields never enter `skillDigest` and never enter receipt
v1.

`manifestDigest` is SHA-256 over canonical JSON of the complete manifest with
only `manifestDigest` removed. It therefore covers contract and schema
versions, artifact identities, revision, declared ordering, every criterion
and evaluator binding, applicability, and the trial plan.

## Verification

Structural schema acceptance is necessary but not sufficient. A verifier must:

1. require contiguous positions and unique criterion/evaluator identities;
2. recompute every `criterionDigest`;
3. recompute `manifestDigest`;
4. compare `manifestId` and `manifestDigest` with the identity expected by the
   caller; and
5. compare the exact ordered member set expected by the caller.

Step 5 detects a self-consistent but unexpected manifest whose author
recomputed its digests after reordering, removing, substituting, duplicating,
or adding a criterion. Unknown criteria are rejected; they are never ignored.

When criterion assessment receipts are supplied later, each expected member
and independent trial must have exactly one separately verified receipt v1.
The receipt's `skillId`, `skillVersionId`, and `skillDigest` must match its
manifest member. With v1 `all_items` applicability, criterion receipts for the
same trial must also cover the same submitted dataset identity. Missing or
failed evidence remains attributable to that criterion and is never repaired
by another member.

## Compatibility

Manifest v1 is closed. New applicability kinds, trial semantics, member
fields, or policy concepts require a new contract version and compatibility
window. Receipt v1 remains a separate closed contract: its schema, exact
bytes, digest basis, persistence, and historical verification are unchanged.

