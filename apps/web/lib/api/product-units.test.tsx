import * as React from "react";
import { renderHook } from "@testing-library/react";
import { QueryClientProvider } from "@tanstack/react-query";
import { createTestQueryClient } from "@/test-utils/render";
import { act } from "@testing-library/react";
import { apiClient } from "../api-client";
import {
  UNITS_FLAG,
  productUnitsKey,
  useCreateProductUnit,
  useDeleteProductUnit,
  useUnitsEnabled,
  useUpdateProductUnit,
} from "./product-units";
import { priceGridKey } from "./usePriceGrid";

jest.mock("../api-client", () => ({
  apiClient: { post: jest.fn(), patch: jest.fn(), delete: jest.fn(), get: jest.fn() },
}));

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

describe("unit mutations refresh the price grid (B1245)", () => {
  const cases = [
    ["create", () => useCreateProductUnit("p1"), "post", { name: "Piece" }],
    ["update", () => useUpdateProductUnit("p1"), "patch", { id: "u1", name: "Pc" }],
    ["delete", () => useDeleteProductUnit("p1"), "delete", "u1"],
  ] as const;

  it.each(cases)("%s invalidates the units key and the price grid", async (_n, hook, verb, arg) => {
    (apiClient as unknown as Record<string, jest.Mock>)[verb].mockResolvedValue({ data: {} });
    const qc = createTestQueryClient();
    const spy = jest.spyOn(qc, "invalidateQueries");
    const w = ({ children }: { children: React.ReactNode }) => (
      <QueryClientProvider client={qc}>{children}</QueryClientProvider>
    );
    const { result } = renderHook(hook as () => { mutateAsync: (a: unknown) => Promise<unknown> }, {
      wrapper: w,
    });
    await act(async () => {
      await result.current.mutateAsync(arg);
    });
    expect(spy).toHaveBeenCalledWith({ queryKey: productUnitsKey("p1") });
    expect(spy).toHaveBeenCalledWith({ queryKey: priceGridKey("p1") });
  });
});
