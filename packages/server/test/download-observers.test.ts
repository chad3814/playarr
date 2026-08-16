import { afterEach, describe, expect, it, vi } from 'vitest';
import { collect, flush, harness, messageIds, SEG, type Harness } from './download-harness.ts';

let openHarness: Harness | null = null;

afterEach(async () => {
  await openHarness?.close();
  openHarness = null;
});

/**
 * The job's callbacks run from inside the same `try` that catches article
 * failures, so an unguarded throw is not merely lost — it is recovered from as
 * though the provider had failed, which re-requests an article already on disk
 * and then marks a good segment dead.
 */
describe('Download observer failures', () => {
  it('does not blame the article when onCoverage throws', async () => {
    const h = (openHarness = await harness());
    const ids = messageIds(h);
    h.onCoverage.mockImplementation((segment) => {
      if (segment === 1) {
        throw new Error('state.json is unwritable');
      }
    });

    h.download.want(1);
    await vi.waitFor(() => expect(h.download.coverage.has(2)).toBe(true));
    await flush();

    expect(h.download.coverage.has(1)).toBe(true);
    expect(h.download.dead.has(1)).toBe(false);
    expect(h.source.requested.filter((id) => id === ids[1])).toHaveLength(1);
    expect(h.onFatal).not.toHaveBeenCalled();
  });

  it('keeps going when onCoverage throws for a segment it just gave up on', async () => {
    const h = (openHarness = await harness());
    const ids = messageIds(h);
    h.source.fail(ids[1]!, new Error('430 No such article'));
    h.onCoverage.mockImplementation((segment) => {
      if (segment === 1) {
        throw new Error('state.json is unwritable');
      }
    });

    h.download.want(1);
    await vi.waitFor(() => expect(h.download.coverage.has(2)).toBe(true));

    expect(h.download.dead.has(1)).toBe(true);
    expect(h.onObserverError).toHaveBeenCalled();
    expect(h.onFatal).not.toHaveBeenCalled();
  });
});

describe('Download observer failure reporting', () => {
  it('reports the throw rather than dropping it', async () => {
    const h = (openHarness = await harness());
    const boom = new Error('state.json is unwritable');
    h.onCoverage.mockImplementationOnce(() => {
      throw boom;
    });

    h.download.want(0);
    await h.download.waitFor(0);

    expect(h.onObserverError).toHaveBeenCalledWith(boom);
  });

  it('completes the download even when onDrained throws', async () => {
    const h = (openHarness = await harness([SEG, SEG, 400]));
    const boom = new Error('status transition failed');
    h.onDrained.mockImplementation(() => {
      throw boom;
    });

    await h.download.completeAll();

    expect(h.download.coverage.isComplete()).toBe(true);
    expect(h.download.dead.count).toBe(0);
    expect(h.onObserverError).toHaveBeenCalledWith(boom);
  });
});

describe('Download fatal observer failures', () => {
  it('still rejects parked readers when onFatal throws', async () => {
    const h = (openHarness = await harness());
    const enospc = Object.assign(new Error('no space left on device'), { code: 'ENOSPC' });
    vi.spyOn(h.download.fd, 'write').mockRejectedValue(enospc);
    const boom = new Error('listener exploded');
    h.onFatal.mockImplementation(() => {
      throw boom;
    });

    await expect(collect(h.download.read(SEG, 2 * SEG))).rejects.toThrow(/write/iu);
    expect(h.onObserverError).toHaveBeenCalledWith(boom);
  });

  it('carries on when the error handler itself throws', async () => {
    const h = (openHarness = await harness());
    h.onCoverage.mockImplementation(() => {
      throw new Error('state.json is unwritable');
    });
    h.onObserverError.mockImplementation(() => {
      throw new Error('the reporter is broken too');
    });

    h.download.want(0);
    await vi.waitFor(() => expect(h.download.coverage.has(1)).toBe(true));
    await flush();

    expect(h.download.dead.count).toBe(0);
    expect(h.onObserverError).toHaveBeenCalled();
    expect(h.onFatal).not.toHaveBeenCalled();
  });
});
