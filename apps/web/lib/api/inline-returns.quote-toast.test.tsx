import * as React from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderHook, act } from "@testing-library/react";

// mm-ux retake: a quote that fails shows ONE message, the dialog's own. The mutation says so (`meta.localErrorToast`),
// so the app's global mutation error toast ("That conflicts with something...", "Something went wrong on our side")
// does not stack a second one on top of it.
const post = jest.fn();
jest.mock("../api-client", () => ({ apiClient: { post: (...a: unknown[]) => post(...a) } }));

import { useInlineReturnQuote } from "./inline-returns";

it("the quote mutation owns its error: no global toast", async () => {
  post.mockRejectedValue({ response: { status: 500, data: { message: "boom" } } });
  const qc = new QueryClient();
  const wrapper = ({ children }: { children: React.ReactNode }) => (
    <QueryClientProvider client={qc}>{children}</QueryClientProvider>
  );
  const { result } = renderHook(() => useInlineReturnQuote(), { wrapper });
  await act(async () => {
    await result.current
      .mutateAsync({ customerId: "c1", items: [] } as never)
      .catch(() => undefined);
  });
  const mutation = qc.getMutationCache().getAll()[0]!;
  expect(mutation.options.meta).toEqual({ localErrorToast: true });
});
