import { open, type FileHandle } from 'node:fs/promises';

export const MAX_CALIBRATION_FILE_BYTES = 16 * 1024 * 1024;

export type CalibrationFileReadFailureCode = 'source_not_found' | 'source_read_failed';

/** Operational local-file absence is distinct from artifact integrity. */
export class CalibrationFileReadError extends Error {
  readonly code: CalibrationFileReadFailureCode;

  constructor(
    code: CalibrationFileReadFailureCode,
    message: string,
    options: { cause?: unknown } = {},
  ) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = 'CalibrationFileReadError';
    this.code = code;
  }
}

export interface ReadCalibrationFileOptions {
  /** Failure-injection seam. It must return the single raw byte snapshot. */
  readBytes?: (path: string) => Promise<Uint8Array>;
  /** Bounded-reader seam used to prove one-open behavior without a stat call. */
  openFile?: (path: string) => Promise<Pick<FileHandle, 'read' | 'close'>>;
}

function isMissingFile(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error &&
    (error as { code?: unknown }).code === 'ENOENT';
}

async function readBoundedSnapshot(
  path: string,
  openFile: NonNullable<ReadCalibrationFileOptions['openFile']>,
): Promise<Uint8Array> {
  const handle = await openFile(path);
  const buffer = Buffer.allocUnsafe(MAX_CALIBRATION_FILE_BYTES + 1);
  let offset = 0;
  let readError: unknown;
  try {
    while (offset < buffer.byteLength) {
      const result = await handle.read(
        buffer,
        offset,
        buffer.byteLength - offset,
        offset,
      );
      if (result.bytesRead === 0) break;
      offset += result.bytesRead;
    }
  } catch (error) {
    readError = error;
  }
  try {
    await handle.close();
  } catch (error) {
    if (readError === undefined) readError = error;
  }
  if (readError !== undefined) throw readError;
  return buffer.subarray(0, offset);
}

/**
 * Read one bounded local snapshot without retry, stat/open TOCTOU, parsing,
 * normalization, or fallback. The extra byte lets the frozen parser classify
 * oversize input without ever allocating more than 16 MiB + 1 here.
 */
export async function readCalibrationFileOnce(
  path: string,
  options: ReadCalibrationFileOptions = {},
): Promise<Uint8Array> {
  try {
    return options.readBytes === undefined
      ? await readBoundedSnapshot(path, options.openFile ?? ((filePath) => open(filePath, 'r')))
      : await options.readBytes(path);
  } catch (error) {
    const code: CalibrationFileReadFailureCode = isMissingFile(error)
      ? 'source_not_found'
      : 'source_read_failed';
    throw new CalibrationFileReadError(
      code,
      code === 'source_not_found'
        ? 'configured binary calibration file was not found'
        : 'configured binary calibration file could not be read',
      { cause: error },
    );
  }
}
