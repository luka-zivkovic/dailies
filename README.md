# Dailies

> Review the footage before the release.

[![CI](https://github.com/luka-zivkovic/dailies/actions/workflows/ci.yml/badge.svg)](https://github.com/luka-zivkovic/dailies/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-111111.svg)](LICENSE)

Dailies is a local release-decision CLI for AI changes. It runs or coordinates
evaluation over a declared evidence scope, keeps trust and missing evidence
visible, applies your release policy, and produces an auditable decision:

| Decision | Meaning |
| --- | --- |
| `promote` | The candidate satisfied the declared policy on the declared evidence scope. |
| `block` | Complete, admissible evidence shows that the candidate violates policy. |
| `inconclusive` | Required evidence is missing, failed, or cannot be verified. |

The important distinction is the third state: a gate that could not judge a
release must never approve it—or pretend the candidate failed.

## Why Dailies

Ordinary tests can tell you whether code runs. They cannot tell you whether an
AI change regressed a known behavior, whether a judge result is trustworthy,
or whether the evidence actually covers the population you intend to release
to.

Dailies makes those assumptions explicit:

- **Scope-bound decisions** — every claim names the exact dataset or sample it covers.
- **Honest incompleteness** — infrastructure and protocol failures become `inconclusive`, not synthetic passes or failures.
- **Visible evidence trust** — deterministic, verified, and self-reported results stay distinct.
- **Customer-owned policy** — Dailies applies your thresholds and criterion roles; an evaluator does not decide whether you ship.
- **Reproducible reports** — exact input identity, operations, policy, evidence, and decision precedence remain auditable.

## How it works

```text
candidate + exact evidence scope + evidence providers
                       │
                       ▼
       execute and collect candidate evidence
                       │
                       ▼
       verify identity, coverage, trust, and completeness
                       │
                       ▼
              apply release policy
                       │
                       ▼
          promote | block | inconclusive
                       │
                       ▼
              report.json + report.md
```

Dailies runs locally and does not sit on the serving path. It contacts only the
candidate, judge, or Coeval endpoints that you explicitly configure.

## Try the bundled example

Requires Node.js 20 or newer.

```sh
git clone https://github.com/luka-zivkovic/dailies.git
cd dailies
npm ci
npm run build
node dist/cli.js --config fixtures/dailies.config.json
```

The example runs five pinned regression cases through a deterministic
exact-match evaluator:

```text
decision: promote | pass rate 80.0% (4/5), regressions 1, evaluated 5/5, errored 0
report: .../dailies-out/report.json
report: .../dailies-out/report.md
```

One item intentionally regresses. The example still promotes because its
declared policy allows one regression. Change `maxRegressions` from `1` to `0`
to see the same evidence produce a block.

## Run the CLI

```sh
node dist/cli.js --config dailies.config.json
```

The npm registry currently carries the earlier `0.1.0` build. Until `0.2.0` is
published, use a source checkout for the schema versions documented below.

The command exits with:

| Code | Decision | CI meaning |
| ---: | --- | --- |
| `0` | `promote` | Policy satisfied. |
| `1` | `block` | Candidate should not advance. |
| `2` | `inconclusive` | The run or required evidence failed. |

## Minimal configuration

This schema-v4 example evaluates one criterion over an exact, digest-pinned
JSONL regression corpus:

```json
{
  "schemaVersion": 4,
  "inputs": {
    "type": "jsonl",
    "path": "cases.jsonl",
    "digest": "sha256:<digest-of-the-exact-file-bytes>"
  },
  "scope": {
    "id": "checkout-regressions-v1",
    "kind": "regression_corpus",
    "expectedItems": 24,
    "collectionProcedure": "Curated failures from reviewed support escalations.",
    "population": "Known checkout-assistant failure modes.",
    "timeWindow": {
      "kind": "not_applicable",
      "reason": "This is a static regression corpus."
    }
  },
  "candidate": {
    "type": "http",
    "url": "http://localhost:8080/generate",
    "bodyTemplate": "{\"prompt\": {input}}"
  },
  "judge": { "type": "exact-match" },
  "thresholds": {
    "minPassRate": 1,
    "maxRegressions": 0
  },
  "output": { "dir": "./dailies-out" }
}
```

Each JSONL row has a stable ID and input. `baseline_label` is optional, but it
is required for a paired comparison; `baseline_output` supplies evaluator
context and never silently implies that the baseline passed.

```json
{"id":"checkout-001","input":"Where is my order?","baseline_label":"pass","baseline_output":"Your order is in transit."}
```

See the [bundled configuration](fixtures/dailies.config.json) and
[configuration reference](docs/report-v4.md) for the complete contract.

## Evidence integrations

| Integration | Trust class | Intended use |
| --- | --- | --- |
| Built-in exact match | `deterministic` | Reproducible baseline comparisons without an external judge. |
| Verified Coeval receipt | `verified` | Governed evaluator evidence with pinned identity, coverage, and digests. |
| Generic HTTP judge | `self_reported` | Migration and custom integrations without a verifiable evidence envelope. |

Verified and deterministic evidence are admissible by default. A generic HTTP
judge cannot independently promote a release unless the customer policy
records an explicit self-reported-evidence override and reason. The override
admits the evidence; it does not upgrade its trust class.

## Configuration generations

Dailies keeps earlier report formats readable while adding new capability
through explicit schema versions:

- **v4 — single criterion:** one declared scope with exact-match, HTTP, or Coeval evidence.
- **v5 — evaluator suite:** a pinned, policy-free Coeval suite with separate evidence and policy for each criterion.
- **v6 — calibration-aware suite:** exact local calibration artifacts, evaluated per trial without silently pooling variance.

The detailed contracts live in [report v4](docs/report-v4.md),
[report v5](docs/report-v5.md), and [report v6](docs/report-v6.md).

## Decision safety

Release decisions follow a fixed precedence:

1. A required evidence-channel integrity failure is `inconclusive`.
2. A candidate-attributable execution failure is `block`.
3. Complete, admissible blocking evidence is `block`, even if unrelated mandatory evidence is missing.
4. Missing mandatory evidence with no known block is `inconclusive`.
5. Complete and admissible evidence is evaluated normally under customer policy.

This behavior is defined in
[ADR-0005](docs/decisions/0005-decision-precedence.md) and covered by the
authored invariant suite. The suite is a correctness gate, not a competitor
benchmark or a product-superiority claim.

## Data and security

- Candidate commands run on the machine invoking Dailies.
- Candidate, judge, and Coeval HTTP requests go only to configured endpoints.
- Authentication header **names**, but not their values, may appear in execution identity records.
- Reports contain evaluation inputs, candidate outputs, labels, and reasons. Treat report artifacts as potentially sensitive data.
- Dailies is not an inference proxy and does not require production traffic to pass through it.

Please report vulnerabilities using the process in [SECURITY.md](SECURITY.md).

## Product boundaries

Dailies owns the release consequence. It does not author rubrics, establish
human truth, or statically inspect capability packages.

- **Coeval** produces governed, policy-free assessment evidence.
- [Casefile](https://github.com/luka-zivkovic/casefile) produces deterministic trust evidence for capability artifacts.
- Dailies verifies or consumes those inputs and applies customer-owned release policy.

The products share explicit evidence contracts; they do not collapse into one
runtime.

## Documentation

- [Product charter](PRODUCT.md) — authoritative target scope
- [Architecture decisions](docs/decisions/README.md) — accepted product and evidence semantics
- [Shared glossary](docs/glossary.md) — precise portfolio terminology
- [Implementation plan](PLAN.md) — current sequencing and demand-gated work
- [Evidence contracts](contracts/README.md) — vendored schemas and conformance fixtures
- [Changelog](CHANGELOG.md) — notable changes by release

`PRODUCT.md` and accepted ADRs define target behavior. The README describes
the current CLI and does not override those sources.

## Development

```sh
npm ci
npm run build
npm test
npm run invariant:batch6
npm pack --dry-run
```

The project currently has 288 tests across configuration, execution, retries,
evidence verification, policy, reporting, tamper cases, and deterministic
fault injection. GitHub Actions runs the build and complete test suite on every
push and pull request.

Dailies is pre-1.0 software. Schema compatibility is deliberate, but the
public CLI and library API may still evolve before a stable release.

## License

[MIT](LICENSE) © 2026 Luka Živković
