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
