# ADR-0008: Consume Rubrist v2 evidence and restart at a v1 launch baseline

Status: **Accepted**

Date: 2026-09-25

Decision owner: Luka Živković (founder).

## Context

Rubrist ADR-0014 (`docs/decisions/0014-model-agnostic-evaluator-execution.md`
in the Rubrist repository) replaces the Rubrist evidence contracts Dailies
consumes:

- `rubrist/assessment-receipt/v2` replaces receipt v1. It carries the
  evaluator's execution binding and a definition digest, one outcome, failure,
  or `not_attempted` result per item, and a recomputable `skillDigest`.
- `rubrist/binary-calibration/v2` and its private ledger v2 replace
  calibration v1.
- `rubrist/evaluator-suite-manifest/v2` replaces manifest v1. Its members
  carry the v2 `skillDigest`.

ADR-0014 decision 6 removes v1/v2 coexistence, because no product has users
yet. Decision 7 removes version history before launch: when Rubrist's
Batch 8 is complete, every contract and format in Rubrist, Dailies, and
Casefile restarts at v1.

Dailies owns contracts that name the Rubrist v1 evidence:

- report v4 and report v5 embed receipt v1 and re-verify it, and name the
  `rubrist_receipt_v1` evidence kind;
- report v6 names the `rubrist_binary_calibration_v1` evidence kind and
  verifies calibration v1;
- configuration v5 and v6 pin a manifest v1;
- `parseReportForInspection` still reads historical v3 reports, and one
  captured v3 fixture embeds a receipt v1.

As in ADR-0007, there are no external consumers of these contracts.

## Decision

The founder decided on 2026-09-25 that Dailies needs neither version history
nor backward compatibility before launch, and should take whatever path gives
the best end state.

1. **Add v2 verification now (Rubrist Batch 8A).** Dailies vendors Rubrist's
   receipt v2, calibration v2 with its private-ledger v2 commitment rules, and
   manifest v2 byte-identically, with their conformance corpora, and verifies
   them independently. Nothing in Dailies consumes them yet, because Rubrist
   emits v1 until its Batch 8D.
2. **Switch in place, in the same window as Rubrist's 8D.** Configuration v4
   to v6 and report v4 to v6 change in place:
   - their Rubrist evidence is v2;
   - the evidence kinds become `rubrist_receipt_v2` and
     `rubrist_binary_calibration_v2`;
   - every v1 Rubrist verifier, vendored v1 contract, and v1 fixture is
     deleted.

   Dailies adds no new format version for this, because the launch baseline
   renumbers every format anyway.
3. **Remove v3 report inspection now.** `parseReportForInspection` stops
   reading v3 reports, and the captured v3 fixtures are deleted.
4. **Restart at v1 with Rubrist's launch baseline (Batch 8G).** Every
   versioned identifier in Dailies restarts at v1: configuration and report
   versions 4 to 6, release policy v2, and the `rubrist_receipt_v2` and
   `rubrist_binary_calibration_v2` evidence kinds, which return to `_v1`
   names; the vendored Rubrist contracts take their v1 names. The
   single-criterion, suite, and calibration-aware formats can't all share
   one version number while they stay separate, and both configuration
   loading and `parseReportForInspection` choose a format by version, so a
   recorded Dailies decision on keeping or consolidating them comes before
   8G. No product capability is removed without the founder's decision.

## Consequences

- Reports produced before the switch can no longer be inspected. This is
  acceptable only because no external report exists before launch.
- Until Rubrist's 8D, Dailies carries both the v1 verifiers it uses and the
  v2 verifiers it has vendored. That overlap ends in the switch.
- The rules that aren't about compatibility stay: verification is
  independent of Rubrist's runtime, bytes are pinned by digest, and every
  evidence contract is closed.
- This decision supersedes, before launch only, ADR-0007's in-place
  identifiers for the Rubrist evidence kinds, and ends historical inspection
  of v3 reports.
