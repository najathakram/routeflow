/**
 * POS-7: a one-bit module store - "the counter cart has lines". CounterSaleScreen sets it (one effect); the register
 * header reads it to decide whether Exit asks "Discard this sale?". No React context, no provider: the cart stays
 * private to the screen and only this single fact crosses to the shell.
 */
let hasLines = false;
let busy = false;
let leaveNotice = false;
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

/** True while a sale or a ship draft is being recorded (or its outcome is unknown): the register's Exit must not leave. */
export function getCounterCartBusy(): boolean {
  return busy;
}

export function setCounterCartBusy(next: boolean): void {
  if (next === busy) return;
  busy = next;
  if (!next) leaveNotice = false; // the sale settled: the "wait" notice goes with it
  listeners.forEach((fn) => fn());
}

export const COUNTER_LEAVE_BLOCKED_COPY =
  "A sale is in progress. Wait for the receipt or check its status before leaving.";

export function getCounterLeaveNotice(): boolean {
  return leaveNotice;
}

/**
 * THE shared leave guard. Every shell way out of the counter (Exit, rail/drawer links, g shortcuts, the palette, the user menu,
 * leaving an impersonation) asks this first. Returns true when the leave must NOT happen (a sale is being recorded: leaving would
 * drop the attempt and invite a second ring-up) and raises the notice the register header shows. Off the counter nothing is busy.
 */
export function guardCounterLeave(): boolean {
  if (!busy) return false;
  if (!leaveNotice) {
    leaveNotice = true;
    listeners.forEach((fn) => fn());
  }
  return true;
}
