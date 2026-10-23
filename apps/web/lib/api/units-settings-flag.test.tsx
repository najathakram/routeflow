import * as React from "react";
import { renderHook } from "@testing-library/react";
import { QueryClientProvider } from "@tanstack/react-query";
import { createTestQueryClient } from "@/test-utils/render";
import {
  UNITS_SETTINGS_FLAG,
  useUnitsSettingsEnabled,
  useUnitsSettingsFlag,
} from "./units-settings-flag";

const mockSubscription = jest.fn();
jest.mock("./billing", () => ({ useSubscription: (o: unknown) => mockSubscription(o) }));

const wrapper = ({ children }: { children: React.ReactNode }) => (
  <QueryClientProvider client={createTestQueryClient()}>{children}</QueryClientProvider>
);

describe("Settings > Units flag (flag.units_settings_v1), fail CLOSED", () => {
  it("is its own key, not flag.units_v1", () => {
    expect(UNITS_SETTINGS_FLAG).toBe("flag.units_settings_v1");
  });

  it("is false while the subscription is unknown or has no flags array", () => {
    for (const data of [undefined, {}, { flags: undefined }]) {
      mockSubscription.mockReturnValue({ data });
      expect(renderHook(() => useUnitsSettingsEnabled(), { wrapper }).result.current).toBe(false);
    }
  });

  it("flag.units_v1 alone does NOT open Settings > Units", () => {
    mockSubscription.mockReturnValue({ data: { flags: ["flag.units_v1"] } });
    expect(renderHook(() => useUnitsSettingsEnabled(), { wrapper }).result.current).toBe(false);
  });

  it("is true when flag.units_settings_v1 is served", () => {
    mockSubscription.mockReturnValue({ data: { flags: [UNITS_SETTINGS_FLAG] } });
    expect(renderHook(() => useUnitsSettingsEnabled(), { wrapper }).result.current).toBe(true);
  });

  it("reports loading / error / refetch so the page can tell 'not granted' from 'could not ask'", () => {
    const refetch = jest.fn();
    mockSubscription.mockReturnValue({ data: undefined, isLoading: true, isError: true, refetch });
    const { result } = renderHook(() => useUnitsSettingsFlag(), { wrapper });
    expect(result.current).toMatchObject({ enabled: false, isLoading: true, isError: true });
    result.current.refetch();
    expect(refetch).toHaveBeenCalledTimes(1);
  });

  it("passes the enabled option through so non-operators never fire the billing request", () => {
    mockSubscription.mockReturnValue({ data: undefined });
    renderHook(() => useUnitsSettingsEnabled({ enabled: false }), { wrapper });
    expect(mockSubscription).toHaveBeenCalledWith(expect.objectContaining({ enabled: false }));
  });
});
