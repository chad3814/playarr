import { open, type FileHandle } from 'node:fs/promises';
import { join } from 'node:path';
import { openNzbFile, type NzbFileHandle } from '@chad3814/nzb';
import type { NzbFile } from '@chad3814/nzb-parser';
import { SegmentCoverage } from '../coverage/coverage.ts';
import { Download } from '../download/download.ts';
import { NON_UNIFORM_GEOMETRY } from '../download/errors.ts';
import { HttpError } from '../errors.ts';
import { NotConfiguredError, type PoolManager } from '../nntp/pool.ts';
import { isMp4Name } from './candidates.ts';
import { resolveOutputName } from './naming.ts';
import {
  jobObservers,
  markJobFailed,
  persistCoverage,
  withStatus,
  type JobProgress,
} from './progress.ts';
import { reportToStderr, type JobErrorReporter } from './reporting.ts';
import type { JobSelection } from './state.ts';
import type { JobRecord, JobStore } from './store.ts';

export type { JobErrorReporter };

function selectionFor(fileIndex: number, name: string, handle: NzbFileHandle): JobSelection {
  const { segmentSize, lastSegmentSize, segmentCount } = handle.geometry;
  return {
    fileIndex,
    name,
    size: handle.size,
    geometry: { segmentSize, lastSegmentSize, segmentCount },
    covered: [],
    dead: [],
  };
}

interface Active {
  readonly id: string;
  readonly download: Download;
  readonly fd: FileHandle;
  readonly progress: JobProgress;
}

/**
 * Owns the single active job.
 *
 * Exactly one Download exists at a time, so the whole connection pool serves
 * whatever is being watched. Starting another job releases the current one.
 *
 * Every method that moves that ownership is single-flight, because none of
 * them is atomic: each yields at a provider round trip between reading
 * `#active` and replacing it, and Fastify serves requests concurrently. Two
 * overlapping selects would otherwise both find no active job, both build a
 * Download, and the second would overwrite `#active` without stopping the
 * first — leaving a fetcher consuming pool connections forever, a descriptor
 * nothing can reach to close, and, for the same job, a `w+` open truncating
 * the file the first one is mid-write on.
 */
export class JobManager {
  readonly #store: JobStore;
  readonly #pool: PoolManager;
  readonly #report: JobErrorReporter;
  #active: Active | null = null;
  /** Tail of the queue of ownership changes. Never rejects; see `#serialize`. */
  #gate: Promise<unknown> = Promise.resolve();

  constructor(store: JobStore, pool: PoolManager, onError: JobErrorReporter = reportToStderr) {
    this.#store = store;
    this.#pool = pool;
    this.#report = onError;
  }

  get activeId(): string | null {
    return this.#active?.id ?? null;
  }

  active(): Download | null {
    return this.#active?.download ?? null;
  }

  activeRecord(): JobRecord | null {
    const id = this.activeId;
    return id === null ? null : (this.#store.get(id) ?? null);
  }

  /** Probe the file, size the sparse file, prime head and tail. See `#select`. */
  select(id: string, fileIndex: number): Promise<JobRecord> {
    return this.#serialize(() => this.#select(id, fileIndex));
  }

  /** Resume a job that already has a selection — after a restart, or after a pause. */
  activate(id: string): Promise<Download> {
    return this.#serialize(() => this.#activate(id));
  }

  /** Stop and forget the active download, if it is this job. */
  release(id: string): Promise<void> {
    return this.#serialize(async () => {
      if (this.#active?.id === id) {
        await this.#releaseAll();
      }
    });
  }

  releaseAll(): Promise<void> {
    return this.#serialize(() => this.#releaseAll());
  }

  /**
   * Run `work` once every ownership change queued before it has finished.
   *
   * The queue itself never rejects: a failure belongs to the caller that asked
   * for the work, and must not cancel or be re-thrown at whoever is next in
   * line. Nothing reachable from `work` may call back into a public mutator
   * and await it, which would wait on a gate `work` is itself holding —
   * `#select` and friends call the `#`-prefixed bodies directly for that
   * reason. `JobProgress.stop` is the one exception, and it is deliberately
   * launched rather than awaited.
   */
  #serialize<T>(work: () => Promise<T>): Promise<T> {
    const next = this.#gate.then(work);
    this.#gate = next.catch(() => {});
    return next;
  }

  async #select(id: string, fileIndex: number): Promise<JobRecord> {
    const record = this.#record(id);
    this.#requireConfigured();

    const file = record.nzb.files[fileIndex];
    if (file === undefined) {
      throw new HttpError(400, 'bad-file-index', `No file ${fileIndex} in this NZB.`);
    }

    // Choosing what is already chosen must change nothing, so it must destroy
    // nothing: `#install` below opens the output `w+` and persists an empty
    // `covered`, which for a watched job truncates the file and forgets which
    // of its bytes were real. Resuming is what such a request means, and GET
    // /stream's `activate()` is what does it. A `failed` job starts over.
    if (record.state.selection?.fileIndex === fileIndex && record.state.status !== 'failed') {
      return record;
    }

    await this.#releaseAll();

    const handle = await this.#open(file);
    if (!handle.geometry.uniform) {
      await markJobFailed(this.#store, record, 'non-uniform-geometry', NON_UNIFORM_GEOMETRY);
      throw new HttpError(422, 'non-uniform-geometry', NON_UNIFORM_GEOMETRY);
    }

    const name = resolveOutputName(handle.name, file.subjectHints.name);
    if (!isMp4Name(name)) {
      throw new HttpError(415, 'not-mp4', `"${name}" is not an MP4, so it cannot be played here.`);
    }

    await this.#install(record, handle, selectionFor(fileIndex, name, handle));
    return this.#record(id);
  }

  async #activate(id: string): Promise<Download> {
    if (this.#active?.id === id) {
      return this.#active.download;
    }
    const record = this.#record(id);
    const selection = record.state.selection;
    if (selection === undefined) {
      throw new HttpError(409, 'not-selected', 'Choose a file in this NZB first.');
    }
    this.#requireConfigured();

    const file = record.nzb.files[selection.fileIndex];
    if (file === undefined) {
      throw new HttpError(409, 'bad-file-index', 'The selected file is no longer in this NZB.');
    }

    await this.#releaseAll();

    // Costs one article: openNzbFile has no entry point that accepts geometry
    // we already know.
    const handle = await this.#open(file);
    // outputPath rather than a join: this name came back off the volume, and
    // is the one place a hand-edited state.json could aim a write elsewhere.
    const fd = await open(this.#store.outputPath(record), 'r+');

    const count = selection.geometry.segmentCount;
    const dead = new SegmentCoverage(count);
    for (const index of selection.dead) {
      dead.add(index);
    }

    const active = this.#begin(id, handle, fd, new SegmentCoverage(count, selection.covered), dead);
    await this.#store.update(id, withStatus(record.state, 'ready'), { flush: true });
    return active.download;
  }

  async #releaseAll(): Promise<void> {
    const active = this.#active;
    this.#active = null;
    if (active === null) {
      return;
    }

    await active.download.stop();
    await active.fd.close();

    const record = this.#store.get(active.id);
    if (record !== undefined && record.state.status === 'ready') {
      await this.#store.update(active.id, withStatus(record.state, 'paused'), { flush: true });
    }
  }

  #record(id: string): JobRecord {
    const record = this.#store.get(id);
    if (record === undefined) {
      throw new HttpError(404, 'not-found', 'No such job.');
    }
    return record;
  }

  #requireConfigured(): void {
    if (!this.#pool.isConfigured()) {
      throw new HttpError(412, 'not-configured', new NotConfiguredError().message);
    }
  }

  #open(file: NzbFile): Promise<NzbFileHandle> {
    return openNzbFile(file, this.#pool.source(), { prefetch: this.#pool.connections });
  }

  /**
   * Take ownership of the output file: size it, persist the selection, start
   * the download, and prime head and tail.
   *
   * The descriptor is closed here if any of that fails. Until `#begin` has
   * taken it, nothing else ever will.
   */
  async #install(record: JobRecord, handle: NzbFileHandle, selection: JobSelection): Promise<void> {
    const id = record.state.id;
    // resolveOutputName has already reduced the post's claim to a bare
    // basename — what JobStore.outputPath demands — so this join cannot escape
    // the job directory. Opened before the selection is persisted, so no job
    // reaches 'ready' pointing at a file that could not be created.
    const fd = await open(join(record.dir, selection.name), 'w+');
    try {
      await fd.truncate(handle.size);
      const next = { ...withStatus(record.state, 'ready'), selection };
      await this.#store.update(id, next, { flush: true });

      const count = selection.geometry.segmentCount;
      const coverage = new SegmentCoverage(count);
      const active = this.#begin(id, handle, fd, coverage, new SegmentCoverage(count));
      await active.download.prime();
      await persistCoverage(active.progress, { flush: true });
    } catch (error) {
      await this.#abandon(fd);
      throw error;
    }
  }

  /** Close a descriptor that never became the active job's; release it if it did. */
  async #abandon(fd: FileHandle): Promise<void> {
    if (this.#active?.fd === fd) {
      await this.#releaseAll();
      return;
    }
    await fd.close();
  }

  /** Wire a Download to this job's bookkeeping and make it the active one. */
  #begin(
    id: string,
    handle: NzbFileHandle,
    fd: FileHandle,
    coverage: SegmentCoverage,
    dead: SegmentCoverage,
  ): Active {
    const progress: JobProgress = {
      store: this.#store,
      jobId: id,
      coverage,
      dead,
      report: this.#report,
      stop: () => this.release(id),
    };
    const download = new Download({
      handle,
      fd,
      coverage,
      dead,
      prefetch: this.#pool.connections,
      ...jobObservers(progress),
    });

    const active: Active = { id, download, fd, progress };
    this.#active = active;
    return active;
  }
}
