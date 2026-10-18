import * as React from "react";
import { renderHook } from "@testing-library/react";
import { QueryClientProvider } from "@tanstack/react-query";
import { createTestQueryClient } from "@/test-utils/render";
import { act } from "react";
import {
  UNITS_FLAG,
  useCreateProductUnit,
  useDeleteProductUnit,
  useUnitsEnabled,
  useUpdateProductUnit,
} from "./product-units";
import { priceGridKey } from "./usePriceGrid";

const mockApi = { post: jest.fn(), patch: jest.fn(), delete: jest.fn() };
jest.mock("../api-client", () => ({
  apiClient: {
    post: (...a: unknown[]) => mockApi.post(...a),
    patch: (...a: unknown[]) => mockApi.patch(...a),
    delete: (...a: unknown[]) => mockApi.delete(...a),
  },
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

describe("unit writes refresh the price grid (B1245)", () => {
  const setup = () => {
    const qc = createTestQueryClient();
    const spy = jest.spyOn(qc, "invalidateQueries");
    const w = ({ children }: { children: React.ReactNode }) => (
      <QueryClientProvider client={qc}>{children}</QueryClientProvider>
    );
    return { spy, w };
  };
  const keys = (spy: jest.SpyInstance) =>
    spy.mock.calls.map((c) => (c[0] as { queryKey: unknown }).queryKey);

  beforeEach(() => {
    mockApi.post.mockResolvedValue({ data: {} });
    mockApi.patch.mockResolvedValue({ data: {} });
    mockApi.delete.mockResolvedValue({ data: {} });
  });

  it.each([
    ["add", () => useCreateProductUnit("p1"), "mutateAsync", { label: "Case", factorToBase: 12 }],
    ["update", () => useUpdateProductUnit("p1"), "mutateAsync", { id: "u1", label: "Box" }],
    ["delete", () => useDeleteProductUnit("p1"), "mutateAsync", "u1"],
  ] as const)("a %s invalidates the units list AND the price grid", async (_n, hook, fn, arg) => {
    const { spy, w } = setup();
    const { result } = renderHook(
      hook as unknown as () => Record<string, (a: unknown) => Promise<unknown>>,
      { wrapper: w },
    );
    await act(async () => {
      await result.current[fn](arg);
    });
    expect(keys(spy)).toEqual(
      expect.arrayContaining([["products", "p1", "units"], priceGridKey("p1")]),
    );
  });
});
