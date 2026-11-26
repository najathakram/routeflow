/**
 * One request for one action. While a call with the SAME arguments is still on its way, a second call gets the first
 * call's promise and nothing is sent again. The twin of web's `apps/web/lib/api/single-flight.ts` (B1379); the four
 * web cases run against both in `__tests__/single-flight.parity.test.ts`.
 *
 * B1415 (SA-1404 M1a): "Save adjustment" pressed twice applied the stock change twice. A button's loading state only
 * turns it off on the NEXT render, so two taps inside one frame both reach the mutation. Guarding at the request
 * means no caller of the hook has to remember its own in-flight flag.
 *
 * A call with different arguments is a different action and goes through. Once the first call settles (either way)
 * the same arguments may be sent again: a deliberate second identical adjustment, or a retry after an error.
 */
export function singleFlight<A, R>(fn: (arg: A) => Promise<R>): (arg: A) => Promise<R> {
  let key: string | null = null;
  let inFlight: Promise<R> | null = null;
  return (arg: A) => {
    const nextKey = JSON.stringify(arg);
    if (inFlight && key === nextKey) return inFlight;
    const call = fn(arg).finally(() => {
      if (inFlight === call) {
        inFlight = null;
        key = null;
      }
    });
    key = nextKey;
    inFlight = call;
    return call;
  };
}
