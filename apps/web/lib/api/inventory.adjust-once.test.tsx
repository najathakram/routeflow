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
    expect(post).toHaveBeenCalledWith("/inventory/movements/adjustment", body, {
      headers: { "Idempotency-Key": expect.any(String) },
    });

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

/**
 * B1415 M1b (SA-1504 R5): the server replays an `Idempotency-Key`, so the form sends one per ATTEMPT. The same body keeps
 * its key (a double tap, a retry after an unknown outcome), a success or a refusal that wrote nothing drops it, and an
 * edited body is a different attempt with a new key.
 */
const keyOf = (call: unknown[]) =>
  (call[2] as { headers: Record<string, string> }).headers["Idempotency-Key"];

describe("REG-B1415 useRecordAdjustment: one Idempotency-Key per attempt", () => {
  it("a save carries a non-empty key as the Idempotency-Key header, not in the body", async () => {
    post.mockResolvedValue({ data: { ok: true } });
    const { result } = renderHook(() => useRecordAdjustment(), { wrapper });
    await act(async () => void (await result.current.mutateAsync(body)));
    expect(keyOf(post.mock.calls[0]).length).toBeGreaterThan(8);
    expect(post.mock.calls[0][1]).toEqual(body); // the key is a header, never in the body
  });

  it("a retry after a network error carries the SAME key (the first call may have landed)", async () => {
    post
      .mockRejectedValueOnce(new Error("Network Error"))
      .mockResolvedValue({ data: { ok: true } });
    const { result } = renderHook(() => useRecordAdjustment(), { wrapper });
    await act(async () => void (await result.current.mutateAsync(body).catch(() => undefined)));
    await act(async () => void (await result.current.mutateAsync(body)));
    expect(post).toHaveBeenCalledTimes(2);
    expect(keyOf(post.mock.calls[1])).toBe(keyOf(post.mock.calls[0]));
  });

  it("after a success the next deliberate adjustment gets a FRESH key", async () => {
    post.mockResolvedValue({ data: { ok: true } });
    const { result } = renderHook(() => useRecordAdjustment(), { wrapper });
    await act(async () => void (await result.current.mutateAsync(body)));
    await act(async () => void (await result.current.mutateAsync(body)));
    expect(keyOf(post.mock.calls[1])).not.toBe(keyOf(post.mock.calls[0]));
  });

  it("an edited body with nothing unknown is a different attempt: it gets a new key", async () => {
    post.mockRejectedValue(
      Object.assign(new Error("Bad Request"), { response: { status: 400, data: {} } }),
    );
    const { result } = renderHook(() => useRecordAdjustment(), { wrapper });
    await act(async () => void (await result.current.mutateAsync(body).catch(() => undefined)));
    await act(async () => {
      await result.current.mutateAsync({ ...body, quantity: 2 }).catch(() => undefined);
    });
    expect(keyOf(post.mock.calls[1])).not.toBe(keyOf(post.mock.calls[0]));
  });

  it("an edit after an UNKNOWN outcome keeps the key: Save +50, a dropped connection, edit to +5, Save", async () => {
    post.mockRejectedValue(new Error("Network Error"));
    const { result } = renderHook(() => useRecordAdjustment(), { wrapper });
    await act(
      async () =>
        void (await result.current.mutateAsync({ ...body, quantity: 50 }).catch(() => undefined)),
    );
    await act(
      async () =>
        void (await result.current.mutateAsync({ ...body, quantity: 5 }).catch(() => undefined)),
    );
    expect(keyOf(post.mock.calls[1])).toBe(keyOf(post.mock.calls[0]));
  });

  it("the key-reuse 409 clears the key and shows the plain message instead of the server text", async () => {
    post
      .mockRejectedValueOnce(new Error("Network Error"))
      .mockRejectedValueOnce(
        Object.assign(new Error("Request failed"), {
          response: {
            status: 409,
            data: { code: "IDEMPOTENCY_KEY_REUSED", message: "server text" },
          },
        }),
      )
      .mockResolvedValue({ data: { ok: true } });
    const { result } = renderHook(() => useRecordAdjustment(), { wrapper });
    await act(
      async () =>
        void (await result.current.mutateAsync({ ...body, quantity: 50 }).catch(() => undefined)),
    );
    const err: any = await act(async () =>
      result.current.mutateAsync({ ...body, quantity: 5 }).catch((e) => e),
    );
    expect(err.response.data.message).toBe(
      "Your earlier adjustment was saved. Check the stock before you save again.",
    );
    await act(async () => void (await result.current.mutateAsync({ ...body, quantity: 5 })));
    expect(keyOf(post.mock.calls[2])).not.toBe(keyOf(post.mock.calls[0]));
  });

  it("a slow older save finishing late does not clear the newer attempt's key", async () => {
    const finishers: Array<(v: unknown) => void> = [];
    const fail: Array<(e: unknown) => void> = [];
    post.mockImplementation(
      () =>
        new Promise((res, rej) => {
          finishers.push(res);
          fail.push(rej);
        }),
    );
    const { result } = renderHook(() => useRecordAdjustment(), { wrapper });
    act(() => result.current.mutate({ ...body, quantity: 1 })); // A, key K1
    await waitFor(() => expect(post).toHaveBeenCalledTimes(1));
    act(() => result.current.mutate({ ...body, quantity: 2 })); // edit, B, key K2
    await waitFor(() => expect(post).toHaveBeenCalledTimes(2));
    const k2 = keyOf(post.mock.calls[1]);
    expect(k2).not.toBe(keyOf(post.mock.calls[0]));
    await act(async () => finishers[0]({ data: { ok: true } })); // A succeeds late
    await act(async () => fail[1](new Error("Network Error"))); // B: unknown
    act(() => result.current.mutate({ ...body, quantity: 2 }));
    await waitFor(() => expect(post).toHaveBeenCalledTimes(3));
    expect(keyOf(post.mock.calls[2])).toBe(k2); // B's retry carries B's key
  });

  it("two taps in the same tick share the key (the second is collapsed by singleFlight)", async () => {
    let finish!: (v: unknown) => void;
    post.mockImplementation(() => new Promise((res) => (finish = res)));
    const { result } = renderHook(() => useRecordAdjustment(), { wrapper });
    act(() => {
      result.current.mutate(body);
      result.current.mutate({ ...body });
    });
    await waitFor(() => expect(post).toHaveBeenCalled());
    expect(post).toHaveBeenCalledTimes(1);
    await act(async () => finish({ data: { ok: true } }));
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
  });
});
