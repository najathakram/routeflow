import * as React from "react";
import userEvent from "@testing-library/user-event";
import { renderWithProviders, screen, waitFor, within } from "@/test-utils/render";
import { useUpdateInvoiceSettings } from "@/lib/api/invoices";
import { InvoiceLayoutCard } from "./InvoiceLayoutCard";

// PR-1 WP2 (T6-T9): the three invoice layout switches live in one card with a live preview.

const mockPatch = jest.fn();
jest.mock("@/lib/api-client", () => ({
  apiClient: {
    get: jest.fn(),
    patch: (...a: unknown[]) => mockPatch(...a),
    put: jest.fn(),
    post: jest.fn(),
    delete: jest.fn(),
  },
}));

const ON = { hideOriginalPrice: false, hideBarcodes: false, hidePerPiece: false };

// Wired like the Invoicing tab: pending = the in-flight PATCH body while the save runs.
function Harness({ stored = ON }: { stored?: typeof ON }) {
  const updateSettings = useUpdateInvoiceSettings();
  return (
    <InvoiceLayoutCard
      settings={stored}
      pending={updateSettings.isPending ? updateSettings.variables : undefined}
      onToggle={updateSettings.mutate}
      disabled={updateSettings.isPending}
    />
  );
}

const preview = () => screen.getByLabelText("Invoice preview");

beforeEach(() => {
  mockPatch.mockReset();
  mockPatch.mockResolvedValue({ data: {} });
});

describe("InvoiceLayoutCard", () => {
  it("T6: holds the three switches under unchanged labels and PATCHes the same body", async () => {
    renderWithProviders(<Harness />);
    expect(screen.getByText("Invoice layout")).toBeInTheDocument();
    for (const name of [
      "Show original price on discounted lines",
      "Show barcodes on invoices",
      "Show price per piece on invoices",
    ]) {
      expect(screen.getByRole("checkbox", { name })).toBeChecked();
    }
    await userEvent.click(screen.getByRole("checkbox", { name: "Show barcodes on invoices" }));
    await waitFor(() => expect(mockPatch).toHaveBeenCalledTimes(1));
    expect(mockPatch).toHaveBeenCalledWith("/settings/invoice", { hideBarcodes: true });
  });

  it("T7: the preview follows a flip before the PATCH resolves", async () => {
    mockPatch.mockImplementation(() => new Promise(() => {}));
    renderWithProviders(<Harness />);
    expect(within(preview()).getByText("0123456789")).toBeInTheDocument();
    expect(within(preview()).getByTestId("preview-original-price")).toBeInTheDocument();
    expect(within(preview()).getByText("Per piece")).toBeInTheDocument();

    await userEvent.click(screen.getByRole("checkbox", { name: "Show barcodes on invoices" }));
    await waitFor(() => expect(within(preview()).queryByText("0123456789")).toBeNull());
  });

  it("T7: the original price and the Per piece cell each drop at once", async () => {
    mockPatch.mockImplementation(() => new Promise(() => {}));
    const { unmount } = renderWithProviders(<Harness />);
    await userEvent.click(
      screen.getByRole("checkbox", { name: "Show original price on discounted lines" }),
    );
    await waitFor(() =>
      expect(within(preview()).queryByTestId("preview-original-price")).toBeNull(),
    );
    unmount();
    renderWithProviders(<Harness />);
    await userEvent.click(
      screen.getByRole("checkbox", { name: "Show price per piece on invoices" }),
    );
    await waitFor(() => expect(within(preview()).queryByText("Per piece")).toBeNull());
  });

  it("T7: a rejected PATCH returns the preview to the stored value", async () => {
    mockPatch.mockRejectedValue(new Error("nope"));
    renderWithProviders(<Harness />);
    await userEvent.click(screen.getByRole("checkbox", { name: "Show barcodes on invoices" }));
    await waitFor(() => expect(mockPatch).toHaveBeenCalled());
    await waitFor(() => expect(within(preview()).getByText("0123456789")).toBeInTheDocument());
  });

  it("T8: the preview totals read Total, Amount Paid, Balance Due in that order", () => {
    renderWithProviders(<Harness />);
    const labels = within(screen.getByTestId("preview-totals"))
      .getAllByTestId("preview-total-label")
      .map((n) => n.textContent);
    expect(labels).toEqual(["Total", "Amount Paid", "Balance Due"]);
  });

  it("T9: says where the layout applies", () => {
    renderWithProviders(<Harness />);
    expect(
      screen.getByText(
        "Choose what prints on your invoices. Applies to the invoice PDF, the counter's Print invoice and the invoice email.",
      ),
    ).toBeInTheDocument();
    expect(
      screen.getByText("Sample. Your invoices use your own items and amounts."),
    ).toBeInTheDocument();
    expect(screen.getByText("Preview")).toBeInTheDocument();
  });
});
