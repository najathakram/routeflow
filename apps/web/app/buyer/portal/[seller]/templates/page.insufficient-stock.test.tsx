import * as React from "react";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import BuyerTemplatesPage from "./page";

/** A template Reorder refused for stock reads as a sentence, never the server text (gap 05). */
const mutateAsync = jest.fn();
jest.mock("next/navigation", () => ({
  useParams: () => ({ seller: "acme" }),
  useRouter: () => ({ push: jest.fn() }),
}));
jest.mock("@/lib/buyer-auth-context", () => ({
  useBuyerAuth: () => ({
    buyer: { id: "b1" },
    activeSeller: { slug: "acme", tenant: { name: "Acme" } },
    isLoading: false,
  }),
}));
jest.mock("@/lib/api/buyer", () => ({
  useBuyerTemplates: () => ({
    data: {
      data: [
        {
          id: "t1",
          name: "Weekly",
          items: [],
          isActive: true,
          daysOfWeek: [1],
          nextFireDate: null,
        },
      ],
    },
    isLoading: false,
    isError: false,
  }),
  useBuyerReorder: () => ({ mutateAsync, isPending: false }),
}));

it("shows the stock sentence and never the raw server text", async () => {
  mutateAsync.mockRejectedValueOnce(
    Object.assign(new Error("Request failed"), {
      response: {
        status: 409,
        data: {
          code: "INSUFFICIENT_STOCK",
          message: "Insufficient stock: Hemp Gummies (available: 4, requested: 6)",
          lines: [{ productId: "p1", name: "Hemp Gummies", available: 4, requested: 6 }],
        },
      },
    }),
  );
  render(<BuyerTemplatesPage />);
  fireEvent.click(await screen.findByRole("button", { name: /reorder now/i }));
  await waitFor(() =>
    expect(screen.getByText("Only 4 pieces of Hemp Gummies left.")).toBeInTheDocument(),
  );
  expect(screen.queryByText(/Insufficient stock|available: 4/)).toBeNull();
});
