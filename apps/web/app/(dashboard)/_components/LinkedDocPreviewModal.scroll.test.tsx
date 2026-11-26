import * as React from "react";
import { renderWithProviders, screen, fireEvent, waitFor } from "@/test-utils/render";
import { InvoicePreviewModal, LinkedOrderLine, OrderPreviewModal } from "./LinkedDocPreviewModal";

/**
 * B1424: the linked-order preview (and its mirror, the linked-invoice preview) was a Modal with no max height and no
 * scrolling body, so an order taller than the screen spilled off both edges with the page scroll-locked: it could not
 * be scrolled, and its close button and "Open full order" link were out of reach. The preview now caps at the screen,
 * scrolls its body, pins a link to the order's own page, and hands focus back to what opened it.
 *
 * Not provable in jsdom: that the browser really scrolls the wheel/touch/keyboard (jsdom does no layout). These tests
 * pin the structure that makes it scroll (capped dialog + overflow body) and the links and focus behaviour.
 */
let invoice: Record<string, unknown> | undefined;
let order: Record<string, unknown> | undefined;
jest.mock("@/lib/api/invoices", () => ({
  ...jest.requireActual("@/lib/api/invoices"),
  useInvoice: () => ({ data: invoice, isLoading: false }),
}));
jest.mock("@/lib/api/orders", () => ({
  ...jest.requireActual("@/lib/api/orders"),
  useOrder: () => ({ data: order, isLoading: false }),
}));
jest.mock("@/lib/api/tracked-categories", () => ({
  ...jest.requireActual("@/lib/api/tracked-categories"),
  useTrackedCategories: () => ({ data: [] }),
}));

const line = (id: string, status: string) => ({
  id,
  qty: 1,
  unitPrice: 1,
  subtotal: 1,
  status,
  description: `Item ${id}`,
});

beforeEach(() => {
  order = {
    id: "ord-1",
    orderNumber: "ORD-100",
    status: "PENDING",
    orderDate: "2026-11-20",
    customer: { id: "c1", businessName: "Acme Foods" },
    subtotal: 100,
    tax: 0,
    total: 100,
    invoices: [],
    lineItems: [
      ...Array.from({ length: 60 }, (_, n) => line(`live-${n}`, "ACTIVE")),
      line("gone-1", "CANCELLED"),
      line("gone-2", "CANCELLED"),
    ],
  };
  invoice = {
    id: "inv-1",
    invoiceNumber: "INV-1",
    subtotal: 10,
    total: 10,
    paidAmount: 0,
    balanceDue: 10,
    items: [{ id: "i1", description: "Soda", qty: 1, unitPrice: 10, subtotal: 10 }],
  };
});

function scrollBody() {
  const dialog = screen.getByRole("dialog");
  expect(dialog.className).toContain("max-h-[92vh]");
  const body = screen.getByRole("table").closest(".overflow-y-auto");
  expect(body).not.toBeNull();
  expect(dialog.contains(body)).toBe(true);
  // Close and the open-page links live outside the scrolling body, so they stay reachable.
  expect(body!.contains(screen.getByRole("button", { name: "Close" }))).toBe(false);
  return body!;
}

describe("OrderPreviewModal (B1424)", () => {
  it("caps at the screen and scrolls only its body, keeping Close and the footer reachable", () => {
    renderWithProviders(<OrderPreviewModal open onClose={() => undefined} orderId="ord-1" />);
    const body = scrollBody();
    expect(body.contains(screen.getByRole("link", { name: "Open order" }))).toBe(false);
  });

  it("opens the order page from a pinned header link and the footer button", () => {
    renderWithProviders(<OrderPreviewModal open onClose={() => undefined} orderId="ord-1" />);
    const body = scrollBody();
    const header = screen.getByRole("link", { name: "Open order ORD-100" });
    expect(header).toHaveAttribute("href", "/orders/ord-1");
    expect(body.contains(header)).toBe(false);
    expect(screen.getByRole("link", { name: "Open order" })).toHaveAttribute(
      "href",
      "/orders/ord-1",
    );
  });

  it("names the customer and says cancelled lines are not shown", () => {
    renderWithProviders(<OrderPreviewModal open onClose={() => undefined} orderId="ord-1" />);
    expect(screen.getByText(/Acme Foods/)).toBeInTheDocument();
    expect(screen.getByText("2 cancelled lines not shown.")).toBeInTheDocument();
    expect(screen.queryByText("Item gone-1")).toBeNull();
  });

  it("returns focus to the control that opened it, and leaves the page unlocked, on close", async () => {
    function Harness() {
      const [open, setOpen] = React.useState(false);
      return (
        <>
          <button type="button" onClick={() => setOpen(true)}>
            Preview
          </button>
          <OrderPreviewModal open={open} onClose={() => setOpen(false)} orderId="ord-1" />
        </>
      );
    }
    renderWithProviders(<Harness />);
    const opener = screen.getByRole("button", { name: "Preview" });
    opener.focus();
    fireEvent.click(opener);
    await screen.findByRole("dialog");
    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    await waitFor(() => expect(opener).toHaveFocus());
    expect(document.body.style.pointerEvents).not.toBe("none");
  });
});

describe("InvoicePreviewModal (B1424 mirror)", () => {
  it("caps at the screen and scrolls only its body", () => {
    renderWithProviders(<InvoicePreviewModal open onClose={() => undefined} invoiceId="inv-1" />);
    scrollBody();
  });

  it("opens the invoice page from a pinned header link and the footer button", () => {
    renderWithProviders(<InvoicePreviewModal open onClose={() => undefined} invoiceId="inv-1" />);
    expect(screen.getByRole("link", { name: "Open invoice INV-1" })).toHaveAttribute(
      "href",
      "/invoices/inv-1",
    );
    expect(screen.getByRole("link", { name: "Open invoice" })).toHaveAttribute(
      "href",
      "/invoices/inv-1",
    );
  });
});

describe("LinkedOrderLine (B1424 card on the invoice page)", () => {
  it("makes the order number the link and Preview a separate button", () => {
    const onPreview = jest.fn();
    renderWithProviders(
      <LinkedOrderLine orderId="ord-1" orderNumber="ORD-100" onPreview={onPreview} />,
    );
    expect(screen.getByRole("link", { name: "Order ORD-100" })).toHaveAttribute(
      "href",
      "/orders/ord-1",
    );
    fireEvent.click(screen.getByRole("button", { name: "Preview" }));
    expect(onPreview).toHaveBeenCalledTimes(1);
  });
});
