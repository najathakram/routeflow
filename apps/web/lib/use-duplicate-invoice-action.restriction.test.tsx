import * as React from "react";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClientProvider } from "@tanstack/react-query";
import { createTestQueryClient } from "@/test-utils/render";
import { useDuplicateInvoiceAction } from "./use-duplicate-invoice-action";

/** Row 510: the copy is a new sale and is re-judged, so a duplicate can warn and be acknowledged. */
const post = jest.fn();
jest.mock("@/lib/api-client", () => ({ apiClient: { post: (...a: unknown[]) => post(...a) } }));
jest.mock("next/navigation", () => ({ useRouter: () => ({ push: jest.fn() }) }));
jest.mock("@routeflow/ui/web", () => ({
  ...jest.requireActual("@routeflow/ui/web"),
  useToast: () => ({ toast: jest.fn() }),
}));

const warning409 = {
  response: {
    status: 409,
    data: {
      code: "RESTRICTION_WARNING",
      message: "Some items are restricted.",
      warningHash: "rw1:abc",
      lines: [
        {
          lineKey: "l:item-1",
          productId: "p1",
          displayName: "Widget",
          outcome: "BLOCK",
          rules: [
            {
              id: "r1",
              states: ["CA"],
              legal: true,
              reasonText: "This product is banned in CA by law.",
            },
          ],
        },
      ],
    },
  },
};

function Host() {
  const { duplicate, dialog } = useDuplicateInvoiceAction();
  return (
    <>
      <button onClick={() => duplicate("inv-1")}>Duplicate</button>
      {dialog}
    </>
  );
}

it("warns on the copy, then re-posts the duplicate with the ack as its body", async () => {
  const user = userEvent.setup();
  post.mockRejectedValueOnce(warning409);
  post.mockResolvedValueOnce({ data: { id: "inv-2", invoiceNumber: "INV-0002" } });
  render(
    <QueryClientProvider client={createTestQueryClient()}>
      <Host />
    </QueryClientProvider>,
  );
  await user.click(screen.getByRole("button", { name: "Duplicate" }));
  await user.type(await screen.findByLabelText(/reason/i), "Owner approved");
  await user.click(screen.getByRole("button", { name: "Sell anyway" }));
  await waitFor(() => expect(post).toHaveBeenCalledTimes(2));
  expect(post.mock.calls[0]).toEqual(["/invoices/inv-1/duplicate"]);
  expect(post.mock.calls[1]).toEqual([
    "/invoices/inv-1/duplicate",
    {
      restrictionOverrides: [{ lineKey: "l:item-1", reason: "Owner approved" }],
      warningHash: "rw1:abc",
    },
  ]);
});
