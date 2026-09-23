---
name: release-gate
description: "Set up and run a Dailies release gate for an AI change: create a digest-pinned starter corpus with `dailies init`, keep the corpus digest current with `dailies digest`, run `dailies --config` locally or through the GitHub Action, and read `report.md` and exit codes 0, 1, and 2 as promote, block, or inconclusive while keeping the evidence trust class visible. Do not use for authoring evaluation rubrics, judging output quality by hand, or statically inspecting agent plugins. Use when someone wants to decide whether an AI change is safe to advance, wants to add a regression gate for a prompt or model change to CI, or asks to set up or interpret Dailies."
argument-hint: "[project directory or config path]"
---

# Dailies release gate

Dailies runs a candidate against declared cases, collects evidence, applies
the customer's release policy, and writes a tri-state decision. Requires
Node.js 20 or newer. Work in the directory the user names; otherwise use the
current project root.

## 1. Create the starter corpus and config

```sh
npx dailies@latest init <dir>
```

This writes `<dir>/dailies.cases.jsonl` (three demonstration cases) and
`<dir>/dailies.config.json` (schema v4, one evidence scope, exact-match
judge, and a SHA-256 digest of the exact corpus bytes). It refuses to
overwrite either file, so an existing setup is left alone. Report both
created paths to the user.

The starter scope claims only the three generated behaviors. Before the
decision means anything for a real release, the user must replace the cases,
the `scope` description, and the `candidate` command with their own.

## 2. Explain the three trust classes in plain words

Every result carries a trust class, and the report keeps them distinct:

- **verified** — a governed evaluator (Rubrist) produced the result and
  Dailies checked its pinned identity, coverage, and digests. Admissible.
- **deterministic** — a reproducible check such as the built-in exact-match
  judge. Anyone can rerun it and get the same answer. Admissible.
- **self_reported** — a generic HTTP judge asserted the result and nothing
  verified it. Not admissible on its own; the customer policy must record an
  explicit override with a reason before it can count, and the override
  admits the evidence without upgrading its trust class.

The starter config admits only `deterministic` evidence.

## 3. Run the evaluation

```sh
npx dailies --config <path-to-dailies.config.json>
```

Paths inside the config resolve relative to the config file. The run prints a
one-line summary and the report paths, then writes `report.json` and
`report.md` into the configured output directory (`dailies-out/` by default).

## 4. Read the result

| Exit | Decision | Meaning |
| ---: | --- | --- |
| `0` | `promote` | The candidate satisfied the declared policy on the declared scope. |
| `1` | `block` | Complete, admissible evidence shows a policy violation. |
| `2` | `inconclusive` | Required evidence was missing, errored, or not trusted. |

Open `report.md` and relay the decision, the scope it covers, the pass rate and
regression count, and how many items were evaluated versus errored. State the
trust class of the evidence. A `promote` says only that the named cases
passed the named policy; it is not a claim about production quality.

`inconclusive` is not a failure of the candidate and not a pass. It means the
run could not gather the evidence the policy requires, or the evidence it
gathered is not trusted. Do not make it go away with a policy override, a
lower threshold, or a retry that drops cases. Report what was missing or
untrusted and let a human decide whether an override is justified; if they
choose one, it belongs in the config with a written reason so the report
shows it.

## 5. Keep the digest honest

The config pins the corpus with `inputs.digest`. Whenever the JSONL bytes
change, even by one whitespace character, the next run stops before
evaluating anything, prints `dailies error: input artifact digest mismatch`,
and exits `2`. After any corpus edit, run:

```sh
npx dailies digest --config <path-to-dailies.config.json>
```

It recomputes the SHA-256 and line count, prints the old and new values, and
rewrites only `inputs.digest` and `scope.expectedItems`. Add
`--check` to verify without writing (exit `1` on drift).

## 6. Gate in CI

Use the composite action instead of hand-written shell. It runs the pinned
npm release, appends `report.md` to the job summary, fails on `block`, and
fails on `inconclusive` unless `fail-on-inconclusive: 'false'` is set (then
it warns and the `decision` output still says `inconclusive`). Node.js 20 or
newer must be set up first:

```yaml
- uses: actions/setup-node@v4
  with: { node-version: 20 }
- uses: luka-zivkovic/dailies@main
  with: { config: dailies.config.json }
```

## Mistakes to avoid

- Do not describe a starter-corpus `promote` as evidence about the user's
  real system.
- Do not admit `self_reported` evidence or edit thresholds to change a
  decision without the user asking for exactly that.
- Do not treat exit code `2` as a CI flake to retry until it passes.
- Do not add the output directory to version control; reports contain inputs,
  candidate outputs, and reasons that may be sensitive.
