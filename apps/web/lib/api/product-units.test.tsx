import * as React from "react";
import { renderHook } from "@testing-library/react";
import { QueryClientProvider } from "@tanstack/react-query";
import { createTestQueryClient } from "@/test-utils/render";
import { UNITS_FLAG, useUnitsEnabled } from "./product-units";

const mockSubscription = jest.fn();
jest.mock("./billing", () => ({ useSubscription: (o: unknown) => mockSubscription(o) }));

const wrapper = ({ children }: { children: React.ReactNode }) => (
  <QueryClientProvider client={createTestQueryClient()}>{children}</QueryClientProvider>
);

describe("useUnitsEnabled — fail CLOSED", () => {
  it("is false while the subscription is unknown / errored / has no flags array", () => {
    for (const data of [undefined, {}, { flags: undefined }]) {
      mockSubscription.mockReturnValue({ data });
      expect(renderHook(() => useUnitsEnabled(), { wrapper }).result.current).toBe(false);
    }
  });

  it("is false when the flag is not among the served flags", () => {
    mockSubscription.mockReturnValue({ data: { flags: ["flag.msrp"] } });
    expect(renderHook(() => useUnitsEnabled(), { wrapper }).result.current).toBe(false);
  });

  it("is true only when flag.units_v1 is served", () => {
    mockSubscription.mockReturnValue({ data: { flags: ["flag.msrp", UNITS_FLAG] } });
    expect(renderHook(() => useUnitsEnabled(), { wrapper }).result.current).toBe(true);
  });

  it("passes the enabled option through so non-operators never fire the billing request", () => {
    mockSubscription.mockReturnValue({ data: undefined });
    renderHook(() => useUnitsEnabled({ enabled: false }), { wrapper });
    expect(mockSubscription).toHaveBeenCalledWith(expect.objectContaining({ enabled: false }));
  });
});
