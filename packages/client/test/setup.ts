import '@testing-library/react';

/**
 * jsdom's `Blob`/`File` implementation does not provide `.text()`, unlike
 * every real browser. `Library.tsx` reads a dropped file with it, so back
 * it with `FileReader`, which jsdom does implement.
 *
 * This is the polyfill for `Blob#text()` itself, so it cannot use
 * `Blob#text()` to implement it.
 */
function textPolyfill(this: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.addEventListener('load', () => resolve(String(reader.result)));
    reader.addEventListener('error', () => reject(reader.error));
    // oxlint-disable-next-line unicorn/prefer-blob-reading-methods
    reader.readAsText(this);
  });
}

if (typeof Blob.prototype.text !== 'function') {
  Blob.prototype.text = textPolyfill;
}

/**
 * jsdom does not implement `EventSource` at all, unlike every real browser.
 * `useEventSource` (used by the Player view) subscribes to the job progress
 * SSE endpoint with it via `addEventListener('message', ...)`, so tests need
 * a minimal stand-in. Extending the real `EventTarget` (which jsdom does
 * implement) gives add/removeEventListener for free instead of hand-rolling
 * them.
 *
 * `StubEventSource as typeof EventSource` typechecks directly (no `unknown`
 * bridge needed) because the real `EventSource`'s instance type is assignable
 * to this narrower one, which is the direction TypeScript's type-assertion
 * overlap check requires.
 */
class StubEventSource extends EventTarget {
  constructor(readonly url: string) {
    super();
  }
  close(): void {}
}

globalThis.EventSource ??= StubEventSource as typeof EventSource;
