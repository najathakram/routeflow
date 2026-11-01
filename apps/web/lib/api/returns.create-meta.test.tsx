import * as React from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, renderHook } from "@testing-library/react";
import { handleMutationError } from "../mutation-error-toast";

jest.mock("@/lib/api-client", () => ({
  apiClient: { post: jest.fn().mockRejectedValue(new Error("boom")) },
}));

const refusal = (status: number, data: Record<string, unknown>) => ({ response: { status, data } });
const CAP = "Return qty exceeds what is left on this line: 8 Cases.";

describe("useCreateReturn: a refusal the form explains shows one toast", () => {
  it("the global toast stands down for what the form says, and keeps everything else", async () => {
    const { useCreateReturn } = await import("./returns");
    const qc = new QueryClient();
    const wrapper = ({ children }: { children: React.ReactNode }) =>
      React.createElement(QueryClientProvider, { client: qc }, children);
    const { result } = renderHook(() => useCreateReturn(), { wrapper });
    await act(async () => {
      result.current.mutate({} as never, { onError: () => undefined });
    });
    const mutation = qc.getMutationCache().getAll()[0];

    const toasts = (err: unknown) => {
      const toast = jest.fn();
      handleMutationError(err, mutation, toast, { push: jest.fn() });
      return toast.mock.calls.length;
    };
    expect(toasts(refusal(400, { message: CAP }))).toBe(0);
    expect(toasts(refusal(400, { code: "RETURN_LINE_COUNT_SHAPE", message: "x" }))).toBe(0);
    expect(toasts(refusal(409, { code: "RETURN_MIXED_UNIT_PRODUCT", message: "x" }))).toBe(0);
    expect(toasts(refusal(409, { message: "Product 123 has mixed packs." }))).toBe(0);
    expect(toasts(refusal(400, { message: "Invalid reason for product p-1." }))).toBe(1);
    expect(toasts(refusal(500, { message: "Internal server error" }))).toBe(1);
  });
});
