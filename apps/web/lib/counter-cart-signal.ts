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
  if (!next) leaveRequest = null;
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
  if (next) leaveRequest = null; // a sale started recording: any parked leave is moot
  listeners.forEach((fn) => fn());
}

export const COUNTER_LEAVE_BLOCKED_COPY =
  "A sale is in progress. Wait for the receipt or check its status before leaving.";

export function getCounterLeaveNotice(): boolean {
  return leaveNotice;
}

let leaveRequest: (() => void) | null = null;

/** True while a leave is parked behind the "Discard this sale?" dialog (the register header renders it). */
export function getCounterLeaveRequest(): boolean {
  return leaveRequest !== null;
}

/** Discard: run the parked leave once. */
export function confirmCounterLeave(): void {
  const go = leaveRequest;
  if (!go) return;
  leaveRequest = null;
  listeners.forEach((fn) => fn());
  go();
}

/** Keep selling: drop the parked leave. */
export function cancelCounterLeave(): void {
  if (!leaveRequest) return;
  leaveRequest = null;
  listeners.forEach((fn) => fn());
}

/**
 * THE shared leave guard. Every shell way out of the counter (Exit, rail/drawer links, g shortcuts, the palette, the user menu,
 * browser Back, leaving an impersonation) asks this first. Returns true when the leave must NOT happen right now:
 *  - a sale is being recorded (leaving would drop the attempt and invite a second ring-up): raises the notice the header shows;
 *  - the cart has lines and the caller passed `proceed`: the leave is parked and the "Discard this sale?" dialog opens;
 *    Discard runs `proceed` (the caller's own navigation), Keep selling drops it.
 * Returns false when the caller may go on itself. Off the counter nothing is busy and the cart has no lines.
 */
export function guardCounterLeave(proceed?: () => void): boolean {
  if (busy) {
    if (!leaveNotice) {
      leaveNotice = true;
      listeners.forEach((fn) => fn());
    }
    return true;
  }
  if (hasLines && proceed) {
    leaveRequest = proceed;
    listeners.forEach((fn) => fn());
    return true;
  }
  return false;
}
