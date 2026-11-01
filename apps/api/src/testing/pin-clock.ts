/**
 * Pins the wall clock for a spec whose code under test reads `new Date()` (L-353). Only `Date` is faked: timers,
 * `nextTick` and microtasks stay real, so awaits and `setTimeout` waits behave as usual. Undo with
 * `jest.useRealTimers()` in an `afterEach`.
 *
 * `PINNED_MID_MONTH` is a day with no month-start edge near it. The checkout anchor (`planCheckoutAnchor`) refuses
 * to open a session in the 91 minutes before the next 1st 12:00Z, so a spec that reaches `createCheckoutSession`
 * on the real clock goes red 10:29Z to 12:00Z on the 1st of every month with no commit to blame.
 */
export const PINNED_MID_MONTH = "2026-11-15T09:00:00Z";

const FAKE_ONLY_DATE: Array<
  | "nextTick"
  | "setImmediate"
  | "clearImmediate"
  | "setInterval"
  | "clearInterval"
  | "setTimeout"
  | "clearTimeout"
  | "queueMicrotask"
  | "performance"
  | "hrtime"
> = [
  "nextTick",
  "setImmediate",
  "clearImmediate",
  "setInterval",
  "clearInterval",
  "setTimeout",
  "clearTimeout",
  "queueMicrotask",
  "performance",
  "hrtime",
];

export function pinWallClock(iso: string = PINNED_MID_MONTH): void {
  jest.useFakeTimers({ now: new Date(iso), doNotFake: FAKE_ONLY_DATE });
}
