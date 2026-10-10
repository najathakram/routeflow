import { isScanPlanLock, scanPoAccess } from "./scan-po-lock";

describe("scanPoAccess", () => {
  it("is open when the plan grants the scan flag", () => {
    expect(scanPoAccess({ enabled: true, resolved: true, failed: false })).toBe("open");
  });
  it("is locked when a resolved plan lacks the flag", () => {
    expect(scanPoAccess({ enabled: false, resolved: true, failed: false })).toBe("locked");
  });
  it("is pending (disabled, never fail-open) while the plan is unresolved", () => {
    expect(scanPoAccess({ enabled: true, resolved: false, failed: false })).toBe("pending");
  });
  it("lets the server decide when the plan read failed", () => {
    expect(scanPoAccess({ enabled: true, resolved: false, failed: true })).toBe("open");
  });
});

describe("isScanPlanLock", () => {
  it("recognises the PLAN_GATE 403", () => {
    expect(isScanPlanLock({ response: { status: 403, data: { code: "PLAN_GATE" } } })).toBe(true);
  });
  it("a bare 403 (role / add-on denial) is not a plan lock", () => {
    expect(isScanPlanLock({ response: { status: 403 } })).toBe(false);
    expect(isScanPlanLock({ response: { status: 403, data: { code: "ADDON_GATE" } } })).toBe(false);
  });
  it("ignores other errors", () => {
    expect(isScanPlanLock({ response: { status: 500 } })).toBe(false);
    expect(isScanPlanLock(new Error("boom"))).toBe(false);
    expect(isScanPlanLock(null)).toBe(false);
  });
});
