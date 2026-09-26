# ADR-0010: Two formats with named identifiers at the launch baseline

Status: **Accepted**

Date: 2026-09-27

Decision owner: Luka Živković (founder).

## Context

ADR-0008 decision 4 restarts every versioned identifier in Dailies at v1
with Rubrist's launch baseline (Rubrist Batch 8G). It requires a recorded
decision first, because Dailies has three formats, each chosen by its
numeric `schemaVersion`, and they can't all be version 1 while they stay
separate:

- **single-criterion** (configuration and report 4): one `judge` of type
  `exact-match`, `http`, or `rubrist`, with pass-rate and regression
  thresholds;
- **suite** (configuration and report 5): a pinned Rubrist suite manifest
  judged by the `rubrist` provider, under release policy v1 (blocking,
  advisory, and compensatory criteria);
- **calibration-aware** (configuration and report 6): the suite format plus
  per-criterion calibration evidence, under release policy v2, which is
  policy v1 with a nullable calibration requirement per criterion. Its report
  embeds a full suite report as the candidate assessment.

The single-criterion and suite formats are different models: the suite has
no exact-match or HTTP judge, and single-criterion has no manifest or
policy. The calibration-aware format is nearly a superset of the suite: with
no calibration requirement it reaches the same decision, since its policy
hands the decision to policy v1's rules. Release policy v1 and v2 would also
collide at v1.

## Decision

The founder decided on 2026-09-27, answering two questions:

- On the formats: "Two formats: keep 'single' (today's v4, with its
  exact-match and HTTP judges) and make 'suite' = today's v6 with calibration
  optional. v5 and release policy v1 are removed."
- On identifiers: "Named identifiers: a string such as
  dailies/suite-config/v1 and dailies/suite-report/v1, matching Rubrist's
  style; loading and report inspection dispatch on the name."

So:

1. **Two formats.**
   - **Single** is today's single-criterion format, with every judge type it
     has: `exact-match`, `http`, and `rubrist`.
   - **Suite** is today's calibration-aware format, with calibration
     optional.
   - Today's suite format (configuration and report 5) is removed as a
     format. Its runner, aggregation, and decision statement remain as the
     suite's candidate assessment, which the suite report embeds.
2. **One release policy.** Release policy v2 becomes the only policy, and
   policy v1 is removed as a format.
3. **Named identifiers.** Each document declares a `contract`, which
   configuration loading, `parseReportForInspection`, the digest command,
   and the CLI dispatch on:
   - `dailies/single-config/v1` and `dailies/single-report/v1`;
   - `dailies/suite-config/v1` and `dailies/suite-report/v1`;
   - `dailies/release-policy/v1`.
4. **Evidence kinds and Rubrist contracts.** The evidence kinds return to
   `rubrist_receipt_v1` and `rubrist_binary_calibration_v1`, and the
   vendored Rubrist contracts take the v1 names Rubrist gives them in
   Batch 8G.
5. **What carries over unchanged.** ADR-0009's rule (an abstained Rubrist
   outcome counts as not passing), verification before admission, and
   decision precedence (ADR-0005).

The implementation derives these details from the decision, following the
founder's instruction to take the recommended route; they are recorded here
so they can be revisited:

- **`contract` next to `schemaVersion`.** As in Dailies' existing v1
  artifacts (`dailies/weighted-pass-rate/v1`,
  `dailies/binary-calibration-requirement/v1`, the authored-invariant
  artifacts) and every Rubrist contract, a document carries both a
  `contract` and `schemaVersion: 1`; dispatch uses the `contract`.
- **Optional calibration.** A suite configuration may leave out
  `calibrationEvidence`; that equals a null source for every criterion. A
  list that is present still covers every policy criterion in policy order.
  A criterion's `calibrationRequirement` stays an explicit value, which may
  be `null`. A criterion whose requirement is set but whose source is null
  is not release-admissible, as today (`source_not_configured`); that is a
  result of the run, not a configuration error.
- **The candidate assessment's policy.** The candidate assessment records
  the suite policy with calibration requirements left out, as today's
  projection does, but with no identifier of its own; it is versioned by
  the suite report that embeds it. Its decision statement keeps naming a
  digest of that projection.
- **Robustness seams.** The authored-invariant scenario contract stays
  `dailies/authored-release-invariant-scenario/v1` and changes in place: the
  `v4_*`, `v5_policy`, and `v6_policy` seams become `single_*`, the
  candidate assessment's policy rules, and `suite_policy`.
- **Public API names.** Exports take unversioned names for the two formats
  (for example `SuiteConfig` and `SingleReport`); today's v5 names
  (`SuiteConfig`, `SuiteReport`, `parseSuiteConfig`) move to the new suite
  format, and the candidate-assessment types are renamed to say so.

## Consequences

- One fewer format, parser, renderer, and dispatch branch; no capability is
  lost, since the suite without calibration reaches today's suite decision:
  a criterion with no requirement is `not_required` and admissible, and the
  policy's rules hand the decision to the same precedence.
- Everything that names a format follows the rename: `dailies init`, which
  writes a single configuration; the release-gate skill; the report
  documents, which become one per format; the example fixtures; and the
  digest command's result.
- Configurations and reports written before the baseline can't be read.
  This is acceptable only because no external configuration or report exists
  before launch.
- A report no longer shares its number with its configuration; the CLI
  pairs them by format.
- After launch, a format change needs a new version again; this is a
  one-time pre-launch reset.
