import * as React from "react";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClientProvider } from "@tanstack/react-query";
import { createTestQueryClient } from "@/test-utils/render";
import { useGenerateTemplateOrderAction } from "./use-generate-template-order-action";

/** Row 510, ruling Q2: a MANUAL template Generate is judged for the clicker: warn, then regenerate with the ack. */
const post = jest.fn();
jest.mock("@/lib/api-client", () => ({ apiClient: { post: (...a: unknown[]) => post(...a) } }));

const warning409 = {
  response: {
    status: 409,
    data: {
      code: "RESTRICTION_WARNING",
      message: "Some items are restricted.",
      warningHash: "rw1:abc",
      lines: [
        {
          lineKey: "n:0",
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
  const { generate, dialog } = useGenerateTemplateOrderAction();
  return (
    <>
      <button onClick={() => generate("t1", "Weekly order")}>Generate</button>
      {dialog}
    </>
  );
}

it("warns on a restricted line, then re-posts the same template generate with the ack", async () => {
  const user = userEvent.setup();
  const alert = jest.spyOn(window, "alert").mockImplementation(() => undefined);
  post.mockRejectedValueOnce(warning409);
  post.mockResolvedValueOnce({ data: {} });
  render(
    <QueryClientProvider client={createTestQueryClient()}>
      <Host />
    </QueryClientProvider>,
  );
  await user.click(screen.getByRole("button", { name: "Generate" }));
  await user.type(await screen.findByLabelText(/reason/i), "Owner approved");
  await user.click(screen.getByRole("button", { name: "Sell anyway" }));
  await waitFor(() => expect(post).toHaveBeenCalledTimes(2));
  expect(post.mock.calls[0]).toEqual(["/order-templates/t1/generate"]);
  expect(post.mock.calls[1]).toEqual([
    "/order-templates/t1/generate",
    {
      restrictionOverrides: [{ lineKey: "n:0", reason: "Owner approved" }],
      warningHash: "rw1:abc",
    },
  ]);
  await waitFor(() => expect(alert).toHaveBeenCalledWith('Order generated for "Weekly order"!'));
});
