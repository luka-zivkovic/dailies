# Batch 0 foundation inventory

Status: **active checkpoint record**

Captured: 2026-08-22 before Batch 0 commits

## Repository state

- Batch branch: `codex/batch0-foundation`
- Preserved base and observed `origin/main`:
  `a68c9fb7cbf857c773c1b17dcb1d3df3b61cc565`
- Relationship at capture: no committed divergence from `origin/main`.
- Dirty state at capture: 18 tracked files plus 23 untracked files before this
  inventory was added.
- No stash was present.

The uncommitted foundation covers tri-state release decisions, strict report
invariants, Coeval receipt verification, typed retries and operation ledgers,
deterministic output, contracts, CI, adversarial tests, and the authoritative
documentation stack.

## Checkpoint order

1. Commit authoritative documentation only on this feature branch.
2. Complete and verify the vendored receipt conformance corpus.
3. Commit the preserved runtime/test foundation in reviewable units.
4. Run the full test and standalone TypeScript build matrix.
5. Obtain an independent read-only audit before merge.
