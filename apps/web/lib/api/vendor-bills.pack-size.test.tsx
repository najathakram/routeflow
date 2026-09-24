/**
 * B743 PR B (REG-B743-web): the receive call sends acknowledgePackSizeUnknown ONLY when the
 * operator chose it, and the refusal is recognised from the API's 409.
 */
import * as React from "react";
import { act, renderHook } from "@testing-library/react";
import { QueryClientProvider } from "@tanstack/react-query";
import { createTestQueryClient } from "@/test-utils/render";
import { apiClient } from "@/lib/api-client";
import { getPackSizeUnknownError, useReceiveVendorBill } from "./vendor-bills";

jest.mock("@/lib/api-client", () => ({
  apiClient: { get: jest.fn(), post: jest.fn(), patch: jest.fn(), delete: jest.fn() },
}));
const mockedPost = apiClient.post as jest.Mock;

function Wrapper({ children }: { children: React.ReactNode }) {
  const [client] = React.useState(createTestQueryClient);
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}

beforeEach(() => {
  jest.clearAllMocks();
  mockedPost.mockResolvedValue({ data: { status: "RECEIVED", gapsDetected: [] } });
});

describe("B743 — receive payload and the PACK_SIZE_UNKNOWN refusal (REG-B743-web)", () => {
  it("a plain receive never sends acknowledgePackSizeUnknown", async () => {
    const { result } = renderHook(() => useReceiveVendorBill(), { wrapper: Wrapper });
    await act(() => result.current.mutateAsync({ id: "bill-1", acknowledgeUnlinked: true }));
    expect(mockedPost).toHaveBeenCalledWith("/vendor-bills/bill-1/receive", {
      acknowledgeUnlinked: true,
    });
  });

  it("the explicit loose-pieces choice sends it", async () => {
    const { result } = renderHook(() => useReceiveVendorBill(), { wrapper: Wrapper });
    await act(() => result.current.mutateAsync({ id: "bill-1", acknowledgePackSizeUnknown: true }));
    expect(mockedPost).toHaveBeenCalledWith("/vendor-bills/bill-1/receive", {
      acknowledgePackSizeUnknown: true,
    });
  });

  it("getPackSizeUnknownError recognises only the PACK_SIZE_UNKNOWN 409", () => {
    const data = { code: "PACK_SIZE_UNKNOWN", message: "m", packSizeUnknownItems: [] };
    expect(getPackSizeUnknownError({ response: { status: 409, data } })).toBe(data);
    expect(getPackSizeUnknownError({ response: { data: { code: "UNLINKED_ITEMS" } } })).toBeNull();
    expect(getPackSizeUnknownError(new Error("network"))).toBeNull();
  });
});
