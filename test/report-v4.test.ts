import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { parseConfig, type Config } from '../src/config.js';
import {
  buildDecisionStatement,
  parseReportForInspection,
  reportSchema,
  type Report,
} from '../src/report.js';
import { runShadow } from '../src/runner.js';

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

function digest(bytes: string): string {
  return `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
}

async function fixture(
  judge: Record<string, unknown> = { type: 'exact-match' },
  trustPolicy?: Record<string, unknown>,
): Promise<{ config: Config; path: string; bytes: string }> {
  const dir = await mkdtemp(join(tmpdir(), 'dailies-v4-'));
  tempDirs.push(dir);
  const path = join(dir, 'inputs.jsonl');
  const bytes = [
    JSON.stringify({ id: 'a', input: 'alpha', baseline_label: 'pass', baseline_output: 'alpha' }),
    JSON.stringify({ id: 'b', input: 'beta', baseline_label: 'pass', baseline_output: 'beta' }),
  ].join('\n') + '\n';
  await writeFile(path, bytes);
  return {
    path,
    bytes,
    config: parseConfig({
      schemaVersion: 4,
      inputs: { type: 'jsonl', path, digest: digest(bytes) },
      scope: {
        id: 'support-regression',
        kind: 'regression_corpus',
        expectedItems: 2,
        collectionProcedure: 'Pinned authored support examples.',
        population: 'Support-agent changes covered by this regression corpus.',
        timeWindow: {
          kind: 'not_applicable',
          reason: 'Static regression cases are not sampled from a time window.',
        },
      },
      candidate: { type: 'command', template: 'printf %s {input}' },
      judge,
      thresholds: { minPassRate: 1, maxRegressions: 0 },
      ...(trustPolicy === undefined ? {} : { trustPolicy }),
      output: { dir: join(dir, 'out') },
    }),
  };
}

function closeServer(server: Server): void {
  server.closeAllConnections();
  server.close();
}

async function httpJudge(body: object): Promise<{ server: Server; url: string }> {
  const server = createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(body));
  });
  const port = await new Promise<number>((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (address === null || typeof address === 'string') throw new Error('server did not bind');
      resolve(address.port);
    });
  });
  return { server, url: `http://127.0.0.1:${port}/judge` };
}

function asLegacyV3(report: Report): Record<string, unknown> {
  const {
    schemaVersion: _version,
    decision,
    decisionStatement: _statement,
    scope: _scope,
    trust: _trust,
    trustPolicy: _policy,
    items,
    ...common
  } = report;
  return {
    ...common,
    schemaVersion: 3,
    verdict: decision,
    items: items.map(({ trustClass: _trustClass, ...item }) => item),
  };
}

describe('report/config v4 scope and trust contract', () => {
  it('binds a deterministic exact-match decision to exact input bytes and declared scope', async () => {
    const { config, bytes } = await fixture();
    const report = await runShadow(config, { now: () => new Date('2026-08-22T12:00:00.000Z') });

    expect(report).toMatchObject({
      schemaVersion: 4,
      decision: 'promote',
      trustPolicy: { admissibleClasses: ['verified', 'deterministic'] },
      trust: {
        class: 'deterministic',
        derivation: 'exact_match_v1',
        admissible: true,
      },
      scope: {
        id: 'support-regression',
        kind: 'regression_corpus',
        inputArtifact: {
          digest: digest(bytes),
          byteLength: Buffer.byteLength(bytes),
          itemCount: 2,
        },
        coverage: { expectedItems: 2, observedItems: 2, evaluatedItems: 2 },
        producerProvenance: {
          datasetRevision: 'not_provided',
          exposure: 'not_provided',
          review: 'not_provided',
        },
      },
    });
    expect('verdict' in report).toBe(false);
    expect(report.items.every((item) => item.trustClass === 'deterministic')).toBe(true);
    expect(report.decisionStatement).toContain('support-regression');
    expect(report.decisionStatement).toContain(digest(bytes));
  });

  it('makes self-reported HTTP evidence inconclusive unless a reasoned override is retained', async () => {
    const judge = await httpJudge({ score: 1, pass: true });
    try {
      const ordinary = await fixture({ type: 'http', url: judge.url });
      const ordinaryReport = await runShadow(ordinary.config);
      expect(ordinaryReport).toMatchObject({
        decision: 'inconclusive',
        trust: { class: 'self_reported', derivation: 'http_judge_v1', admissible: false },
      });

      const overridden = await fixture(
        { type: 'http', url: judge.url },
        {
          admissibleClasses: ['verified', 'deterministic', 'self_reported'],
          selfReportedOverride: {
            reason: 'Temporary migration while the governed evaluator is integrated.',
          },
        },
      );
      const overriddenReport = await runShadow(overridden.config);
      expect(overriddenReport).toMatchObject({
        decision: 'promote',
        trust: { class: 'self_reported', admissible: true },
        trustPolicy: {
          selfReportedOverride: {
            reason: 'Temporary migration while the governed evaluator is integrated.',
          },
        },
      });
    } finally {
      closeServer(judge.server);
    }
  });

  it('does not turn an untrusted HTTP failure into a block, but honors a retained override', async () => {
    const judge = await httpJudge({ score: 0, pass: false, reason: 'self-reported failure' });
    try {
      const ordinary = await fixture({ type: 'http', url: judge.url });
      const ordinaryReport = await runShadow(ordinary.config);
      expect(ordinaryReport).toMatchObject({
        decision: 'inconclusive',
        totals: { evaluated: 2, failed: 2 },
        trust: { class: 'self_reported', admissible: false },
      });

      const overridden = await fixture(
        { type: 'http', url: judge.url },
        {
          admissibleClasses: ['verified', 'deterministic', 'self_reported'],
          selfReportedOverride: { reason: 'Customer accepts this migration judge.' },
        },
      );
      expect((await runShadow(overridden.config)).decision).toBe('block');
    } finally {
      closeServer(judge.server);
    }
  });

  it('does not let an HTTP judge assert its own trust class', async () => {
    const judge = await httpJudge({ score: 1, pass: true, trustClass: 'verified' });
    try {
      const { config } = await fixture({ type: 'http', url: judge.url });
      const report = await runShadow(config);
      expect(report).toMatchObject({
        decision: 'inconclusive',
        trust: {
          status: 'unavailable',
          derivation: 'http_judge_v1',
          admissible: false,
          reason: 'no_completed_evidence',
        },
        totals: { protocolErrored: 2 },
      });
      expect(report.items.every((item) => item.trustClass === undefined)).toBe(true);
    } finally {
      closeServer(judge.server);
    }
  });

  it('rejects scope-less configs, unreasoned self-reporting, digest drift, and count drift before execution', async () => {
    const { config, path } = await fixture();
    const raw = structuredClone(config) as Record<string, unknown>;
    delete raw.scope;
    expect(() => parseConfig(raw)).toThrow();
    expect(() => parseConfig({ ...config, schemaVersion: 3 })).toThrow();
    expect(() => parseConfig({
      ...config,
      trustPolicy: { admissibleClasses: ['self_reported'] },
    })).toThrow(/override/i);

    let candidateCalls = 0;
    const candidateServer = createServer((_req, res) => {
      candidateCalls += 1;
      res.writeHead(200, { 'content-type': 'application/json' }).end('{"output":"unused"}');
    });
    const candidatePort = await new Promise<number>((resolve) => {
      candidateServer.listen(0, '127.0.0.1', () => {
        const address = candidateServer.address();
        if (address === null || typeof address === 'string') throw new Error('server did not bind');
        resolve(address.port);
      });
    });
    try {
      await writeFile(path, 'changed bytes\n');
      await expect(runShadow({
        ...config,
        candidate: {
          type: 'http',
          url: `http://127.0.0.1:${candidatePort}/candidate`,
          bodyTemplate: '{"input": {input}}',
        },
      })).rejects.toThrow(/input artifact digest/i);
      expect(candidateCalls).toBe(0);
    } finally {
      closeServer(candidateServer);
    }

    const current = await fixture();
    let countMismatchCalls = 0;
    const countMismatchServer = createServer((_req, res) => {
      countMismatchCalls += 1;
      res.writeHead(200, { 'content-type': 'application/json' }).end('{"output":"unused"}');
    });
    const countMismatchPort = await new Promise<number>((resolve) => {
      countMismatchServer.listen(0, '127.0.0.1', () => {
        const address = countMismatchServer.address();
        if (address === null || typeof address === 'string') throw new Error('server did not bind');
        resolve(address.port);
      });
    });
    try {
      await expect(runShadow({
        ...current.config,
        candidate: {
          type: 'http',
          url: `http://127.0.0.1:${countMismatchPort}/candidate`,
          bodyTemplate: '{"input": {input}}',
        },
        scope: { ...current.config.scope, expectedItems: 3 },
      })).rejects.toThrow(/expected 3 items/i);
      expect(countMismatchCalls).toBe(0);
    } finally {
      closeServer(countMismatchServer);
    }
  });

  it('rejects report tampering across derived trust, scope coverage, decision, and statement', async () => {
    const { config } = await fixture();
    const report = await runShadow(config);
    const mutations: Array<[string, (candidate: Record<string, any>) => void]> = [
      ['trust class', (candidate) => { candidate.trust.class = 'verified'; }],
      ['trust admissibility', (candidate) => { candidate.trust.admissible = false; }],
      ['scope coverage', (candidate) => { candidate.scope.coverage.evaluatedItems = 1; }],
      ['declared input digest', (candidate) => { candidate.scope.inputArtifact.declaredDigest = `sha256:${'0'.repeat(64)}`; }],
      ['decision', (candidate) => { candidate.decision = 'block'; }],
      ['decision statement', (candidate) => { candidate.decisionStatement = 'unscoped promote'; }],
      ['item trust', (candidate) => { candidate.items[0].trustClass = 'verified'; }],
      ['exact-match output', (candidate) => { candidate.items[0].candidate_output = 'not-alpha'; }],
    ];
    for (const [name, mutate] of mutations) {
      const candidate = structuredClone(report) as unknown as Record<string, any>;
      mutate(candidate);
      expect(reportSchema.safeParse(candidate).success, name).toBe(false);
    }
  });

  it('rejects a coordinated HTTP-to-exact trust masquerade', async () => {
    const judge = await httpJudge({ score: 1, pass: true });
    try {
      const { config } = await fixture({ type: 'http', url: judge.url });
      const report = await runShadow(config);
      const masquerade = structuredClone(report) as Record<string, any>;
      masquerade.items[0].candidate_output = 'does-not-match-baseline';
      masquerade.judgeType = 'exact-match';
      masquerade.trust = {
        status: 'complete',
        class: 'deterministic',
        derivation: 'exact_match_v1',
        admissible: true,
      };
      for (const item of masquerade.items) item.trustClass = 'deterministic';
      masquerade.decision = 'promote';
      masquerade.decisionStatement = buildDecisionStatement(
        'promote',
        masquerade.scope.kind,
        masquerade.scope.id,
        masquerade.scope.inputArtifact.digest,
      );
      expect(reportSchema.safeParse(masquerade).success).toBe(false);
    } finally {
      closeServer(judge.server);
    }
  });

  it('parses v3 only for inspection without upgrading it and rejects unsupported versions', async () => {
    const { config } = await fixture();
    const current = await runShadow(config);
    const legacy = asLegacyV3(current);
    const inspected = parseReportForInspection(legacy);
    expect(inspected).toMatchObject({ schemaVersion: 3, readOnly: true });
    expect(inspected.report).toBe(legacy);
    expect(inspected.report).toMatchObject({ schemaVersion: 3, verdict: 'promote' });
    expect('decision' in inspected.report).toBe(false);
    expect(reportSchema.safeParse(legacy).success).toBe(false);

    expect(reportSchema.safeParse({ ...current, verdict: 'promote' }).success).toBe(false);
    expect(() => parseReportForInspection({ ...legacy, decision: 'promote' }))
      .toThrow();

    expect(parseReportForInspection(current)).toMatchObject({ schemaVersion: 4, readOnly: false });
    for (const version of [undefined, 1, 2, 6]) {
      const candidate = { ...legacy, ...(version === undefined ? {} : { schemaVersion: version }) };
      if (version === undefined) delete candidate.schemaVersion;
      expect(() => parseReportForInspection(candidate)).toThrow(/report schema version/i);
    }

    const historicalBytes = await readFile(
      new URL('../fixtures/report-v3-exact.json', import.meta.url),
      'utf8',
    );
    const historical = JSON.parse(historicalBytes) as unknown;
    const historicalInspection = parseReportForInspection(historical);
    expect(historicalInspection).toMatchObject({ schemaVersion: 3, readOnly: true });
    expect(`${JSON.stringify(historicalInspection.report, null, 2)}\n`).toBe(historicalBytes);

    for (const fixtureName of [
      'report-v3-http.json',
      'report-v3-coeval-incomplete.json',
    ]) {
      const historicalMinifiedBytes = await readFile(
        new URL(`../fixtures/${fixtureName}`, import.meta.url),
        'utf8',
      );
      const historicalMinified = JSON.parse(historicalMinifiedBytes) as unknown;
      const historicalMinifiedInspection = parseReportForInspection(historicalMinified);
      expect(historicalMinifiedInspection).toMatchObject({ schemaVersion: 3, readOnly: true });
      expect(`${JSON.stringify(historicalMinifiedInspection.report)}\n`)
        .toBe(historicalMinifiedBytes);
    }
  });
});
