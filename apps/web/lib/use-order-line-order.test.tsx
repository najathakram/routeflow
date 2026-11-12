import * as React from "react";
import { act, renderHook, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { OrderItem } from "@/lib/api/orders";
import { useOrderLineOrder } from "./use-order-line-order";

/**
 * W-1187 #4290 round 3: the hook's lifecycle. StrictMode runs mount, cleanup, mount again in `next dev`; a PUT that was
 * in flight when the page was left must not toast or arm an Undo on the next page.
 */
const mockPut = jest.fn();
jest.mock("@/lib/api-client", () => ({
  apiClient: {
    put: (...a: unknown[]) => mockPut(...a),
    get: jest.fn(),
    patch: jest.fn(),
    post: jest.fn(),
  },
}));
const mockToast = jest.fn(() => "t1");
const mockDismiss = jest.fn();
jest.mock("@routeflow/ui/web", () => ({
  ...jest.requireActual("@routeflow/ui/web"),
  useToast: () => ({ toast: mockToast, dismiss: mockDismiss }),
}));

const line = (id: string, name: string) =>
  ({
    id,
    productId: `p-${id}`,
    product: { id: `p-${id}`, name, unit: "each" },
  }) as unknown as OrderItem;
const LINES = [
  line("l1", "Sample Apple"),
  line("l2", "Sample Pear"),
  line("l3", "Sample Zucchini"),
];
const STAMP = "2026-11-11T08:00:00.000Z";
const busy = {
  response: {
    status: 409,
    data: { code: "CONCURRENT_UPDATE", reason: "ORDER_LINE_ORDER_BUSY", retryable: true },
  },
};
const move = { ids: ["l3", "l1", "l2"], movedId: "l3", toIndex: 0 };

function setup(strict: boolean) {
  const qc = new QueryClient({ defaultOptions: { mutations: { retry: false } } });
  const invalidate = jest.spyOn(qc, "invalidateQueries");
  const wrapper = ({ children }: { children: React.ReactNode }) => {
    const tree = <QueryClientProvider client={qc}>{children}</QueryClientProvider>;
    return strict ? <React.StrictMode>{tree}</React.StrictMode> : tree;
  };
  const hook = renderHook(
    () => useOrderLineOrder({ orderId: "o-1", updatedAt: STAMP, lineItems: LINES, enabled: true }),
    { wrapper },
  );
  return { ...hook, invalidate };
}
const ids = (r: { current: { shown: OrderItem[] } }) => r.current.shown.map((l) => l.id);

beforeEach(() => {
  mockPut.mockReset();
  mockToast.mockClear();
  mockDismiss.mockClear();
});

describe("useOrderLineOrder lifecycle (#4290 round 3)", () => {
  it("MUST: under StrictMode, busy twice still rolls back and toasts", async () => {
    mockPut.mockRejectedValueOnce(busy).mockRejectedValueOnce(busy);
    const { result } = setup(true);
    await act(async () => {
      await result.current.onMove(move);
    });
    expect(mockPut).toHaveBeenCalledTimes(2);
    expect(mockToast).toHaveBeenCalledWith(
      expect.objectContaining({ title: "The order is busy. Your change wasn't saved. Try again." }),
    );
    expect(ids(result)).toEqual(["l1", "l2", "l3"]);
  });

  it("(a) busy twice refetches the order so the screen is not stale", async () => {
    mockPut.mockRejectedValueOnce(busy).mockRejectedValueOnce(busy);
    const { result, invalidate } = setup(false);
    await act(async () => {
      await result.current.onMove(move);
    });
    await waitFor(() => expect(invalidate).toHaveBeenCalledWith({ queryKey: ["orders", "o-1"] }));
  });

  it.each([
    [
      "succeeds",
      () => Promise.resolve({ data: { id: "o-1", updatedAt: "x", lineIds: ["l3", "l1", "l2"] } }),
    ],
    ["fails", () => Promise.reject({ response: { status: 500, data: {} } })],
  ])("(b) a PUT in flight at unmount that %s shows no toast", async (_n, settle) => {
    let go!: () => void;
    mockPut.mockReturnValueOnce(new Promise((r, j) => (go = () => settle().then(r, j))));
    const { result, unmount } = setup(false);
    let done!: Promise<void>;
    act(() => {
      done = result.current.onMove(move) as Promise<void>;
    });
    unmount();
    await act(async () => {
      go();
      await done;
    });
    expect(mockToast).not.toHaveBeenCalled();
  });
});
