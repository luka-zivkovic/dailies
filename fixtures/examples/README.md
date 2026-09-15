# Runnable v5 and v6 examples

These directories let you run a real schema-v5 (evaluator suite) and
schema-v6 (calibration-aware suite) release evaluation and read the reports
without a Coeval account. They are generated from the vendored Coeval
contract fixtures in `contracts/fixtures/` by `scripts/build-examples.mjs`,
and the test suite fails if the committed files drift from that script.

| Example | Config | Local artifacts | Expected decision |
| --- | --- | --- | --- |
| `v5-suite/` | schema v5, policy v1: two mandatory blocking criteria | `cases.jsonl`, `suite-manifest.json` | `promote` (exit `0`) |
| `v6-calibration/` | schema v6, policy v2: the same criteria plus a calibration requirement each | `cases.jsonl`, `suite-manifest.json`, `calibration-factuality.json`, `calibration-safety.json` | `promote` (exit `0`) |

## What needs a network and what does not

The suite manifest and, for v6, the binary-calibration artifacts are exact
local files that Dailies verifies offline (canonical bytes, digests, and the
complete expected-identity tuple). The receipt-v1 evidence for each criterion
is different: v5 and v6 always obtain it from a Coeval HTTP endpoint (batch
submit, poll, assessment receipt). There is no pre-fetched receipt path, so
the examples use `scripts/mock-coeval.mjs`, a local stub that implements only
those three endpoints and returns structurally valid receipts whose digests
bind to the manifest and to the submitted candidate outputs.

The stub is not Coeval and has no evaluator. Every label it returns is
scripted: `pass` by default, or `fail` for criteria named with
`--fail-criterion`. A `promote` from these examples says only that the
bundled three-case corpus satisfied the bundled policy against scripted
evidence; it is a demonstration of the report, not evidence about any real
system.

## Run

From the repository root after `npm ci && npm run build`:

```sh
node scripts/mock-coeval.mjs --manifest fixtures/examples/v5-suite/suite-manifest.json &
node dist/cli.js --config fixtures/examples/v5-suite/dailies.config.json
node dist/cli.js --config fixtures/examples/v6-calibration/dailies.config.json
kill %1
```

Reports are written to `dailies-out/` inside each example directory. Both
examples share the same manifest, so one stub serves both. To see a `block`
instead, restart the stub with `--fail-criterion criterionv_safety_2`; to see
`inconclusive`, run an example with no stub listening.

The stub listens on `http://127.0.0.1:4820` by default, which is the URL
pinned in both configs; `--port` and `--host` override it, and `--port 0`
picks a free port (printed on startup) for tests.

## Regenerate

```sh
npm run build
node scripts/build-examples.mjs
```

The v6 calibration artifacts keep the timestamps of the vendored fixture, so
the policy's `maximumAgeSeconds` is set to the schema maximum (ten years).
A real policy should use a much shorter window.
