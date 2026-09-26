#!/usr/bin/env node
// Minimal local stand-in for the Rubrist release-evidence API used by the
// runnable v5/v6 examples under fixtures/examples/. It implements only the
// three endpoints Dailies calls (batch submit, eval-run poll, assessment
// receipt) and produces structurally valid receipt-v2 artifacts whose
// digests bind to the manifest and the submitted candidate outputs.
//
// It is a fixture server for local runs and tests. It is not Rubrist, it has
// no evaluator, and every outcome is scripted: `pass` by default, `fail` for
// any criterion named with --fail-criterion, and `abstain` for any named with
// --abstain-criterion. Each member's evaluator is the mock identity below, so
// a manifest's skillDigest must be mockSkillDigest(member), as the bundled
// examples' manifests are (scripts/build-examples.mjs).
//
//   node scripts/mock-rubrist.mjs --manifest fixtures/examples/v5-suite/suite-manifest.json
//   node scripts/mock-rubrist.mjs --manifest <path> --port 0 --fail-criterion criterionv_safety_2
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

function usage(message) {
  if (message) console.error(`mock-rubrist: ${message}`);
  console.error(
    'usage: node scripts/mock-rubrist.mjs --manifest <suite-manifest.json> ' +
      '[--port 4820] [--host 127.0.0.1] [--fail-criterion <criterionVersionId>]... ' +
      '[--abstain-criterion <criterionVersionId>]...',
  );
  process.exit(2);
}

function parseArgs(argv) {
  const options = {
    manifest: undefined,
    port: 4820,
    host: '127.0.0.1',
    failCriteria: new Set(),
    abstainCriteria: new Set(),
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const next = () => {
      const value = argv[index + 1];
      if (value === undefined) usage(`${arg} requires a value`);
      index += 1;
      return value;
    };
    if (arg === '--manifest') options.manifest = next();
    else if (arg === '--port') options.port = Number(next());
    else if (arg === '--host') options.host = next();
    else if (arg === '--fail-criterion') options.failCriteria.add(next());
    else if (arg === '--abstain-criterion') options.abstainCriteria.add(next());
    else if (arg === '--help' || arg === '-h') usage();
    else usage(`unknown argument ${arg}`);
  }
  if (options.manifest === undefined) usage('--manifest is required');
  if (!Number.isInteger(options.port) || options.port < 0 || options.port > 65_535) {
    usage('--port must be an integer between 0 and 65535');
  }
  return options;
}

/** Rubrist canonical JSON: recursive lexicographic keys, stable array order. */
function canonicalJson(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((entry) => canonicalJson(entry ?? null)).join(',')}]`;
  const keys = Object.keys(value).filter((key) => value[key] !== undefined).sort();
  return `{${keys.map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
}

function sha256Digest(value) {
  return `sha256:${createHash('sha256').update(canonicalJson(value)).digest('hex')}`;
}

/** The local mock's execution binding: no sampling, no token limit, mock/v1. */
export const MOCK_EXECUTION_BINDING = Object.freeze({
  provider: 'mock',
  endpoint: { kind: 'managed' },
  modelId: 'mock-rubrist',
  modelVersion: 'mock-rubrist',
  sampling: { temperature: null, topP: null },
  reasoning: null,
  outputTokenLimit: null,
  verdictProtocol: 'mock/v1',
  routing: null,
});

/** The mock evaluator identity of one manifest member: a definition digest per evaluator version. */
export function mockEvaluatorIdentity(member) {
  return {
    basis: 'rubrist/evaluator-identity/v2',
    definitionDigest: sha256Digest({ mockDefinition: member.skillVersionId }),
    executionBinding: structuredClone(MOCK_EXECUTION_BINDING),
  };
}

/** skillDigest v2 of the member's mock evaluator. */
export function mockSkillDigest(member) {
  return sha256Digest(mockEvaluatorIdentity(member));
}

function buildReceipt(manifest, member, evalRunId, items, outcome) {
  const sorted = [...items].sort((left, right) =>
    left.clientItemId < right.clientItemId ? -1 : left.clientItemId > right.clientItemId ? 1 : 0);
  const receiptItems = sorted.map((item) => ({
    clientItemId: item.clientItemId,
    caseId: `case-${member.position}-${item.clientItemId}`,
    contentDigest: sha256Digest({ input: item.input, output: item.output }),
    result: { state: 'outcome', outcome },
    verdictId: `verdict-${member.position}-${item.clientItemId}`,
    evaluatorScore: { value: outcome === 'pass' ? 1 : outcome === 'fail' ? 0 : 0.5, kind: 'self_reported_score' },
    observed: {
      model: 'mock-rubrist',
      requestId: `request-${member.position}-${item.clientItemId}`,
      responseId: `response-${member.position}-${item.clientItemId}`,
      systemFingerprint: null,
      upstreamProvider: null,
      thinkingReturned: null,
      reasoningTokens: null,
    },
  }));
  const count = (wanted) => receiptItems.filter((item) => item.result.outcome === wanted).length;
  const evaluator = mockEvaluatorIdentity(member);
  const receipt = {
    contract: 'rubrist/assessment-receipt/v2',
    schemaVersion: 2,
    receiptId: `receipt-${evalRunId}`,
    evalRunId,
    projectId: manifest.projectId,
    skillId: member.skillId,
    skillVersionId: member.skillVersionId,
    status: 'complete',
    run: {
      status: 'completed',
      totalItems: receiptItems.length,
      passItems: count('pass'),
      failItems: count('fail'),
      abstainedItems: count('abstain'),
      failedItems: 0,
      notAttemptedItems: 0,
      agreedItems: 0,
    },
    evaluator,
    skillDigest: sha256Digest(evaluator),
    datasetDigest: sha256Digest(
      receiptItems.map(({ clientItemId, contentDigest }) => ({ clientItemId, contentDigest })),
    ),
    items: receiptItems,
  };
  receipt.evidenceDigest = sha256Digest(receipt);
  return receipt;
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => resolve(body));
    req.on('error', reject);
  });
}

function json(res, status, payload) {
  res.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(payload));
}

export function createMockRubristServer(
  manifest,
  { failCriteria = new Set(), abstainCriteria = new Set() } = {},
) {
  const membersBySkillVersion = new Map(
    manifest.members.map((member) => [member.skillVersionId, member]),
  );
  const runs = new Map();
  let sequence = 0;
  return createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://mock');
    try {
      if (req.method === 'POST' && url.pathname === '/api/v1/judge/batch') {
        const body = JSON.parse(await readBody(req));
        const member = membersBySkillVersion.get(body.skillVersionId);
        if (member === undefined || !Array.isArray(body.items)) {
          json(res, 404, { error: `unknown skillVersionId ${String(body.skillVersionId)}` });
          return;
        }
        sequence += 1;
        const evalRunId = `run-${sequence}-${member.skillVersionId}`;
        runs.set(evalRunId, { member, items: body.items });
        json(res, 202, {
          evalRunId,
          status: 'pending',
          totalItems: body.items.length,
          cachedItems: 0,
          skippedItems: 0,
          pollUrl: `/api/v1/eval-runs/${encodeURIComponent(evalRunId)}`,
        });
        return;
      }
      const poll = url.pathname.match(/^\/api\/v1\/eval-runs\/([^/]+)$/);
      if (req.method === 'GET' && poll) {
        const evalRunId = decodeURIComponent(poll[1]);
        if (!runs.has(evalRunId)) {
          json(res, 404, { error: 'unknown eval run' });
          return;
        }
        json(res, 200, { id: evalRunId, status: 'completed' });
        return;
      }
      const receipt = url.pathname.match(/^\/api\/v1\/eval-runs\/([^/]+)\/assessment-receipt$/);
      if (req.method === 'GET' && receipt) {
        const evalRunId = decodeURIComponent(receipt[1]);
        const run = runs.get(evalRunId);
        if (run === undefined) {
          json(res, 404, { error: 'unknown eval run' });
          return;
        }
        const criterion = run.member.criterionVersionId;
        const outcome = failCriteria.has(criterion) ? 'fail' : abstainCriteria.has(criterion) ? 'abstain' : 'pass';
        json(res, 200, buildReceipt(manifest, run.member, evalRunId, run.items, outcome));
        return;
      }
      json(res, 404, { error: `no route for ${req.method} ${url.pathname}` });
    } catch (error) {
      json(res, 400, { error: error instanceof Error ? error.message : String(error) });
    }
  });
}

function main() {
  const options = parseArgs(process.argv.slice(2));
  let manifest;
  try {
    manifest = JSON.parse(readFileSync(options.manifest, 'utf8'));
  } catch (error) {
    usage(`cannot read manifest ${options.manifest}: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (!Array.isArray(manifest?.members) || typeof manifest.projectId !== 'string') {
    usage(`${options.manifest} is not an evaluator suite manifest`);
  }
  const server = createMockRubristServer(manifest, {
    failCriteria: options.failCriteria,
    abstainCriteria: options.abstainCriteria,
  });
  server.listen(options.port, options.host, () => {
    const address = server.address();
    const port = typeof address === 'object' && address !== null ? address.port : options.port;
    console.log(`mock-rubrist: listening on http://${options.host}:${port}`);
    console.log(
      `mock-rubrist: serving ${manifest.members.length} criteria from ${options.manifest}; ` +
        `outcomes ${options.failCriteria.size === 0 && options.abstainCriteria.size === 0
          ? 'all pass'
          : [
              ...(options.failCriteria.size === 0 ? [] : [`fail for ${[...options.failCriteria].join(', ')}`]),
              ...(options.abstainCriteria.size === 0 ? [] : [`abstain for ${[...options.abstainCriteria].join(', ')}`]),
            ].join('; ')}`,
    );
  });
  const shutdown = () => {
    server.closeAllConnections();
    server.close(() => process.exit(0));
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main();
}
