import type { PoolManager } from '../nntp/pool.ts';
import type { JobStore } from './store.ts';

/** Owns the single active job. Exactly one Download exists at a time. */
export class JobManager {
  readonly #store: JobStore;
  readonly #pool: PoolManager;
  #activeId: string | null = null;

  constructor(store: JobStore, pool: PoolManager) {
    this.#store = store;
    this.#pool = pool;
  }

  get activeId(): string | null {
    return this.#activeId;
  }

  protected setActive(id: string | null): void {
    this.#activeId = id;
  }

  protected get store(): JobStore {
    return this.#store;
  }

  protected get pool(): PoolManager {
    return this.#pool;
  }

  /** Stop and forget the active download if it is this job. Task 10 fills this in. */
  release(_id: string): Promise<void> {
    return Promise.resolve();
  }
}
