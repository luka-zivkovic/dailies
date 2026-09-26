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

The founder decided on 2026-09-27 to keep two formats, each declaring itself
with a named identifier:

1. **Two formats.**
   - **Single** is today's single-criterion format, with every judge type it
     has.
   - **Suite** is today's calibration-aware format, with calibration
     optional: a configuration may leave out `calibrationEvidence`, which
     means no criterion has calibration evidence bound. A criterion whose
     policy states a calibration requirement still needs its evidence.
   - Today's suite format (configuration and report 5) is removed as a
     format. Its runner, aggregation, and decision statement remain the
     suite's candidate assessment, which the suite report embeds as part of
     itself, with no identifier of its own.
2. **One release policy.** Release policy v2 becomes the only policy, and
   policy v1 is removed as a format. The candidate assessment applies the
   policy's rules without calibration requirements, as it does today.
3. **Named identifiers.** Each document declares a `contract`, as Dailies'
   authored-invariant artifacts and Rubrist's contracts already do, instead
   of a numeric `schemaVersion`:
   - `dailies/single-config/v1` and `dailies/single-report/v1`;
   - `dailies/suite-config/v1` and `dailies/suite-report/v1`;
   - `dailies/release-policy/v1`.

   Configuration loading, `parseReportForInspection`, the digest command, and
   the CLI choose a format by its contract.
4. **Evidence kinds and Rubrist contracts.** The evidence kinds return to
   `rubrist_receipt_v1` and `rubrist_binary_calibration_v1`, and the vendored
   Rubrist contracts take the v1 names Rubrist gives them in Batch 8G.
5. **What carries over unchanged.** ADR-0009's rule (an abstained Rubrist
   outcome counts as not passing), verification before admission, and
   decision precedence (ADR-0005).

## Consequences

- One fewer format, parser, renderer, and dispatch branch; no capability is
  lost, since the suite without calibration reaches today's suite decision.
- Configurations and reports written before the baseline can't be read.
  This is acceptable only because no external configuration or report exists
  before launch.
- A report no longer shares its number with its configuration; the CLI
  pairs them by format.
- After launch, a format change needs a new version again; this is a
  one-time pre-launch reset.
