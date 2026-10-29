/** Logs a background failure that fails nothing else. */
export function report(what: string, e: unknown): void {
  console.error(`bouncer: ${what}`, e);
}
