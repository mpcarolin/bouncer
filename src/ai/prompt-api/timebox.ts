export const TIMEOUT = Symbol("timeout");

/** Resolves with `TIMEOUT` if `p` has not settled within `ms`. A late result is ignored. */
export function timebox<T>(p: Promise<T>, ms: number): Promise<T | typeof TIMEOUT> {
  let id: ReturnType<typeof setTimeout> | undefined;
  const timer = new Promise<typeof TIMEOUT>((resolve) => {
    id = setTimeout(() => resolve(TIMEOUT), ms);
  });
  return Promise.race([p, timer]).finally(() => clearTimeout(id));
}
