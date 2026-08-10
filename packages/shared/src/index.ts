export type JobStatus = 'uploaded' | 'ready' | 'paused' | 'completing' | 'complete' | 'failed';

export type NntpSecurity = 'implicit' | 'starttls' | 'none';

/** Half-open `[start, end)` run of segment indices. */
export type SegmentRun = readonly [number, number];

export interface JobFailure {
  readonly code: string;
  readonly message: string;
}

/** One file inside the NZB, as known before any article is fetched. */
export interface CandidateFile {
  readonly fileIndex: number;
  /** Best-effort name from the subject. Null when the subject yields nothing. */
  readonly subjectName: string | null;
  /** Encoded bytes, summed from the NZB. Always larger than the decoded size. */
  readonly encodedBytes: number;
  readonly segmentCount: number;
  readonly selectable: boolean;
}

export interface SelectionDto {
  readonly fileIndex: number;
  readonly name: string;
  readonly size: number;
  readonly segmentSize: number;
  readonly lastSegmentSize: number;
  readonly segmentCount: number;
  readonly covered: readonly SegmentRun[];
  readonly dead: readonly number[];
  readonly coveredBytes: number;
}

export interface JobDto {
  readonly id: string;
  readonly createdAt: string;
  readonly nzbName: string;
  readonly status: JobStatus;
  /** Derived, never persisted: this job currently owns the connection pool. */
  readonly active: boolean;
  readonly failure?: JobFailure;
  readonly candidates: readonly CandidateFile[];
  /**
   * True when no candidate had a usable extension, so every file is offered
   * and the resolved name is only known after probing.
   */
  readonly namesUnresolved: boolean;
  readonly selection?: SelectionDto;
}

export interface SelectRequest {
  readonly fileIndex: number;
}

export interface ProgressEvent {
  readonly status: JobStatus;
  readonly covered: readonly SegmentRun[];
  readonly dead: readonly number[];
  readonly coveredBytes: number;
  readonly size: number;
  readonly bytesPerSecond: number;
}

export interface SettingsDto {
  readonly host: string;
  readonly port: number;
  readonly security: NntpSecurity;
  readonly connections: number;
  readonly username: string;
  readonly hasPassword: boolean;
  /** True when the credential comes from env or a secret mount, not the volume. */
  readonly passwordFromEnvironment: boolean;
}

export interface SettingsUpdate {
  readonly host: string;
  readonly port: number;
  readonly security: NntpSecurity;
  readonly connections: number;
  readonly username: string;
  /** Omitted means "leave the stored password alone". */
  readonly password?: string;
}

export interface SettingsTestResult {
  readonly ok: boolean;
  readonly message: string;
  /**
   * Per-attempt connection failures the pool has recorded, newest last.
   *
   * A provider's connection cap surfaces here: the pool shrinks its own limit
   * on `502 Too many connections` and carries on, so without this the real cap
   * is invisible rather than merely unenforced.
   */
  readonly failures: readonly string[];
}

export interface DownloadConflict {
  readonly missing: number;
}

export interface ApiError {
  readonly code: string;
  readonly message: string;
}

export interface SegmentGeometryDto {
  readonly segmentSize: number;
  readonly lastSegmentSize: number;
  readonly segmentCount: number;
}

/**
 * Decoded bytes covered by a set of segment runs.
 *
 * Lives here because the server computes it for the job DTO, the download
 * computes it for progress, and the client displays it. Segments are uniform
 * except the last, which is why this cannot be a multiplication.
 */
export function coveredBytes(runs: readonly SegmentRun[], geometry: SegmentGeometryDto): number {
  const { segmentSize, lastSegmentSize, segmentCount } = geometry;
  let total = 0;
  for (const [start, end] of runs) {
    const clampedEnd = Math.min(end, segmentCount);
    for (let index = Math.max(0, start); index < clampedEnd; index += 1) {
      total += index === segmentCount - 1 ? lastSegmentSize : segmentSize;
    }
  }
  return total;
}
