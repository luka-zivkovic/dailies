import { mkdtemp, open, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  CalibrationFileReadError,
  MAX_CALIBRATION_FILE_BYTES,
  readCalibrationFileOnce,
} from '../src/calibration-file.js';

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe('local binary calibration file reads', () => {
  it('returns exactly the one raw-byte snapshot without normalization', async () => {
    const bytes = Uint8Array.from([0xef, 0xbb, 0xbf, 0xff]);
    let reads = 0;
    const observed = await readCalibrationFileOnce('/calibration.json', {
      readBytes: async (path) => {
        reads += 1;
        expect(path).toBe('/calibration.json');
        return bytes;
      },
    });

    expect(reads).toBe(1);
    expect(observed).toBe(bytes);
  });

  it.each([
    ['source_not_found', Object.assign(new Error('missing'), { code: 'ENOENT' })],
    ['source_read_failed', Object.assign(new Error('denied'), { code: 'EACCES' })],
  ] as const)('types a one-shot %s operation without retry', async (expectedCode, failure) => {
    let reads = 0;
    const result = readCalibrationFileOnce('/calibration.json', {
      readBytes: async () => {
        reads += 1;
        throw failure;
      },
    });

    await expect(result).rejects.toMatchObject({
      name: 'CalibrationFileReadError',
      code: expectedCode,
    } satisfies Partial<CalibrationFileReadError>);
    expect(reads).toBe(1);
  });

  it('uses one file descriptor and returns only the 16 MiB detection snapshot', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'dailies-calibration-file-'));
    tempDirs.push(dir);
    const path = join(dir, 'oversize.json');
    await writeFile(path, Buffer.alloc(MAX_CALIBRATION_FILE_BYTES + 64, 0x20));
    let opens = 0;
    let reads = 0;
    let closes = 0;

    const bytes = await readCalibrationFileOnce(path, {
      openFile: async (openedPath) => {
        opens += 1;
        expect(openedPath).toBe(path);
        const handle = await open(openedPath, 'r');
        return {
          read: async (...args: Parameters<typeof handle.read>) => {
            reads += 1;
            return handle.read(...args);
          },
          close: async () => {
            closes += 1;
            await handle.close();
          },
        };
      },
    });

    expect(opens).toBe(1);
    expect(reads).toBeGreaterThanOrEqual(1);
    expect(closes).toBe(1);
    expect(bytes.byteLength).toBe(MAX_CALIBRATION_FILE_BYTES + 1);
  });

  it('calls an injected snapshot reader once even when it returns oversize bytes', async () => {
    let reads = 0;
    const bytes = await readCalibrationFileOnce('/oversize.json', {
      readBytes: async () => {
        reads += 1;
        return new Uint8Array(MAX_CALIBRATION_FILE_BYTES + 1);
      },
    });
    expect(reads).toBe(1);
    expect(bytes.byteLength).toBe(MAX_CALIBRATION_FILE_BYTES + 1);
  });
});
