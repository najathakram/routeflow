import { renderHook } from "@testing-library/react";
import { SCAN_V2_FLAG, useScanV2Enabled } from "./useScanV2Enabled";

const mockUseSubscription = jest.fn();
jest.mock("@/lib/api/billing", () => ({
  useSubscription: (opts: unknown) => mockUseSubscription(opts),
}));

const sub = (o: { isSuccess?: boolean; flags?: unknown; noData?: boolean }) => ({
  isSuccess: o.isSuccess ?? true,
  data: o.noData ? undefined : { flags: o.flags },
});

const enabled = () => renderHook(() => useScanV2Enabled()).result.current;

describe("useScanV2Enabled - dark by default", () => {
  beforeEach(() => mockUseSubscription.mockReset());

  it("reads the flag.scan_v2 key", () => {
    expect(SCAN_V2_FLAG).toBe("flag.scan_v2");
  });

  it("is ON only for a resolved subscription whose flags array contains the key", () => {
    mockUseSubscription.mockReturnValue(sub({ flags: ["flag.msrp", "flag.scan_v2"] }));
    expect(enabled()).toBe(true);
  });

  it("is OFF for a resolved subscription that was never granted the flag", () => {
    mockUseSubscription.mockReturnValue(sub({ flags: ["flag.msrp"] }));
    expect(enabled()).toBe(false);
  });

  it("is OFF while the subscription is still loading", () => {
    mockUseSubscription.mockReturnValue(sub({ isSuccess: false, noData: true }));
    expect(enabled()).toBe(false);
  });

  it("is OFF when the subscription failed to load", () => {
    mockUseSubscription.mockReturnValue(sub({ isSuccess: false, noData: true }));
    expect(enabled()).toBe(false);
  });

  it("is OFF when a SUCCESSFUL response omits `flags` - usePlanFlag would fail OPEN here, this must not", () => {
    mockUseSubscription.mockReturnValue(sub({ flags: undefined }));
    expect(enabled()).toBe(false);
  });

  it("is OFF for a malformed flags value (not an array)", () => {
    mockUseSubscription.mockReturnValue(sub({ flags: "flag.scan_v2" }));
    expect(enabled()).toBe(false);
    mockUseSubscription.mockReturnValue(sub({ flags: { "flag.scan_v2": true } }));
    expect(enabled()).toBe(false);
  });

  it("is OFF for stale data that is not yet a success (isSuccess false)", () => {
    mockUseSubscription.mockReturnValue({ isSuccess: false, data: { flags: ["flag.scan_v2"] } });
    expect(enabled()).toBe(false);
  });
});
