import type { PoolManager } from '../nntp/pool.ts';
import type { JobStore } from './store.ts';

/**
 * Owns the single active job. Exactly one Download exists at a time.
 *
 * Task 10 replaces this file with the full implementation, constructed the
 * same way (`new JobManager(store, pool)`), so neither parameter is kept here
 * — there is nothing yet for this stub to do with them.
 */
export class JobManager {
  #activeId: string | null;

  constructor(_store: JobStore, _pool: PoolManager) {
    this.#activeId = null;
  }

  get activeId(): string | null {
    return this.#activeId;
  }

  /** Stop and forget the active download if it is this job. Task 10 fills this in. */
  release(_id: string): Promise<void> {
    return Promise.resolve();
  }
}
