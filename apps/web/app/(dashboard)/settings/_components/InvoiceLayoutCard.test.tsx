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

const ON = {
  hideOriginalPrice: false,
  hideBarcodes: false,
  hidePerPiece: false,
  hideAmountPaid: false,
  hideBalanceDue: false,
};

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
  it("the preview panel is a named group, so a screen reader announces it", () => {
    renderWithProviders(<Harness />);
    expect(screen.getByRole("group", { name: "Invoice preview" })).toBe(preview());
  });

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
        "Choose what prints on your invoices. The counter's Print invoice prints the PDF.",
      ),
    ).toBeInTheDocument();
    expect(
      screen.getByText("Sample. Your invoices use your own items and amounts."),
    ).toBeInTheDocument();
    expect(screen.getByText("Preview")).toBeInTheDocument();
  });

  it("T10d: five rows render, checked when nothing is hidden", () => {
    renderWithProviders(<Harness />);
    for (const name of [
      "Show original price on discounted lines",
      "Show barcodes on invoices",
      "Show price per piece on invoices",
      "Show amount paid",
      "Show balance due",
    ]) {
      expect(screen.getByRole("checkbox", { name })).toBeChecked();
    }
  });

  it.each([
    ["Show amount paid", "hideAmountPaid", "Amount Paid"],
    ["Show balance due", "hideBalanceDue", "Balance Due"],
  ])("T10d: flipping %s drops its preview line at once and PATCHes", async (name, key, line) => {
    mockPatch.mockImplementation(() => new Promise(() => {}));
    renderWithProviders(<Harness />);
    expect(within(preview()).getByText(line)).toBeInTheDocument();
    await userEvent.click(screen.getByRole("checkbox", { name }));
    await waitFor(() => expect(within(preview()).queryByText(line)).toBeNull());
    expect(within(preview()).getByText("Total")).toBeInTheDocument();
    expect(mockPatch).toHaveBeenCalledWith("/settings/invoice", { [key]: true });
  });

  // #3686 read 1 NIT: the checkbox reads the in-flight value like the preview, not the stored one.
  it("T10d: while the save runs the checkbox already shows the new state, with the preview", async () => {
    mockPatch.mockImplementation(() => new Promise(() => {}));
    renderWithProviders(<Harness />);
    const box = screen.getByRole("checkbox", { name: "Show balance due" });
    await userEvent.click(box);
    await waitFor(() => expect(within(preview()).queryByText("Balance Due")).toBeNull());
    expect(box).not.toBeChecked();
  });

  it("T10d: a rejected PATCH on a new row returns its line to the preview", async () => {
    mockPatch.mockRejectedValue(new Error("nope"));
    renderWithProviders(<Harness />);
    await userEvent.click(screen.getByRole("checkbox", { name: "Show amount paid" }));
    await waitFor(() => expect(mockPatch).toHaveBeenCalled());
    await waitFor(() => expect(within(preview()).getByText("Amount Paid")).toBeInTheDocument());
  });
});

// SA-1197 (T12, C14): the one SHOW switch in the card. Absent = off, so its box starts unchecked; checking it sends
// `showAccountBalance: true` (never the hide rows' inverse), and the preview shows the block under Balance Due.
describe("InvoiceLayoutCard: Show open balance on invoices (SA-1197)", () => {
  const NAME = "Show open balance on invoices";

  it("T12: starts unchecked when the key was never written, and checking it PATCHes true", async () => {
    mockPatch.mockImplementation(() => new Promise(() => {}));
    renderWithProviders(<Harness />);
    const box = screen.getByRole("checkbox", { name: NAME });
    expect(box).not.toBeChecked();
    expect(within(preview()).queryByText("Other unpaid invoices")).toBeNull();
    await userEvent.click(box);
    expect(mockPatch).toHaveBeenCalledWith("/settings/invoice", { showAccountBalance: true });
    await waitFor(() =>
      expect(within(preview()).getByText("Other unpaid invoices")).toBeInTheDocument(),
    );
    expect(box).toBeChecked();
  });

  it("T12: stored on reads checked, and unchecking PATCHes false; the hide rows keep their inverse", async () => {
    mockPatch.mockImplementation(() => new Promise(() => {}));
    renderWithProviders(<Harness stored={{ ...ON, showAccountBalance: true } as typeof ON} />);
    const box = screen.getByRole("checkbox", { name: NAME });
    expect(box).toBeChecked();
    await userEvent.click(box);
    expect(mockPatch).toHaveBeenCalledWith("/settings/invoice", { showAccountBalance: false });
  });

  it("T11 preview: Balance Due hidden prints only the 'Open balance on' line", () => {
    renderWithProviders(
      <Harness stored={{ ...ON, hideBalanceDue: true, showAccountBalance: true } as typeof ON} />,
    );
    expect(within(preview()).getByText(/^Open balance on /)).toBeInTheDocument();
    expect(within(preview()).queryByText("Other unpaid invoices")).toBeNull();
    expect(within(preview()).queryByText("This invoice")).toBeNull();
  });
});
