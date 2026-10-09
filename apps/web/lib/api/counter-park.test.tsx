import * as React from "react";
import { act, renderHook, waitFor } from "@testing-library/react";
import { QueryClientProvider } from "@tanstack/react-query";
import { createTestQueryClient } from "@/test-utils/render";
import { apiClient } from "@/lib/api-client";
import { useDiscard, usePark, useParkedCarts, useResume } from "./counter-park";

jest.mock("@/lib/api-client", () => ({
  apiClient: { get: jest.fn(), post: jest.fn(), delete: jest.fn() },
}));
const api = apiClient as unknown as Record<"get" | "post" | "delete", jest.Mock>;

const payload = (name = "Cola") => ({
  lines: [{ tempId: "t1", productId: "p1", name, unitPrice: 2.5, qty: 1 }],
  customer: null,
  method: "CASH",
  tendered: "",
  reference: "",
});
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

function setup<T>(hook: () => T) {
  const qc = createTestQueryClient();
  const wrapper = ({ children }: { children: React.ReactNode }) => (
    <QueryClientProvider client={qc}>{children}</QueryClientProvider>
  );
  return { qc, ...renderHook(hook, { wrapper }) };
}

beforeEach(() => {
  jest.clearAllMocks();
  api.get.mockResolvedValue({ data: { data: [], total: 0, page: 1, pageSize: 20 } });
});

describe("useParkedCarts", () => {
  it("GETs page 1 with no register by default", async () => {
    const { result } = setup(() => useParkedCarts());
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(api.get).toHaveBeenCalledWith("/orders/counter-sale/parked", { params: { page: 1 } });
  });
  it("sends the register key when one is named", async () => {
    const { result } = setup(() => useParkedCarts("front"));
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(api.get).toHaveBeenCalledWith("/orders/counter-sale/parked", {
      params: { register: "front", page: 1 },
    });
  });
});

describe("usePark", () => {
  it("POSTs a client-minted UUID with the payload", async () => {
    api.post.mockResolvedValue({ data: { id: "x" } });
    const { result } = setup(() => usePark());
    await act(async () => {
      await result.current.mutateAsync(payload());
    });
    const [url, body] = api.post.mock.calls[0];
    expect(url).toBe("/orders/counter-sale/parked");
    expect(body.id).toMatch(UUID);
    expect(body.payload).toEqual(payload());
    expect(Object.keys(body).sort()).toEqual(["id", "payload"]);
  });

  it("a retry of the same park after a failure reuses the id; a changed cart or a new park mints another", async () => {
    api.post
      .mockRejectedValueOnce({ response: { status: 500 } })
      .mockResolvedValueOnce({ data: { id: "x" } })
      .mockResolvedValue({ data: { id: "y" } });
    const { result } = setup(() => usePark());
    await act(async () => {
      await result.current.mutateAsync(payload()).catch(() => undefined);
    });
    await act(async () => {
      await result.current.mutateAsync(payload());
    });
    const first = api.post.mock.calls[0][1].id;
    expect(api.post.mock.calls[1][1].id).toBe(first); // the lost response never makes two rows
    await act(async () => {
      await result.current.mutateAsync(payload()); // a NEW park after a success
    });
    expect(api.post.mock.calls[2][1].id).not.toBe(first);
  });

  it("an edited cart is a different park: a new id", async () => {
    api.post.mockRejectedValue({ response: { status: 500 } });
    const { result } = setup(() => usePark());
    await act(async () => {
      await result.current.mutateAsync(payload("Cola")).catch(() => undefined);
    });
    await act(async () => {
      await result.current.mutateAsync(payload("Water")).catch(() => undefined);
    });
    expect(api.post.mock.calls[1][1].id).not.toBe(api.post.mock.calls[0][1].id);
  });

  it("refreshes the list after a park", async () => {
    api.post.mockResolvedValue({ data: { id: "x" } });
    const { result } = setup(() => ({ list: useParkedCarts(), park: usePark() }));
    await waitFor(() => expect(result.current.list.isSuccess).toBe(true));
    api.get.mockClear();
    await act(async () => {
      await result.current.park.mutateAsync(payload());
    });
    await waitFor(() => expect(api.get).toHaveBeenCalledTimes(1));
  });
});

describe("useResume / useDiscard", () => {
  it("resume POSTs .../parked/:id/resume and returns the server payload", async () => {
    api.post.mockResolvedValue({
      data: { id: "a b", label: "L", createdAt: "t", payload: payload() },
    });
    const { result } = setup(() => useResume());
    let res: unknown;
    await act(async () => {
      res = await result.current.mutateAsync("a b");
    });
    expect(api.post).toHaveBeenCalledWith("/orders/counter-sale/parked/a%20b/resume");
    expect((res as { payload: unknown }).payload).toEqual(payload());
  });
  it("discard DELETEs .../parked/:id", async () => {
    api.delete.mockResolvedValue({ data: {} });
    const { result } = setup(() => useDiscard());
    await act(async () => {
      await result.current.mutateAsync("p1");
    });
    expect(api.delete).toHaveBeenCalledWith("/orders/counter-sale/parked/p1");
  });
  it("a refused resume (PARK_TAKEN) still refreshes the list", async () => {
    api.post.mockRejectedValue({ response: { status: 404, data: { code: "PARK_TAKEN" } } });
    const { result } = setup(() => ({ list: useParkedCarts(), resume: useResume() }));
    await waitFor(() => expect(result.current.list.isSuccess).toBe(true));
    api.get.mockClear();
    await act(async () => {
      await result.current.resume.mutateAsync("p1").catch(() => undefined);
    });
    await waitFor(() => expect(api.get).toHaveBeenCalledTimes(1));
  });
});
