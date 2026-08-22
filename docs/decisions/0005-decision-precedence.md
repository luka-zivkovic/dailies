# ADR-0005: Release-decision precedence under mixed evidence

Status: **Accepted**

Date: 2026-08-22

## Context

A release can contain both a known adverse result and missing evidence. A
blanket rule that always lets either `block` or `inconclusive` win would erase
an important distinction: a complete, admissible blocking assessment is a
real release result, while a transport or protocol failure means Dailies
cannot establish what evidence it received.

## Decision

Dailies applies the following precedence in order:

1. An operational or protocol-integrity failure affecting required evidence
   yields `inconclusive`. A corrupt, swapped, unsupported, or failed evidence
   channel cannot produce a trustworthy release decision.
2. A required candidate execution failure yields `block` when the failure is
   attributable to the candidate rather than the evidence channel.
3. A complete, admissible blocking assessment yields `block` even when a
   different, unrelated mandatory criterion or scope is incomplete. Missing
   evidence cannot rescue a release already known to violate a declared
   non-compensatory blocking rule.
4. Missing mandatory evidence with no such known block yields `inconclusive`.
5. When all required evidence is complete and admissible, customer policy
   produces `promote` or `block` normally.

The Batch 1B report has one scope and one judge integration, so it directly
implements rows 1, 2, 4, and 5. Row 3 becomes reachable when criterion- and
multi-scope policy arrives; its meaning is fixed here before that runtime
work. "Unrelated" means the missing evidence is not needed to validate the
blocking assessment itself.

Self-reported evidence is not admissible by default. It participates in rows
3 or 5 only when the report retains an explicit customer override and reason.

## Truth table

| Required evidence condition | Candidate execution failure | Complete admissible block | Decision |
| --- | --- | --- | --- |
| Operational/protocol integrity failure | any | any | `inconclusive` |
| No integrity failure | yes | any | `block` |
| Unrelated mandatory evidence missing | no | yes | `block` |
| Mandatory evidence missing | no | no | `inconclusive` |
| Complete and admissible | no | yes | `block` |
| Complete and admissible | no | no | Apply customer policy |

## Consequences

- Infrastructure failure never masquerades as a product failure or approval.
- Missing evidence cannot average away a known non-compensatory block.
- The report must preserve enough typed evidence to reproduce which row won.
- Multi-criterion implementation cannot invent a different precedence later.
