import { renderHook } from "@testing-library/react";
import { DEVELOPER_MODE_ADDON } from "@routeflow/types";
import { useScanV2 } from "./addons";

const mockUseTenantAddons = jest.fn();
jest.mock("./tobacco", () => ({
  useTenantAddons: () => mockUseTenantAddons(),
}));

const enabled = () => renderHook(() => useScanV2()).result.current;

describe("useScanV2 - dark by default, rides the developer_mode addon", () => {
  beforeEach(() => mockUseTenantAddons.mockReset());

  it("is ON only when the addons fetch succeeded and lists developer_mode", () => {
    mockUseTenantAddons.mockReturnValue({
      data: { addons: [DEVELOPER_MODE_ADDON] },
      isLoading: false,
      isSuccess: true,
    });
    expect(enabled()).toBe(true);
  });

  it("is OFF for a tenant that was never granted the addon", () => {
    mockUseTenantAddons.mockReturnValue({
      data: { addons: ["some_other_addon"] },
      isLoading: false,
      isSuccess: true,
    });
    expect(enabled()).toBe(false);
  });

  it("is OFF while the addons are still loading", () => {
    mockUseTenantAddons.mockReturnValue({ data: undefined, isLoading: true, isSuccess: false });
    expect(enabled()).toBe(false);
  });

  it("is OFF when the addons fetch failed", () => {
    mockUseTenantAddons.mockReturnValue({ data: undefined, isLoading: false, isSuccess: false });
    expect(enabled()).toBe(false);
  });

  it("is OFF when a successful response carries no addons list", () => {
    mockUseTenantAddons.mockReturnValue({ data: {}, isLoading: false, isSuccess: true });
    expect(enabled()).toBe(false);
  });
});
