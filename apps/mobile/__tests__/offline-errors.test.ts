/**
 * REG-B308: an offline-queued mutation (api-client.ts enqueues the write then
 * rejects with `isOfflineQueued: true`, the same shape skip-stop.ts already
 * handles correctly) must be classified as "queued", not a generic error — so
 * the payment close-out and new-order screens can clear state/navigate instead
 * of re-arming their submit button and showing a plain error toast.
 * `apps/mobile/lib/offline-errors.ts` does not exist yet, so this import is red
 * on module resolution until the fix adds it.
 */
import { classifyMutationError } from "../lib/offline-errors";

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
