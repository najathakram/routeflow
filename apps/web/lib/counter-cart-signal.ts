/**
 * POS-7: a one-bit module store - "the counter cart has lines". CounterSaleScreen sets it (one effect); the register
 * header reads it to decide whether Exit asks "Discard this sale?". No React context, no provider: the cart stays
 * private to the screen and only this single fact crosses to the shell.
 */
let hasLines = false;
const listeners = new Set<() => void>();

export function getCounterCartHasLines(): boolean {
  return hasLines;
}

export function setCounterCartHasLines(next: boolean): void {
  if (next === hasLines) return;
  hasLines = next;
  listeners.forEach((fn) => fn());
}

export function subscribeCounterCart(fn: () => void): () => void {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}
