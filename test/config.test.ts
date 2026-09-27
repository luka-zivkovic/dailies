import { describe, expect, it } from 'vitest';
import { parseSingleConfig } from '../src/config.js';
import { singleContractForBytes } from './single-fixture.js';

const validConfig = {
  ...singleContractForBytes('inputs.jsonl', '{"id":"one","input":"x"}\n', 1),
  candidate: { type: 'command', template: 'echo {input}' },
  judge: { type: 'exact-match' },
  thresholds: { minPassRate: 0.9, maxRegressions: 0 },
  output: { dir: 'out' },
};

describe('config validation', () => {
  it('rejects missing and legacy config versions with a migration diagnostic', () => {
    const { contract: _contract, ...unnamed } = validConfig;
    expect(() => parseSingleConfig(unnamed)).toThrow(/unsupported config contract: missing/);
    expect(() => parseSingleConfig({ ...validConfig, contract: 'dailies/suite-config/v1' })).toThrow(
      /single-criterion release execution requires dailies\/single-config\/v1/,
    );
    expect(() => parseSingleConfig({ ...validConfig, schemaVersion: 4 })).toThrow();
  });

  it('accepts a valid command + exact-match config and defaults concurrency to 4', () => {
    const config = parseSingleConfig(validConfig);
    expect(config.concurrency).toBe(4);
    expect(config.candidate.type).toBe('command');
    expect(config.trustPolicy.admissibleClasses).toEqual(['verified', 'deterministic']);
  });

  it('defaults timeoutMs to 60000 and accepts an explicit value', () => {
    expect(parseSingleConfig(validConfig).timeoutMs).toBe(60_000);
    expect(parseSingleConfig({ ...validConfig, timeoutMs: 500 }).timeoutMs).toBe(500);
  });

  it('rejects a non-positive or non-integer timeoutMs', () => {
    expect(() => parseSingleConfig({ ...validConfig, timeoutMs: 0 })).toThrow();
    expect(() => parseSingleConfig({ ...validConfig, timeoutMs: 1.5 })).toThrow();
  });

  it('accepts an http candidate and http judge with headers', () => {
    const config = parseSingleConfig({
      ...validConfig,
      candidate: {
        type: 'http',
        url: 'http://localhost:8080/generate',
        headers: { authorization: 'Bearer x' },
        bodyTemplate: '{"prompt": {input}}',
      },
      judge: { type: 'http', url: 'http://localhost:9090/judge' },
      concurrency: 2,
    });
    expect(config.concurrency).toBe(2);
    expect(config.judge).toEqual({ type: 'http', url: 'http://localhost:9090/judge' });
  });

  it('accepts a pinned Rubrist judge and applies bounded polling defaults', () => {
    const config = parseSingleConfig({
      ...validConfig,
      judge: {
        type: 'rubrist',
        url: 'https://rubrist.example',
        headers: { authorization: 'Bearer secret' },
        skillVersionId: 'skill-version-1',
      },
    });
    expect(config.judge).toMatchObject({
      type: 'rubrist',
      skillVersionId: 'skill-version-1',
      pollIntervalMs: 1_000,
      pollTimeoutMs: 300_000,
    });
  });

  it('rejects unpinned Rubrist judges and polling values outside hard bounds', () => {
    expect(() => parseSingleConfig({
      ...validConfig,
      judge: { type: 'rubrist', url: 'https://rubrist.example' },
    })).toThrow();
    expect(() => parseSingleConfig({
      ...validConfig,
      judge: {
        type: 'rubrist',
        url: 'https://rubrist.example',
        skillVersionId: 'v1',
        pollIntervalMs: 30_001,
      },
    })).toThrow();
    expect(() => parseSingleConfig({
      ...validConfig,
      judge: {
        type: 'rubrist',
        url: 'https://rubrist.example',
        skillVersionId: 'v1',
        pollTimeoutMs: 1_800_001,
      },
    })).toThrow();
  });

  it('rejects a missing thresholds block', () => {
    const { thresholds: _thresholds, ...rest } = validConfig;
    expect(() => parseSingleConfig(rest)).toThrow();
  });

  it('rejects minPassRate outside [0, 1]', () => {
    expect(() =>
      parseSingleConfig({ ...validConfig, thresholds: { minPassRate: 1.5, maxRegressions: 0 } }),
    ).toThrow();
  });

  it('rejects negative or non-integer maxRegressions', () => {
    expect(() =>
      parseSingleConfig({ ...validConfig, thresholds: { minPassRate: 0.9, maxRegressions: -1 } }),
    ).toThrow();
    expect(() =>
      parseSingleConfig({ ...validConfig, thresholds: { minPassRate: 0.9, maxRegressions: 0.5 } }),
    ).toThrow();
  });

  it('rejects an unknown candidate type', () => {
    expect(() =>
      parseSingleConfig({ ...validConfig, candidate: { type: 'grpc', url: 'x' } }),
    ).toThrow();
  });

  it('rejects an http candidate without bodyTemplate', () => {
    expect(() =>
      parseSingleConfig({ ...validConfig, candidate: { type: 'http', url: 'http://localhost:1' } }),
    ).toThrow();
  });

  it('rejects concurrency < 1', () => {
    expect(() => parseSingleConfig({ ...validConfig, concurrency: 0 })).toThrow();
  });

  it('requires bounded ordered time windows for production samples', () => {
    expect(() => parseSingleConfig({
      ...validConfig,
      scope: { ...validConfig.scope, kind: 'production_sample' },
    })).toThrow(/bounded time range/i);
    expect(() => parseSingleConfig({
      ...validConfig,
      scope: {
        ...validConfig.scope,
        kind: 'production_sample',
        timeWindow: {
          kind: 'range',
          start: '2026-08-23T00:00:00.000Z',
          end: '2026-08-22T00:00:00.000Z',
        },
      },
    })).toThrow(/must not precede/i);
  });
});
