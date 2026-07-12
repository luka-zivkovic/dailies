# release-layer

> **Note:** `release-layer` is a working name, not final.

The release layer of an AI trust ecosystem: safe shipping of AI changes (prompts, models, configs) via shadow evaluation and judged promotion. See [PLAN.md](./PLAN.md) for the product thesis and roadmap.

**What exists today (v0 wedge):** `shadow-run`, a CLI that runs a candidate AI change against historical inputs, judges each result against your production baseline, and emits a promote/block report. No serving-path changes required.

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
- `2` — run error (bad config, unreadable inputs, etc.)

One example item intentionally regresses, so the report shows a failing example while the run still promotes under the example thresholds (`minPassRate: 0.75`, `maxRegressions: 1`). Tighten `maxRegressions` to `0` to see a block.

## Configuration

`shadow-run --config shadow.config.json`. Relative paths are resolved against the config file's directory.

```jsonc
{
  // Historical inputs: one JSON object per line:
  // {"id": "...", "input": "...", "baseline_output": "optional production output"}
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

  // The judge — either any HTTP endpoint implementing the gate contract:
  //   POST {input, candidate_output, baseline_output?}
  //     -> {score: number, pass: boolean, reason?: string}
  // "judge": { "type": "http", "url": "http://localhost:9090/judge" },
  // ...or the built-in zero-dependency baseline comparator:
  "judge": { "type": "exact-match" },

  "thresholds": {
    "minPassRate": 0.75,   // fraction of items that must pass, in [0, 1]
    "maxRegressions": 1    // failing items that have a baseline_output
  },
  "concurrency": 4,        // default 4
  "output": { "dir": "../shadow-out" }
}
```

Semantics:

- Every input runs through the candidate, then the judge. Candidate/judge failures are retried once; an item that still fails counts as a **failure** in the totals — it is never silently skipped.
- A **regression** is a failing item that has a `baseline_output` (behavior production used to get right).
- Verdict is `promote` iff `passRate >= minPassRate` **and** `regressions <= maxRegressions`.
- `report.json` uses a versioned schema (`schemaVersion: 1`); `report.md` is the human summary with failing examples.

## Development

```sh
npm test        # vitest: config validation, aggregation, judges, e2e with mock HTTP servers
npm run build   # tsc
```

## License

MIT
