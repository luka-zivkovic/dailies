# Portfolio glossary

Status: **active shared vocabulary**

Last reviewed: 2026-09-25

This file is intentionally vendored in Rubrist, Dailies, and Casefile. Update
all three copies together. Product-specific scope is defined by each repo's
`PRODUCT.md`.

- **Artifact:** A versioned object whose identity and provenance matter.
- **Capability artifact:** An installable agent skill, plugin, marketplace
  entry, or comparable package inspected by Casefile.
- **Criterion:** One named quality dimension that can be judged independently.
- **Evaluator:** A governed mechanism that maps case evidence to a structured
  assessment. In Rubrist, an LLM judging skill is one evaluator type.
- **Evaluator suite:** A versioned, policy-free grouping of independently
  judged criteria and their pinned evaluators. A suite does not decide whether
  a release should ship.
- **Judging skill:** Rubrist's versioned evaluator: its definition (rubric,
  prompt, and output contract) and the model binding it runs with. From
  evidence v2, that binding is an execution binding.
- **Execution binding:** The part of an evaluator version's identity that
  states exactly what is sent to the model: provider, endpoint, model,
  sampling and reasoning settings (unset means not sent), output token
  limit, and verdict protocol.
- **Resolution record:** What Rubrist learned about an execution binding
  from provider capability data and probe calls. It confirms or fails the
  binding and is not part of evaluator identity.
- **Verdict protocol:** A versioned way of obtaining a structured verdict
  from a model, such as native structured output or a forced tool call. It
  pins everything injected around the judging skill.
- **Typed-question evaluator:** An evaluator whose model answers a typed
  question, such as a yes-or-no question, with a probability instead of a
  written verdict. A declared threshold maps the probability to pass or
  fail.
- **Human truth:** A reviewed human label or adjudicated result with rater and
  provenance information. It is reference evidence, not an LLM prediction.
- **Dataset revision:** An immutable, content-identified snapshot of cases,
  reference labels, review provenance, and declared exposure role.
- **Analysis/authoring data:** Cases or traces used to discover failure modes,
  create a taxonomy, or author criteria and rubrics.
- **Iterative-development data:** Cases used repeatedly to tune an evaluator's
  rubric, prompt, examples, model choice, or implementation.
- **Sealed-validation data:** Cases protected from analysis and evaluator
  development until a declared final validation. Once exposed for tuning, they
  cannot support the same sealed claim for a later evaluator version.
- **Regression/golden data:** Curated known failures and important cases used
  to prevent regressions. Performance on this set is not an estimate of broad
  production quality.
- **Dataset exposure:** The record of which people, evaluator versions, and
  development activities could access a dataset revision.
- **Assessment:** The result of applying an evaluator to one or more cases.
- **Assessment label:** A per-case evaluator result such as `pass` or `fail`.
  Do not call it a release decision.
- **Assessment receipt:** Rubrist's policy-free, verifiable record of a pinned
  evaluator execution and its completeness/provenance.
- **Evidence:** A typed observation with identity, provenance, and completeness
  that another system may verify and use.
- **Evidence trust class:** Dailies' description of how evidence can be
  verified, for example verified, deterministic, or self-reported.
- **Evidence scope:** The identified population and collection procedure to
  which evidence applies, such as a regression corpus, sealed representative
  evaluation, production sample, or manual review set.
- **Calibration evidence:** Measurements comparing an evaluator with human
  truth on an identified dataset revision. It is not release policy.
- **Production outcome monitoring:** Rubrist's ungoverned comparison of a
  production system's stated probabilities with the outcomes recorded after
  it acted. It is development feedback, not calibration evidence or human
  truth.
- **Release policy:** Customer-owned rules that translate evidence into a
  release decision.
- **Release decision:** Dailies' `promote`, `block`, or `inconclusive` result.
  Avoid the unqualified word "verdict" for this concept.
- **Complete:** All evidence required by a declared contract was produced and
  verified. Complete does not mean passing.
- **Incomplete:** Required evidence is missing, failed, or unverifiable.
  Incomplete is not equivalent to a failed candidate.
- **Regression:** A paired case whose accepted baseline passed and whose
  evaluated candidate failed. An execution error is not a regression.
- **Authored regression corpus:** Visible cases written alongside an
  implementation to prevent known behavior from regressing.
- **Blind comparative benchmark:** A sealed, independently labeled corpus and
  preregistered procedure used to compare tools or support broader claims.
- **Artifact lock:** Casefile's digest-protected snapshot of artifact identity,
  policy, findings, and scanner/report versions.
