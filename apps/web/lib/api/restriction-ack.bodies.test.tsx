import * as React from "react";
import { renderHook, act, waitFor } from "@testing-library/react";
import { QueryClientProvider } from "@tanstack/react-query";
import { createTestQueryClient } from "@/test-utils/render";
import {
  useCreateOrder,
  useCreateSale,
  useReopenOrder,
  useResolveChangeRequest,
  usePatchOrderFulfillPath,
  useUpdateOrderItems,
  useUpdateOrderStatus,
} from "./orders";
import {
  useCreateInvoice,
  useDuplicateInvoice,
  useRunRecurringInvoice,
  useUpdateInvoice,
} from "./invoices";
import { useConvertEstimateToInvoice } from "./estimates";
import { useGenerateTemplateOrder } from "./order-templates";
import { usePosFinish } from "./pos-orders";

/**
 * Row 510: after a RESTRICTION_WARNING the flow re-sends the SAME mutation with `restrictionOverrides` + `warningHash`
 * as TOP-LEVEL body fields. One row per staff write hook that must carry them (the L-305 list, derived from the plan's
 * path inventory); a hook that swallows the ack (an explicit destructure that forgets it) turns its row red.
 */
const post = jest.fn();
const patch = jest.fn();
jest.mock("@/lib/api-client", () => ({
  apiClient: {
    post: (...a: unknown[]) => post(...a),
    patch: (...a: unknown[]) => patch(...a),
    get: jest.fn(),
  },
}));

const ack = {
  restrictionOverrides: [{ lineKey: "n:0", reason: "Owner approved" }],
  warningHash: "rw1:abc",
};
const wrapper = ({ children }: { children: React.ReactNode }) => (
  <QueryClientProvider client={createTestQueryClient()}>{children}</QueryClientProvider>
);

beforeEach(() => {
  jest.clearAllMocks();
  post.mockResolvedValue({ data: { id: "x" } });
  patch.mockResolvedValue({ data: { id: "x" } });
});

type Row = [string, () => { mutate: (v: any) => void }, any, "post" | "patch", string];
const rows: Row[] = [
  [
    "create order",
    () => useCreateOrder(),
    { customerId: "c1", items: [], ...ack },
    "post",
    "/orders",
  ],
  [
    "sell (Bill now)",
    () => useCreateSale(),
    { customerId: "c1", items: [], deliveredNow: true, ...ack },
    "post",
    "/orders/sell",
  ],
  [
    "order status (promote)",
    () => useUpdateOrderStatus(),
    { id: "o1", status: "PENDING", ...ack },
    "patch",
    "/orders/o1/status",
  ],
  [
    "order edit",
    () => useUpdateOrderItems(),
    { id: "o1", items: [], ...ack },
    "patch",
    "/orders/o1/items",
  ],
  [
    "fulfil-path switch",
    () => usePatchOrderFulfillPath(),
    { id: "o1", fulfillPath: "SHIP", ...ack },
    "patch",
    "/orders/o1/fulfill-path",
  ],
  ["reopen", () => useReopenOrder(), { id: "o1", ...ack }, "post", "/orders/o1/reopen"],
  [
    "change-request approve",
    () => useResolveChangeRequest(),
    { orderId: "o1", crId: "cr-1", action: "APPROVE_AT_STOP", ...ack },
    "post",
    "/orders/o1/change-requests/cr-1/resolve",
  ],
  [
    "invoice create",
    () => useCreateInvoice(),
    { customerId: "c1", items: [], ...ack },
    "post",
    "/invoices",
  ],
  [
    "invoice edit",
    () => useUpdateInvoice(),
    { id: "i1", items: [], ...ack },
    "patch",
    "/invoices/i1",
  ],
  [
    "invoice duplicate",
    () => useDuplicateInvoice(),
    { id: "i1", ...ack },
    "post",
    "/invoices/i1/duplicate",
  ],
  [
    "estimate convert",
    () => useConvertEstimateToInvoice(),
    { id: "e1", ...ack },
    "post",
    "/estimates/e1/convert",
  ],
  [
    "recurring Run now",
    () => useRunRecurringInvoice(),
    { id: "r1", ...ack },
    "post",
    "/recurring-invoices/r1/run",
  ],
  [
    "template Generate",
    () => useGenerateTemplateOrder(),
    { id: "t1", ...ack },
    "post",
    "/order-templates/t1/generate",
  ],
];

describe("staff write hooks carry the ack as top-level body fields", () => {
  it.each(rows)("%s", async (_name, hook, vars, verb, url) => {
    const { result } = renderHook(hook, { wrapper });
    act(() => result.current.mutate(vars));
    const mock = verb === "post" ? post : patch;
    await waitFor(() => expect(mock).toHaveBeenCalledTimes(1));
    expect(mock.mock.calls[0][0]).toBe(url);
    const body = mock.mock.calls[0][1];
    expect(body).toMatchObject(ack);
    expect(body.id).toBeUndefined(); // the id is the URL, never a body field
  });

  it.each(
    rows.filter((r) =>
      [
        "reopen",
        "invoice duplicate",
        "estimate convert",
        "recurring Run now",
        "template Generate",
      ].includes(r[0]),
    ),
  )("%s: a bare id (no ack) still posts with no body", async (_name, hook, vars, _verb, url) => {
    const { result } = renderHook(hook, { wrapper });
    act(() => result.current.mutate(vars.id));
    await waitFor(() => expect(post).toHaveBeenCalledTimes(1));
    expect(post.mock.calls[0]).toEqual([url]);
  });

  it("POS finish sends the ack on its status PATCHes", async () => {
    const { result } = renderHook(() => usePosFinish(), { wrapper });
    act(() =>
      result.current.mutate({ orderId: "o1", invoice: false, fromStatus: "DRAFT", ...ack }),
    );
    await waitFor(() => expect(patch).toHaveBeenCalledTimes(2));
    expect(patch.mock.calls[0]).toEqual(["/orders/o1/status", { status: "PENDING", ...ack }]);
    expect(patch.mock.calls[1]).toEqual(["/orders/o1/status", { status: "CONFIRMED", ...ack }]);
  });
});
