import { classifyAtStopResolveError } from "../lib/at-stop-cr-outcome";

/**
 * B790 — every at-stop resolve failure other than a benign ALREADY_RESOLVED race
 * (someone else already settled this exact CR) must decline the just-created CR so
 * a retry never leaves a duplicate PENDING. The regulated guard is the one
 * deliberate exception: its own deferred Remove/Cancel decline owns that CR's
 * lifecycle (adjust.tsx's blockedCrRef), so classifyAtStopResolveError returns
 * `regulated` with no `reason` at all — the caller must never decline there.
 */
describe("classifyAtStopResolveError", () => {
  it("REG-B790: offline — no decline, no server error to key on", () => {
    expect(classifyAtStopResolveError({ isOfflineQueued: true })).toEqual({ action: "offline" });
    // B923: the create step is online-only now; its refusal is an offline outcome, not a decline.
    expect(classifyAtStopResolveError({ isOnlineRequired: true })).toEqual({ action: "offline" });
  });

  it("REG-B790: REGULATED_AUTH_REQUIRED — the deferred (not immediate) branch, blocked categories carried through", () => {
    const blocked = [{ id: "cat-1", name: "Tobacco" }];
    const e = {
      response: {
        status: 409,
        data: { code: "REGULATED_AUTH_REQUIRED", blockedCategories: blocked },
      },
    };
    expect(classifyAtStopResolveError(e)).toEqual({ action: "regulated", blocked });
  });

  it("CQ-06: a license refusal with no categories declines with the shared sentence, not server text", () => {
    const e = {
      response: {
        status: 409,
        data: { code: "REGULATED_AUTH_REQUIRED", message: "Conflict Exception" },
      },
    };
    const out = classifyAtStopResolveError(e);
    expect(out.action).toBe("decline");
    expect((out as { reason: string }).reason).toContain("Licenses tab");
    expect((out as { reason: string }).reason).not.toContain("Conflict Exception");
  });

  it("REG-B790: CHANGE_REQUEST_ALREADY_RESOLVED — the ONE case with no decline", () => {
    const e = { response: { status: 409, data: { code: "CHANGE_REQUEST_ALREADY_RESOLVED" } } };
    expect(classifyAtStopResolveError(e)).toEqual({ action: "already-resolved" });
  });

  it("REG-B795: ALREADY_RESOLVED carries the server's resolved status when present", () => {
    const e = {
      response: {
        status: 409,
        data: { code: "CHANGE_REQUEST_ALREADY_RESOLVED", status: "DECLINED" },
      },
    };
    expect(classifyAtStopResolveError(e)).toEqual({
      action: "already-resolved",
      status: "DECLINED",
    });
  });

  it("REG-B795: ALREADY_RESOLVED with no status omits the key entirely", () => {
    const e = { response: { status: 409, data: { code: "CHANGE_REQUEST_ALREADY_RESOLVED" } } };
    const out = classifyAtStopResolveError(e);
    expect(out).toEqual({ action: "already-resolved" });
    expect("status" in out).toBe(false);
  });

  it("REG-B790: CREDIT_LIMIT_EXCEEDED — declines, carries the server's own message as the reason", () => {
    const e = {
      response: {
        status: 409,
        data: {
          code: "CREDIT_LIMIT_EXCEEDED",
          limit: 500,
          exposure: 600,
          message: "This would exceed the customer's credit limit.",
        },
      },
    };
    expect(classifyAtStopResolveError(e)).toEqual({
      action: "credit",
      info: {
        limit: 500,
        exposure: 600,
        message: "This would exceed the customer's credit limit.",
      },
      reason: "This would exceed the customer's credit limit.",
    });
  });

  it("REG-B790: LINE_ALREADY_DELIVERED declines with the server's message", () => {
    const e = {
      response: {
        status: 409,
        data: { code: "LINE_ALREADY_DELIVERED", message: "That line was already delivered." },
      },
    };
    expect(classifyAtStopResolveError(e)).toEqual({
      action: "decline",
      reason: "That line was already delivered.",
    });
  });

  it("REG-B790: STOP_ALREADY_COMPLETED declines with the server's message", () => {
    const e = {
      response: {
        status: 409,
        data: { code: "STOP_ALREADY_COMPLETED", message: "This stop is already complete." },
      },
    };
    expect(classifyAtStopResolveError(e)).toEqual({
      action: "decline",
      reason: "This stop is already complete.",
    });
  });

  it("REG-B790: CHANGE_WINDOW_CLOSED declines with the server's message", () => {
    const e = {
      response: {
        status: 409,
        data: { code: "CHANGE_WINDOW_CLOSED", message: "This order can no longer be changed." },
      },
    };
    expect(classifyAtStopResolveError(e)).toEqual({
      action: "decline",
      reason: "This order can no longer be changed.",
    });
  });

  it("REG-B790: an UNKNOWN/future code (e.g. B753's) still declines — the safe default, no new branch needed", () => {
    const e = {
      response: {
        status: 409,
        data: { code: "SOME_FUTURE_CODE", message: "A brand new refusal." },
      },
    };
    expect(classifyAtStopResolveError(e)).toEqual({
      action: "decline",
      reason: "A brand new refusal.",
    });
  });

  it("REG-B790: a 409 with no message at all still declines, with a safe fallback reason", () => {
    expect(classifyAtStopResolveError({ response: { status: 409, data: {} } })).toEqual({
      action: "decline",
      reason: "Couldn't save that change.",
    });
    expect(classifyAtStopResolveError(new Error("network exploded"))).toEqual({
      action: "decline",
      reason: "network exploded",
    });
  });
});
