/**
 * Test-only recorder for the SQLSTATE of every attempt `retryOnTxConflict` retried.
 *
 * `retryOnTxConflict` logs one `<label>: transaction conflict <STATE>, retry n/m` warning per
 * retried attempt through a Nest `Logger` (the state is `txConflictState(err)`: 40001, 40P01, P2034
 * ...). Spying on `Logger.prototype.warn` reads that state with NO production change and still
 * calls through to the real logger.
 */
import { Logger } from "@nestjs/common";

const RETRY_LINE = /^(.+): transaction conflict (\S+), retry \d+\/\d+$/;

/** The retried attempt's SQLSTATE when `message` is a retry warning for `label`, else null. */
export function retriedStateFromLog(message: unknown, label: string): string | null {
  if (typeof message !== "string") return null;
  const m = RETRY_LINE.exec(message);
  return m && m[1] === label ? m[2] : null;
}

export interface RetryCapture {
  /** States seen so far, in order (a live array; read it after the call settles). */
  states: string[];
  restore: () => void;
}

/** Starts recording retried-attempt states for `label`; call `restore()` when done. */
export function captureRetriedStates(label: string): RetryCapture {
  const states: string[] = [];
  const spy = jest.spyOn(Logger.prototype, "warn");
  spy.mockImplementation(function (this: unknown, message: unknown) {
    const state = retriedStateFromLog(message, label);
    if (state) states.push(state);
  } as any);
  return { states, restore: () => spy.mockRestore() };
}
