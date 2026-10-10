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
const V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
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

  it("a definitive 4xx drops the held id: the next park mints a new one (a refused id is never reused)", async () => {
    api.post
      .mockRejectedValueOnce({ response: { status: 409, data: { code: "PARK_ID_CONFLICT" } } })
      .mockResolvedValue({ data: { id: "x" } });
    const { result } = setup(() => usePark());
    await act(async () => {
      await result.current.mutateAsync(payload()).catch(() => undefined);
    });
    await act(async () => {
      await result.current.mutateAsync(payload());
    });
    expect(api.post.mock.calls[1][1].id).not.toBe(api.post.mock.calls[0][1].id);
  });

  it("a 5xx or a network error keeps the held id; 408 and 429 keep it too", async () => {
    api.post
      .mockRejectedValueOnce({ response: { status: 503 } })
      .mockRejectedValueOnce({})
      .mockRejectedValueOnce({ response: { status: 429 } })
      .mockResolvedValue({ data: { id: "x" } });
    const { result } = setup(() => usePark());
    for (let i = 0; i < 4; i++)
      await act(async () => {
        await result.current.mutateAsync(payload()).catch(() => undefined);
      });
    const ids = api.post.mock.calls.map((c) => c[1].id);
    expect(new Set(ids).size).toBe(1);
  });

  it("resuming the held park's row drops the held id: park -> lost answer -> resume -> park again is a NEW park", async () => {
    api.post
      .mockRejectedValueOnce({ response: { status: 503 } }) // the park whose answer was lost
      .mockResolvedValueOnce({ data: { id: "held", payload: payload() } }) // resume of that row
      .mockResolvedValue({ data: { id: "y" } });
    const { result } = setup(() => ({ park: usePark(), resume: useResume() }));
    await act(async () => {
      await result.current.park.mutateAsync(payload()).catch(() => undefined);
    });
    const heldId = api.post.mock.calls[0][1].id;
    await act(async () => {
      await result.current.resume.mutateAsync(heldId);
    });
    await act(async () => {
      await result.current.park.mutateAsync(payload());
    });
    expect(api.post.mock.calls[2][1].id).not.toBe(heldId);
  });

  it("resuming some OTHER row leaves the held park id alone", async () => {
    api.post
      .mockRejectedValueOnce({ response: { status: 503 } })
      .mockResolvedValueOnce({ data: { id: "other", payload: payload() } })
      .mockResolvedValue({ data: { id: "y" } });
    const { result } = setup(() => ({ park: usePark(), resume: useResume() }));
    await act(async () => {
      await result.current.park.mutateAsync(payload()).catch(() => undefined);
    });
    await act(async () => {
      await result.current.resume.mutateAsync("00000000-0000-4000-8000-0000000000aa");
    });
    await act(async () => {
      await result.current.park.mutateAsync(payload());
    });
    expect(api.post.mock.calls[2][1].id).toBe(api.post.mock.calls[0][1].id);
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
    expect(api.post).toHaveBeenCalledWith("/orders/counter-sale/parked/a%20b/resume", {
      resumeAttemptId: expect.stringMatching(V4),
    });
    expect((res as { payload: unknown }).payload).toEqual(payload());
  });
  it("each resume TAP mints its own attempt id; only a lost answer (network / 5xx) reuses it for that cart", async () => {
    api.post
      .mockRejectedValueOnce({}) // tap 1: answer lost
      .mockResolvedValueOnce({ data: { id: "p1" } }) // tap 1 again: same tap, same attempt id
      .mockResolvedValueOnce({ data: { id: "p1" } }) // a later tap on the same cart after success: new id
      .mockRejectedValueOnce({ response: { status: 404, data: { code: "PARK_TAKEN" } } }) // definitive
      .mockResolvedValue({ data: { id: "p2" } });
    const { result } = setup(() => useResume());
    const run = (id: string) =>
      act(async () => {
        await result.current.mutateAsync(id).catch(() => undefined);
      });
    await run("p1");
    await run("p1");
    await run("p1");
    await run("p1"); // 404: dropped
    await run("p1"); // a new tap after a definitive answer
    const attempts = api.post.mock.calls.map((c) => c[1].resumeAttemptId);
    expect(attempts[1]).toBe(attempts[0]);
    expect(attempts[2]).not.toBe(attempts[0]);
    expect(attempts[4]).not.toBe(attempts[3]);
    for (const a of attempts) expect(a).toMatch(V4);
  });
  it("a resume of a DIFFERENT cart never reuses another cart's attempt id", async () => {
    api.post.mockRejectedValueOnce({}).mockResolvedValue({ data: { id: "x" } });
    const { result } = setup(() => useResume());
    await act(async () => {
      await result.current.mutateAsync("p1").catch(() => undefined);
    });
    await act(async () => {
      await result.current.mutateAsync("p2");
    });
    expect(api.post.mock.calls[1][1].resumeAttemptId).not.toBe(
      api.post.mock.calls[0][1].resumeAttemptId,
    );
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
