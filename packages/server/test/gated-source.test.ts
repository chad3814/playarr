import { describe, expect, it, vi } from 'vitest';
import { GatedArticleSource } from './gated-source.ts';
import { RecordingArticleSource } from './post.ts';

describe('GatedArticleSource release', () => {
  it('settles only the released Message-ID, leaving others parked', async () => {
    const bufferA = Buffer.from('article a');
    const bufferB = Buffer.from('article b');
    const inner = new RecordingArticleSource(
      new Map([
        ['a@fixture.invalid', bufferA],
        ['b@fixture.invalid', bufferB],
      ]),
    );
    const gated = new GatedArticleSource(inner);
    gated.hold('a@fixture.invalid');
    gated.hold('b@fixture.invalid');

    const onFulfilledA = vi.fn();
    const onFulfilledB = vi.fn();
    const onRejectedB = vi.fn();
    void gated.body('a@fixture.invalid').then(onFulfilledA);
    void gated.body('b@fixture.invalid').then(onFulfilledB, onRejectedB);

    gated.release('a@fixture.invalid');
    await new Promise((resolve) => {
      setImmediate(resolve);
    });
    expect(onFulfilledA).toHaveBeenCalledWith({ body: bufferA });
    expect(onFulfilledB).not.toHaveBeenCalled();
    expect(onRejectedB).not.toHaveBeenCalled();

    gated.release('b@fixture.invalid');
    await new Promise((resolve) => {
      setImmediate(resolve);
    });
    expect(onFulfilledB).toHaveBeenCalledWith({ body: bufferB });
  });
});
