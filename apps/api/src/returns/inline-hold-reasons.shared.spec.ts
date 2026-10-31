/**
 * SA-1060 PR-1 (MUST 3): `INLINE_HOLD_REASONS` is ONE list, in `@routeflow/types`, read by the service and by the held-returns
 * screen. A copy typed in either place is how the screen and the server drift apart (L-072). The list is the approvable holds:
 * every one is a known hold reason, and a return held for any other reason is not an approval.
 */
import {
  INLINE_HOLD_REASONS,
  RETURN_HOLD_REASON_VALUES,
  isInlineHoldReason,
} from "@routeflow/types";
import { INLINE_HOLD_REASONS as SERVICE_HOLD_REASONS } from "./inline-returns.service";

describe("INLINE_HOLD_REASONS (shared)", () => {
  it("is the two holds staff approve, in the order the screen asks for them", () => {
    expect([...INLINE_HOLD_REASONS]).toEqual(["DRIVER_CAP", "ALREADY_RETURNED"]);
  });

  it("every entry is a known hold reason", () => {
    for (const r of INLINE_HOLD_REASONS) expect(RETURN_HOLD_REASON_VALUES).toContain(r);
  });

  it("is the very list the service approves and rejects by (the api cannot import it at runtime, so the two are pinned equal)", () => {
    expect([...SERVICE_HOLD_REASONS]).toEqual([...INLINE_HOLD_REASONS]);
  });

  it("isInlineHoldReason accepts exactly the list", () => {
    for (const r of RETURN_HOLD_REASON_VALUES) {
      expect(isInlineHoldReason(r)).toBe((INLINE_HOLD_REASONS as readonly string[]).includes(r));
    }
    expect(isInlineHoldReason(null)).toBe(false);
    expect(isInlineHoldReason(undefined)).toBe(false);
    expect(isInlineHoldReason("driver_cap")).toBe(false);
  });
});
