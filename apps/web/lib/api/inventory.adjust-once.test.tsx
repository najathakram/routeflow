import * as React from "react";
import { act, renderHook, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { useRecordAdjustment } from "./inventory";

/**
 * B1379 (UX audit 2026-11-24 F27): "Save adjustment" pressed twice applied the stock change twice: a product at -4,
 * +1 saved with a double click, read -2. The button only turns off on the next render, so both clicks reached the
 * request. The hook now sends one request for one action.
 */
const post = jest.fn();
jest.mock("../api-client", () => ({
  apiClient: { post: (...a: unknown[]) => post(...a), get: jest.fn() },
}));

const wrapper = ({ children }: { children: React.ReactNode }) => (
  <QueryClientProvider client={new QueryClient()}>{children}</QueryClientProvider>
);
const body = { productId: "p1", quantity: 1, reason: "DAMAGED" };

beforeEach(() => post.mockReset());

describe("REG-B1379 useRecordAdjustment: one save is one adjustment", () => {
  it("two saves of the same form in the same tick send ONE request", async () => {
    let finish!: (v: unknown) => void;
    post.mockImplementation(() => new Promise((res) => (finish = res)));
    const { result } = renderHook(() => useRecordAdjustment(), { wrapper });

    act(() => {
      result.current.mutate(body);
      result.current.mutate(body);
    });
    await waitFor(() => expect(post).toHaveBeenCalled());
    expect(post).toHaveBeenCalledTimes(1);
    expect(post).toHaveBeenCalledWith("/inventory/movements/adjustment", body);

    await act(async () => finish({ data: { ok: true } }));
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(post).toHaveBeenCalledTimes(1);
  });

  it("a second save while the first is still on its way (a slow double tap) sends nothing more", async () => {
    let finish!: (v: unknown) => void;
    post.mockImplementation(() => new Promise((res) => (finish = res)));
    const { result } = renderHook(() => useRecordAdjustment(), { wrapper });

    act(() => result.current.mutate(body));
    await waitFor(() => expect(post).toHaveBeenCalledTimes(1));
    act(() => result.current.mutate({ ...body }));
    await act(async () => finish({ data: { ok: true } }));
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(post).toHaveBeenCalledTimes(1);
  });

  it("after the first save has landed, the same adjustment can be saved again on purpose", async () => {
    post.mockResolvedValue({ data: { ok: true } });
    const { result } = renderHook(() => useRecordAdjustment(), { wrapper });
    await act(async () => void (await result.current.mutateAsync(body)));
    await act(async () => void (await result.current.mutateAsync(body)));
    expect(post).toHaveBeenCalledTimes(2);
  });
});
