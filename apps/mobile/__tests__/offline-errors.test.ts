/**
 * REG-B308: an offline-queued mutation (api-client.ts enqueues the write then
 * rejects with `isOfflineQueued: true`, the same shape skip-stop.ts already
 * handles correctly) must be classified as "queued", not a generic error — so
 * the payment close-out and new-order screens can clear state/navigate instead
 * of re-arming their submit button and showing a plain error toast.
 * `apps/mobile/lib/offline-errors.ts` does not exist yet, so this import is red
 * on module resolution until the fix adds it.
 */
import { classifyMutationError, isStopAlreadyCompletedError } from "../lib/offline-errors";

describe("REG-B308 classifyMutationError", () => {
  it("REG-B308 an isOfflineQueued completion clears POD state, navigates back and does not re-arm the submit button", () => {
    const err = Object.assign(new Error("You are offline. Action queued."), {
      isOfflineQueued: true,
    });
    expect(classifyMutationError(err)).toEqual({
      kind: "queued",
      message: "You are offline. Action queued.",
    });
  });

  it("REG-B308 a server error message wins over the generic message", () => {
    const err = { response: { data: { message: "boom" } }, message: "generic message" };
    expect(classifyMutationError(err)).toEqual({ kind: "error", message: "boom" });
  });

  it("REG-B308 an unknown rejection falls back to Try again.", () => {
    expect(classifyMutationError(undefined)).toEqual({ kind: "error", message: "Try again." });
  });
});

/**
 * Driver-durability lane — payment.tsx's completeWithPayment mints a fresh
 * idempotency key on every manual retry, so a lost-response retry that lands
 * on the server's already-COMPLETED guard must be treated as success, never
 * a generic error. `isStopAlreadyCompletedError` does not exist yet on the
 * pre-fix code, so this import/usage is red on module resolution alone until
 * the fix adds it.
 */
describe("REG-DRIVER-DURABILITY-D isStopAlreadyCompletedError", () => {
  it("REG-DRIVER-DURABILITY-D classifies a 400 'Stop is already completed' as already-completed", () => {
    expect(
      isStopAlreadyCompletedError({
        response: { status: 400, data: { message: "Stop is already completed" } },
      }),
    ).toBe(true);
  });

  it("REG-DRIVER-DURABILITY-D matches case-insensitively (substring, not exact-string)", () => {
    expect(
      isStopAlreadyCompletedError({
        response: { status: 400, data: { message: "STOP IS ALREADY COMPLETED." } },
      }),
    ).toBe(true);
  });

  it("REG-DRIVER-DURABILITY-D leaves a DIFFERENT 400 alone — never any 400", () => {
    expect(
      isStopAlreadyCompletedError({
        response: { status: 400, data: { message: "Amount does not match" } },
      }),
    ).toBe(false);
  });

  it("REG-DRIVER-DURABILITY-D leaves a 500 with the same wording alone — status must be 400", () => {
    expect(
      isStopAlreadyCompletedError({
        response: { status: 500, data: { message: "Stop is already completed" } },
      }),
    ).toBe(false);
  });

  it("REG-DRIVER-DURABILITY-D leaves an offline-queued rejection alone", () => {
    expect(isStopAlreadyCompletedError({ isOfflineQueued: true })).toBe(false);
  });

  it("REG-DRIVER-DURABILITY-D leaves an unknown rejection alone", () => {
    expect(isStopAlreadyCompletedError(undefined)).toBe(false);
  });
});
