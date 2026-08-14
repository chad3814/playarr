import { chmod, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import type { StoredConfig } from './settings.ts';

/**
 * Reads and writes `/data/config.json`.
 *
 * The file holds a plaintext password when the settings page is used, so it is
 * written 0600. Setting `NNTP_PASSWORD` or mounting `/run/secret/nntp_password`
 * means nothing is ever written here at all, and that is the better path.
 */
export class ConfigStore {
  readonly #path: string;

  constructor(path: string) {
    this.#path = path;
  }

  /** Null when absent or unreadable — a bad config must not stop the container. */
  async load(): Promise<StoredConfig | null> {
    let text: string;
    try {
      text = await readFile(this.#path, 'utf8');
    } catch {
      return null;
    }
    try {
      const decoded: unknown = JSON.parse(text);
      if (typeof decoded !== 'object' || decoded === null) {
        return null;
      }
      // A trust boundary: this file is only ever written by `save` below or
      // hand-edited by the local user who owns the container, so it is
      // narrowed here rather than field-by-field validated.
      return decoded as StoredConfig;
    } catch {
      return null;
    }
  }

  async save(config: StoredConfig): Promise<void> {
    const temp = `${this.#path}.tmp`;
    await writeFile(temp, `${JSON.stringify(config, null, 2)}\n`, {
      encoding: 'utf8',
      mode: 0o600,
    });
    await chmod(temp, 0o600);
    try {
      await rename(temp, this.#path);
    } catch (error) {
      await unlink(temp).catch(() => {});
      throw error;
    }
  }
}
