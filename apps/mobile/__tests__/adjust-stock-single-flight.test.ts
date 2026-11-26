/**
 * B1415 (SA-1404 M1a, co-signed SA-1504): mobile Adjust stock pressed twice while the first save is on its way is ONE
 * adjustment. Stock is a ledger, so the hook must not send the same body twice in flight. Mirror of the web fix B1379
 * (#4516, `useRecordAdjustment`). M1b (R-342 M1): the hook sends the sheet's key as the Idempotency-Key header.
 */
const post = jest.fn();
let captured: { mutationFn: (arg: unknown) => Promise<unknown> } | undefined;
// One mounted form: the useState slots keep their value across re-renders (calls of the hook) until `mockUnmount()`.
const mockSlots: unknown[] = [];
let mockSlot = 0;
const mockRender = () => {
  mockSlot = 0;
};
const mockUnmount = () => {
  mockSlots.length = 0;
  mockSlot = 0;
};

jest.mock("react", () => {
  const actual = jest.requireActual("react");
  return {
    ...actual,
    useState: (init: unknown) => {
      const i = mockSlot++;
      if (!(i in mockSlots)) mockSlots[i] = typeof init === "function" ? init() : init;
      return [mockSlots[i], jest.fn()];
    },
  };
});
jest.mock("@tanstack/react-query", () => ({
  useQueryClient: () => ({ invalidateQueries: jest.fn() }),
  useMutation: (opts: typeof captured) => {
    captured = opts;
    return {};
  },
  useQuery: jest.fn(),
  useInfiniteQuery: jest.fn(),
}));
jest.mock("../lib/api-client", () => ({
  apiClient: {
    post: (...a: unknown[]) => post(...a),
    get: jest.fn(),
    patch: jest.fn(),
    delete: jest.fn(),
  },
}));

import { useAdjustProductStock } from "../lib/api/products";

describe("REG-B1415 mobile Adjust stock single-flight", () => {
  beforeEach(() => {
    post.mockReset();
    captured = undefined;
    mockUnmount();
  });

  it("two saves with the same body while the first is in flight send ONE adjustment", async () => {
    let release!: (v: { data: unknown }) => void;
    post.mockReturnValue(new Promise((res) => (release = res)));
    useAdjustProductStock();
    const body = { productId: "acme-p1", quantity: 5, notes: "recount" };
    const first = captured!.mutationFn(body);
    const second = captured!.mutationFn({ ...body });
    expect(post).toHaveBeenCalledTimes(1);
    // M1b adds a third argument (the request config carrying the Idempotency-Key header); the url and body are pinned.
    expect(post.mock.calls[0].slice(0, 2)).toEqual(["/inventory/movements/adjustment", body]);
    release({ data: { ok: true } });
    await expect(first).resolves.toEqual({ ok: true });
    await expect(second).resolves.toEqual({ ok: true });
  });

  it("a re-render between the two taps keeps the same guard (one per mounted form)", () => {
    post.mockReturnValue(new Promise(() => {}));
    const body = { productId: "acme-p1", quantity: 5 };
    mockRender();
    useAdjustProductStock();
    void captured!.mutationFn(body);
    mockRender(); // the first tap's pending state re-renders the screen before the second tap lands
    useAdjustProductStock();
    void captured!.mutationFn({ ...body });
    expect(post).toHaveBeenCalledTimes(1);
  });
});

describe("REG-B1415 M1b mobile Adjust stock sends the sheet's key as the Idempotency-Key header (R-342 M1)", () => {
  beforeEach(() => {
    post.mockReset();
    captured = undefined;
    mockUnmount();
  });

  it("the key travels as the header and never in the body", async () => {
    post.mockResolvedValue({ data: { ok: true } });
    useAdjustProductStock();
    const body = { productId: "acme-p1", quantity: 5, notes: "recount" };
    await captured!.mutationFn({ ...body, idempotencyKey: "k-1" });
    expect(post).toHaveBeenCalledTimes(1);
    expect(post).toHaveBeenCalledWith("/inventory/movements/adjustment", body, {
      headers: { "Idempotency-Key": "k-1" },
    });
  });

  it("a retry after a dropped connection sends the SAME key again (the server replays it)", async () => {
    post.mockRejectedValueOnce(new Error("Network Error")).mockResolvedValueOnce({ data: {} });
    useAdjustProductStock();
    const args = { productId: "acme-p1", quantity: 5, idempotencyKey: "k-1" };
    await expect(captured!.mutationFn(args)).rejects.toThrow("Network Error");
    await captured!.mutationFn({ ...args });
    expect(post).toHaveBeenCalledTimes(2);
    expect(post.mock.calls.map((c) => c[2])).toEqual([
      { headers: { "Idempotency-Key": "k-1" } },
      { headers: { "Idempotency-Key": "k-1" } },
    ]);
  });

  it("two taps with the same key while the first is in flight are ONE request", () => {
    post.mockReturnValue(new Promise(() => {}));
    useAdjustProductStock();
    const args = { productId: "acme-p1", quantity: 5, idempotencyKey: "k-1" };
    void captured!.mutationFn(args);
    void captured!.mutationFn({ ...args });
    expect(post).toHaveBeenCalledTimes(1);
  });
});

describe("mobile Adjust stock single-flight pins", () => {
  beforeEach(() => {
    post.mockReset();
    captured = undefined;
    mockUnmount();
  });

  it("a different body is a different adjustment and is sent", () => {
    post.mockReturnValue(new Promise(() => {}));
    useAdjustProductStock();
    void captured!.mutationFn({ productId: "acme-p1", quantity: 5 });
    void captured!.mutationFn({ productId: "acme-p1", quantity: 6 });
    expect(post).toHaveBeenCalledTimes(2);
  });

  it("after the first save settles, the same body is sent again (a deliberate second adjustment)", async () => {
    post.mockResolvedValue({ data: {} });
    useAdjustProductStock();
    await captured!.mutationFn({ productId: "acme-p1", quantity: 5 });
    await captured!.mutationFn({ productId: "acme-p1", quantity: 5 });
    expect(post).toHaveBeenCalledTimes(2);
  });

  it("a failed save does not block a retry", async () => {
    post.mockRejectedValueOnce(new Error("offline")).mockResolvedValueOnce({ data: {} });
    useAdjustProductStock();
    await expect(captured!.mutationFn({ productId: "acme-p1", quantity: 5 })).rejects.toThrow(
      "offline",
    );
    await captured!.mutationFn({ productId: "acme-p1", quantity: 5 });
    expect(post).toHaveBeenCalledTimes(2);
  });
});
