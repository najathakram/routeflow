import * as React from "react";
import { act, render } from "@testing-library/react";
import { useMutation } from "@tanstack/react-query";
import { Providers } from "./providers";

/** Gap 05: any mutation that fails with INSUFFICIENT_STOCK toasts a sentence, never server text. */
const toasts: Array<{ title: string }> = [];
jest.mock("next/navigation", () => ({ useRouter: () => ({ push: jest.fn() }) }));
jest.mock("@/lib/auth-context", () => ({ AuthProvider: ({ children }: any) => <>{children}</> }));
jest.mock("@/lib/buyer-auth-context", () => ({
  BuyerAuthProvider: ({ children }: any) => <>{children}</>,
}));
jest.mock("@/lib/i18n", () => ({ I18nProvider: ({ children }: any) => <>{children}</> }));
jest.mock("@/components/ReAuthProvider", () => ({
  ReAuthProvider: ({ children }: any) => <>{children}</>,
}));
jest.mock("@/components/PlanGateNotice", () => ({ PlanGateNotice: () => null }));
jest.mock("@routeflow/ui/web", () => ({
  ToastProvider: ({ children }: any) => <>{children}</>,
  useToast: () => ({ toast: (t: { title: string }) => toasts.push(t) }),
}));

function Trigger({ error }: { error: unknown }) {
  const m = useMutation({ mutationFn: () => Promise.reject(error) });
  return <button onClick={() => m.mutate()}>go</button>;
}

const fire = async (error: unknown) => {
  const { getByText } = render(
    <Providers>
      <Trigger error={error} />
    </Providers>,
  );
  await act(async () => {
    getByText("go").click();
  });
};

beforeEach(() => {
  toasts.length = 0;
});

it("toasts the sentence for a coded stock shortfall (create or edit path)", async () => {
  await fire({
    response: {
      data: {
        code: "INSUFFICIENT_STOCK",
        message: "Insufficient stock: Mango (available: 4, requested: 6)",
        lines: [{ productId: "m", name: "Mango 5ct", available: 4, requested: 6 }],
      },
    },
  });
  expect(toasts).toEqual([{ title: "Only 4 Mango 5ct left.", variant: "error" }]);
});

it("other failures keep the server message", async () => {
  await fire({ response: { data: { message: "Boom" } } });
  expect(toasts[0].title).toBe("Boom");
});
