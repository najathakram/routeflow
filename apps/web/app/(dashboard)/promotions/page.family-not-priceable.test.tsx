import * as React from "react";
import { fireEvent, renderWithProviders, screen, waitFor, within } from "@/test-utils/render";
import PromotionsPage from "./page";

/**
 * #3323 fold (a): a save refused with 400 FAMILY_NOT_PRICEABLE (a family cannot be promoted) shows FIXED
 * copy inline, never the server message.
 */
const RAW = "RAW SERVER TEXT must never show";
const createAsync = jest.fn();

jest.mock("@/lib/page-title-context", () => ({ usePageTitle: () => ({ setTitle: jest.fn() }) }));
jest.mock("@routeflow/ui/web", () => ({
  ...jest.requireActual("@routeflow/ui/web"),
  useToast: () => ({ toast: jest.fn() }),
}));
jest.mock("@/lib/api/promotions", () => ({
  ...jest.requireActual("@/lib/api/promotions"),
  usePromotions: () => ({ data: [], isLoading: false, isError: false }),
  useCreatePromotion: () => ({ mutateAsync: createAsync, mutate: jest.fn(), isPending: false }),
  useUpdatePromotion: () => ({ mutateAsync: jest.fn(), mutate: jest.fn(), isPending: false }),
  useSetPromotionActive: () => ({ mutateAsync: jest.fn(), mutate: jest.fn(), isPending: false }),
  useDeletePromotion: () => ({ mutateAsync: jest.fn(), mutate: jest.fn(), isPending: false }),
}));
jest.mock("@/lib/api/products", () => ({
  ...jest.requireActual("@/lib/api/products"),
  useProducts: () => ({ data: { data: [] } }),
}));

describe("promotion save refused for a family (FAMILY_NOT_PRICEABLE)", () => {
  it("shows the fixed sentence inline, not the server message", async () => {
    createAsync.mockRejectedValueOnce(
      Object.assign(new Error("Request failed"), {
        response: { status: 400, data: { code: "FAMILY_NOT_PRICEABLE", message: RAW } },
      }),
    );
    renderWithProviders(<PromotionsPage />);
    fireEvent.click(screen.getAllByRole("button", { name: "New promotion" })[0]);
    const dialog = await screen.findByRole("dialog");
    fireEvent.change(within(dialog).getByPlaceholderText(/summer restock deal/i), {
      target: { value: "Spring deal" },
    });
    fireEvent.change(within(dialog).getAllByRole("spinbutton")[0], { target: { value: "10" } });
    const [start, end] = Array.from(
      dialog.querySelectorAll<HTMLInputElement>('input[type="datetime-local"]'),
    );
    fireEvent.change(start, { target: { value: "2026-11-01T08:00" } });
    fireEvent.change(end, { target: { value: "2026-11-30T08:00" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Create promotion" }));
    await waitFor(() => expect(createAsync).toHaveBeenCalledTimes(1));
    expect(
      await within(dialog).findByText(
        "A product family can't be priced or promoted. Use its variants instead.",
      ),
    ).toBeInTheDocument();
    expect(screen.queryByText(/RAW SERVER TEXT/)).toBeNull();
  });
});
