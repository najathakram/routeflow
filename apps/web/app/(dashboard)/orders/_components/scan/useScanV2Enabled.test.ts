import { renderHook } from "@testing-library/react";
import { SCAN_V2_FLAG, useScanV2Enabled } from "./useScanV2Enabled";

const mockUsePlanFlag = jest.fn();
jest.mock("@/lib/api/plan-flags", () => ({
  usePlanFlag: (key: string) => mockUsePlanFlag(key),
}));

const state = (o: Partial<{ enabled: boolean; resolved: boolean; failed: boolean }>) => ({
  enabled: false,
  resolved: false,
  failed: false,
  ...o,
});

describe("useScanV2Enabled — dark by default", () => {
  beforeEach(() => mockUsePlanFlag.mockReset());

  it("reads the flag.scan_v2 key", () => {
    mockUsePlanFlag.mockReturnValue(state({}));
    renderHook(() => useScanV2Enabled());
    expect(mockUsePlanFlag).toHaveBeenCalledWith("flag.scan_v2");
    expect(SCAN_V2_FLAG).toBe("flag.scan_v2");
  });

  it("is ON only when the subscription resolved AND the tenant is granted the flag", () => {
    mockUsePlanFlag.mockReturnValue(state({ enabled: true, resolved: true }));
    expect(renderHook(() => useScanV2Enabled()).result.current).toBe(true);
  });

  it("is OFF while the subscription is still loading — usePlanFlag fails OPEN (enabled: true, resolved: false), which is wrong for an opt-in UI", () => {
    mockUsePlanFlag.mockReturnValue(state({ enabled: true, resolved: false }));
    expect(renderHook(() => useScanV2Enabled()).result.current).toBe(false);
  });

  it("is OFF when the subscription failed to load", () => {
    mockUsePlanFlag.mockReturnValue(state({ enabled: true, resolved: false, failed: true }));
    expect(renderHook(() => useScanV2Enabled()).result.current).toBe(false);
  });

  it("is OFF for a resolved tenant that was never granted the flag", () => {
    mockUsePlanFlag.mockReturnValue(state({ enabled: false, resolved: true }));
    expect(renderHook(() => useScanV2Enabled()).result.current).toBe(false);
  });
});
