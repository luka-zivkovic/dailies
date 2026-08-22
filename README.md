# dailies

> Review the footage before the release.

Dailies is the release-decision layer for AI changes. It coordinates
baseline/candidate evaluation, preserves evidence scope, trust, and
incompleteness honestly, applies customer-owned policy, and emits an auditable
`promote`, `block`, or `inconclusive` decision.

[`PRODUCT.md`](PRODUCT.md) is authoritative for intended product scope. This
README describes the current CLI. See the shared [glossary](docs/glossary.md),
[architecture decisions](docs/decisions/README.md), and [PLAN.md](PLAN.md) for
the documentation-first roadmap. The time-sensitive
[positioning note](docs/positioning.md) records the intended wedge without
turning competitor features into product authority.

**What exists today (v0 wedge):** the `dailies` CLI ("shadow-run" mode) runs a candidate AI change against historical inputs, judges each result against an explicit baseline label, and emits a tri-state report. The input file is effectively a regression-corpus scope today, but that scope is not yet a first-class report field. No serving-path changes are required.

## Quickstart

Requires Node >= 20.

```sh
npm install
npm run build
node dist/cli.js --config fixtures/shadow.config.json
```

That runs the bundled example: five historical inputs (`fixtures/example-inputs.jsonl`), a trivial `echo` command as the "candidate", and the zero-dependency `exact-match` judge that compares candidate output to each item's `baseline_output`. It writes `shadow-out/report.json` and `shadow-out/report.md`, prints the verdict, and exits with:

- `0` — promote
- `1` — block
- `2` — inconclusive/run error (bad config, unreadable inputs, judge/protocol failure, or incomplete evidence)

Every current input is required. A candidate that cannot execute one blocks the release (`1`), while a judge or evidence-protocol error makes the run inconclusive (`2`): a gate that could not judge must never approve or pretend the candidate regressed. Completed judge failures remain ordinary block evidence.

One example item intentionally regresses, so the report shows a failing example while the run still promotes under the example thresholds (`minPassRate: 0.75`, `maxRegressions: 1`). Tighten `maxRegressions` to `0` to see a block.

## Configuration

`dailies --config shadow.config.json`. Relative paths are resolved against the config file's directory.

```jsonc
{
  // Historical inputs: one JSON object per line:
  // {"id": "...", "input": "...", "baseline_label": "pass|fail",
  //  "baseline_output": "optional production output"}
  // baseline_label is optional, but only explicitly labeled rows are paired
  // comparisons. baseline_output is judge context, never an implicit pass.
  "inputs": { "type": "jsonl", "path": "example-inputs.jsonl" },

  // The candidate under test — either a shell command...
  "candidate": { "type": "command", "template": "my-cli --prompt {input}" },
  // ...or an HTTP endpoint. {input} in bodyTemplate is replaced with the
  // JSON-encoded input (quotes included). If the response is JSON with a
  // string `output` field that is used; otherwise the raw body is.
  // "candidate": {
  //   "type": "http",
  //   "url": "http://localhost:8080/generate",
  //   "headers": { "authorization": "Bearer ..." },
  //   "bodyTemplate": "{\"prompt\": {input}}"
  // },

  // The judge — either any HTTP endpoint implementing the self-reported gate contract:
  //   POST {input, candidate_output, baseline_output?}
  //     -> {score: number, pass: boolean, reason?: string}
  // "judge": { "type": "http", "url": "http://localhost:9090/judge" },
  // ...or the built-in zero-dependency baseline comparator:
  "judge": { "type": "exact-match" },
  // ...or a pinned Coeval skill that returns independently verifiable evidence:
  // "judge": {
  //   "type": "coeval",
  //   "url": "https://coeval.example.com",
  //   "headers": { "authorization": "Bearer ..." },
  //   "skillVersionId": "skill-version-id", // required and immutable for this run
  //   "pollIntervalMs": 1000,                // default 1000; maximum 30000
  //   "pollTimeoutMs": 300000                // default 300000; maximum 1800000
  // },

  "thresholds": {
    "minPassRate": 0.75,   // fraction of items that must pass, in [0, 1]
    "maxRegressions": 1    // explicit baseline pass → candidate fail comparisons
  },
  "concurrency": 4,        // default 4
  "timeoutMs": 60000,      // per-call timeout (ms) for every candidate command/request
                           // and judge request; default 60000. Timed-out candidate
                           // failures block; judge/protocol failures make
                           // the run inconclusive (neither is ever skipped).
  "output": { "dir": "../shadow-out" }
}
```

Semantics:

- Every input runs through the candidate, then the judge. Candidate calls and ordinary per-item judge calls make at most two attempts. Only transient failures retry: HTTP `429`, HTTP `5xx`, transport errors, and timeouts. `Retry-After` is honored when present; otherwise the first retry waits 100 ms, and every delay is capped at 5 seconds. Authentication/request `4xx`, deterministic command failures, and malformed successful payloads do not retry.
- Every item records timestamp-free candidate and judge attempt ledgers with attempt number, outcome, typed error, HTTP status, retryability, and scheduled delay where applicable. This makes retry behavior auditable while keeping output deterministic. For Coeval, those per-item judge entries describe the single logical assessment; the report-level `evidence.operations` ledger records actual submit, poll, and receipt HTTP attempts by phase. A cross-origin/preflight rejection or exhausted deadline is recorded separately as a zero-request `termination`, never fabricated into an HTTP attempt.
- A Coeval release-evidence batch POST is submitted exactly once to avoid accidentally creating duplicate eval runs. Idempotent poll and receipt GETs retry bounded transient `429`/`5xx`/transport/timeout failures within the poll deadline. The operation ledger records `single_non_idempotent` versus `retry_transient` explicitly, including when a retryable POST failure was deliberately suppressed.
- A required candidate execution error blocks. A judge error, candidate/judge protocol error, or otherwise incomplete evaluation is `inconclusive`; threshold slack cannot turn it into `promote`.
- `baseline_label` is the only comparison baseline. Comparisons are `regression` (`pass → fail`), `improvement` (`fail → pass`), `stable_pass`, `stable_fail`, or `unpaired`. Missing labels and errored items are unpaired. `baseline_output` alone never implies that production passed, and unevaluated errors are never fabricated into regressions.
- Pass rate still covers every required input, including stable failures and unpaired items. A stable or unpaired failure therefore lowers pass rate and blocks under the default strict threshold; a looser `minPassRate` is an explicit choice to tolerate it. Unpaired passes are fully judged candidate evidence, but do not claim a historical improvement or regression.
- With complete evidence, verdict is `promote` iff `passRate >= minPassRate` **and** `regressions <= maxRegressions`; otherwise it is `block`.
- Exact-match inputs are preflighted for baselines, and duplicate input IDs are rejected before execution. Coeval input IDs are also preflighted before candidate work to enforce its 240-character `clientItemId` limit; otherwise IDs are preserved verbatim, including whitespace.
- For a Coeval judge, Dailies submits all successful candidate traces in one `release_evidence` batch, polls the eval run, and fetches its v1 assessment receipt. Dailies independently verifies the pinned skill version, exact item coverage and code-unit ordering, per-item content digests, dataset digest, run counters, and whole-receipt evidence digest. A digest-valid incomplete receipt is retained and explicitly classified `incomplete`; a mismatch or unsupported label is a `protocol` error. Either case, and any provider failure, is judge-stage `inconclusive`.
- Receipt v1 is a closed contract. Dailies vendors its schema and golden fixture in [`contracts/`](contracts/); even additive fields require a deliberate coordinated v2. The transport for future calibration evidence is intentionally unresolved and will not be improvised as a v1 field.
- Exact-match, verified Coeval evidence, and the minimal HTTP judge do not provide equivalent provenance. The accepted [evidence trust-class ADR](docs/decisions/0001-evidence-trust-classes.md) requires that distinction to remain explicit and makes self-reported evidence insufficient for automated promotion by default. The current CLI has not yet implemented that target policy.
- Coeval is the judge and evidence provider, not the release actor: its receipt contains per-item `pass`/`fail` labels but no threshold or deploy decision. Dailies alone applies `minPassRate` and `maxRegressions` to produce `promote` or `block`.
- Target release decisions are bound to declared evidence scopes. A successful run over a curated regression corpus means the candidate satisfied that corpus policy; it does not by itself claim representative production quality. See [ADR-0003](docs/decisions/0003-scope-bound-release-decisions.md).
- `report.json` uses a versioned schema (`schemaVersion: 3`) with an explicit `judgeType` and, for Coeval evidence, Dailies' pinned `skillVersionId` plus the batch-submitted `evalRunId`. Its exported parser re-derives totals and verdict, validates item/attempt consistency, and re-verifies retained Coeval evidence against that independent run identity, the pinned skill, and exact submitted candidate outputs. Coeval reports with submitted items cannot omit the evidence audit, and non-Coeval reports cannot add one. `report.md` summarizes the comparison mix, evidence identity, and failing examples.

## Development

```sh
npm test        # vitest: config validation, aggregation, judges, e2e with mock HTTP servers
npm run build   # tsc
```

GitHub Actions runs `npm ci`, the TypeScript build, and the complete test suite on pushes and pull requests.

## License

MIT
