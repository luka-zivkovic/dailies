# ADR-0007: Rename consumed Coeval identifiers to Rubrist

Status: **Accepted**

Date: 2026-09-22

## Context

Dailies consumes governed assessment evidence from the evidence provider
previously named Coeval. On 2026-09-22 the owner renamed that product
**Rubrist** after a name conflict was found with Coval (coval.ai), a funded
AI-evaluation company. The rename is recorded upstream in Rubrist ADR-0012
(`docs/decisions/0012-rename-coeval-to-rubrist.md` in the Rubrist repository)
and is applied in lockstep here.

The product name is part of identifiers that Dailies both vendors and exposes:
the vendored contract IDs, the canonicalization version, the judge/provider
kind in configuration, the evidence kinds recorded in reports, and the
TypeScript API. Neither product has launched and there are no external
consumers of these identifiers.

## Decision

Dailies applies the portfolio's case-preserving global rule
(`Coeval` → `Rubrist`, `coeval` → `rubrist`, `COEVAL` → `RUBRIST`) to every
current identifier, document, fixture, and file name, renaming in place with
the same version numbers and without aliases for the old spellings:

- vendored contract IDs `rubrist/assessment-receipt/v1`,
  `rubrist/evaluator-suite-manifest/v1`, `rubrist/binary-calibration/v1`, and
  `rubrist/binary-calibration-private-ledger/v1`, plus
  `rubrist-canonical-json/v1`;
- the configuration judge `type` (schema v3/v4) and suite evidence provider
  `type` (schemas v5 and v6) value `rubrist`;
- report evidence kinds `rubrist_receipt_v1` and
  `rubrist_binary_calibration_v1`;
- exported TypeScript names (for example `verifyRubristReceipt`) and the
  module `src/rubrist.ts`;
- the local stub `scripts/mock-rubrist.mjs`.

Vendored `contracts/` bytes stay byte-identical to Rubrist's published
contract files. Digests derived from renamed bytes (fixture digests, pinned
file digests, example configurations) are regenerated, never hand-edited.
Past changelog entries and dated records keep their original text.

## Consequences

- Configurations and reports that spell `coeval` are no longer accepted; this
  is acceptable only because there are no external consumers before launch.
- Report and contract semantics are unchanged; only identifiers change.
- Future Rubrist contract versions continue to be vendored under the
  `rubrist/` namespace.
