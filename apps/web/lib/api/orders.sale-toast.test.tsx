import * as React from "react";
import { act, renderHook } from "@testing-library/react";
import { QueryClientProvider } from "@tanstack/react-query";
import { createTestQueryClient } from "@/test-utils/render";
import { apiClient } from "@/lib/api-client";
import { handleMutationError } from "@/lib/mutation-error-toast";
import { useCreateSale } from "./orders";

jest.mock("@/lib/api-client", () => ({ apiClient: { post: jest.fn() } }));
const post = (apiClient as unknown as { post: jest.Mock }).post;

/**
 * Row 485: the app-wide mutation error toast must NOT fire beside the New sale lock panel (it said "Something
 * went wrong on our side" or "Some details aren't valid" next to a panel that says the opposite). An UNKNOWN
 * outcome is the panel's alone; a definitive refusal still reaches the global toast.
 */
async function metaAfter(error: unknown) {
  post.mockRejectedValue(error);
  const qc = createTestQueryClient();
  const wrapper = ({ children }: { children: React.ReactNode }) => (
    <QueryClientProvider client={qc}>{children}</QueryClientProvider>
  );
  const { result } = renderHook(() => useCreateSale(), { wrapper });
  await act(async () => {
    await result.current
      .mutateAsync({ customerId: "c", items: [] } as never)
      .catch(() => undefined);
  });
  return qc.getMutationCache().getAll()[0]?.options.meta;
}
const globalToast = (error: unknown, meta: Record<string, unknown> | undefined) => {
  const toast = jest.fn();
  handleMutationError(error, { meta }, toast, { push: jest.fn() });
  return toast;
};
const e = (status: number, data: Record<string, unknown> = {}) => ({ response: { status, data } });

describe("useCreateSale — the global error toast", () => {
  it.each([
    ["a 5xx", e(500)],
    ["a dropped connection", new Error("Network Error")],
    ["a 400 naming the committed invoice", e(400, { invoiceId: "i1", message: "Some details" })],
    ["a coded 500 naming the order", e(500, { code: "SALE_INVOICE_CREATE_FAILED", orderId: "o1" })],
  ])("shows NO global toast for %s (the lock panel is the only feedback)", async (_n, err) => {
    const meta = await metaAfter(err);
    expect(globalToast(err, meta as never)).not.toHaveBeenCalled();
  });

  it("a definitive refusal with no committed sale still gets the global toast", async () => {
    const err = e(400, { statusCode: 400, message: "Customer not found" });
    const meta = await metaAfter(err);
    expect(globalToast(err, meta as never)).toHaveBeenCalled();
  });
});
