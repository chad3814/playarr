import { useEffect, useState } from 'react';

/**
 * Subscribe to an SSE endpoint. Null url means "not subscribed", which is what
 * lets a component mount before it knows which job it is watching.
 *
 * `isValid` narrows the untyped `JSON.parse` result into `T`: a frame that
 * fails the check is dropped rather than cast, the same standard api.ts holds
 * every DTO to.
 */
export function useEventSource<T>(
  url: string | null,
  isValid: (value: unknown) => value is T,
): T | null {
  const [value, setValue] = useState<T | null>(null);

  useEffect(() => {
    if (url === null) {
      return;
    }
    setValue(null);
    const source = new EventSource(url);
    const onMessage = (event: MessageEvent<string>): void => {
      try {
        const parsed: unknown = JSON.parse(event.data);
        if (isValid(parsed)) {
          setValue(parsed);
        }
      } catch {
        // A truncated frame is not worth tearing the stream down for.
      }
    };
    source.addEventListener('message', onMessage);
    return () => {
      source.removeEventListener('message', onMessage);
      source.close();
    };
  }, [url, isValid]);

  return value;
}
