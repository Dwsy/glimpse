import { useCallback, useEffect, useRef, useState } from "react";

export type AsyncState<T> = {
  data?: T;
  isLoading: boolean;
  error?: Error;
  revalidate: () => void;
};

function toError(value: unknown): Error {
  return value instanceof Error ? value : new Error(String(value));
}

/**
 * Minimal async data hook. Replaces `usePromise` from `@raycast/utils`, whose
 * barrel export pulls the AI API into the bundle — Tinycast does not implement
 * Raycast AI, so the extension must not carry it.
 */
export function useAsync<T, A extends unknown[] = []>(
  load: (...args: A) => Promise<T>,
  deps: A = [] as unknown as A,
): AsyncState<T> {
  const [data, setData] = useState<T>();
  const [error, setError] = useState<Error>();
  const [isLoading, setIsLoading] = useState(true);
  const [reloadToken, setReloadToken] = useState(0);
  const loadRef = useRef(load);
  loadRef.current = load;

  useEffect(() => {
    let cancelled = false;
    setIsLoading(true);
    setError(undefined);
    loadRef
      .current(...deps)
      .then((value) => {
        if (!cancelled) setData(value);
      })
      .catch((cause) => {
        if (!cancelled) setError(toError(cause));
      })
      .finally(() => {
        if (!cancelled) setIsLoading(false);
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...deps, reloadToken]);

  const revalidate = useCallback(() => setReloadToken((token) => token + 1), []);

  return { data, isLoading, error, revalidate };
}
