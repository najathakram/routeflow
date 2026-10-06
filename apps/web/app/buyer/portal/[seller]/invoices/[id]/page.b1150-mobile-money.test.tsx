import { invoiceItem, invoicePayment } from "@/test-utils/buyer-invoice-fixtures";
import * as React from "react";
import { renderWithProviders, screen } from "@/test-utils/render";
import type { BuyerInvoiceDetail } from "@/lib/api/buyer";
import Page from "./page";

/**
 * B1150: at 390 px the four money tiles were a fixed `grid-cols-4` (amounts cut off, e.g.
 * "$1,000.0(") and the Items table clipped its SUBTOTAL column. jsdom has no layout engine, so the
 * contract asserted here is the one the browser acts on: the tile grid collapses to two columns
 * below `sm`, no element holding an amount (or any ancestor inside its tile/line) carries a class
 * that clips or ellipsises text, and every amount renders in full.
 */
const CLIPPING =
  /(^|\s)(truncate|text-ellipsis|overflow-hidden|overflow-x-hidden|line-clamp-\d+)(\s|$)/;

function makeInvoice(overrides: Partial<BuyerInvoiceDetail> = {}): BuyerInvoiceDetail {
  return {
    id: "inv-1",
    invoiceNumber: "INV-0001",
    status: "PARTIAL",
    subtotal: 1_000_000,
    taxAmount: 0,
    discount: 0,
    shippingFee: 0,
    total: 1_000_000,
    dueDate: null,
    sentAt: null,
    viewedAt: null,
    paidAt: null,
    issueDate: "2026-01-01",
    pdfUrl: null,
    notes: null,
    terms: null,
    orderId: null,
    balanceDue: 750_000.5,
    items: [
      invoiceItem({
        id: "item-1",
        description: "Pallet of Widgets",
        productId: "p1",
        qty: 10,
        unitPrice: 99_999.95,
        discount: 0,
        subtotal: 999_999.5,
        priceType: "STANDARD",
      }),
      invoiceItem({
        id: "item-2",
        description: "Freight",
        productId: "p2",
        qty: 1,
        unitPrice: 0.5,
        discount: 0,
        subtotal: 0.5,
        priceType: "STANDARD",
      }),
    ],
    payments: [],
    customer: { id: "cust-1", businessName: "Acme Foods" },
    ...overrides,
  };
}

const mockUseBuyerInvoice = jest.fn((..._args: unknown[]) => ({
  data: makeInvoice(),
  isLoading: false,
  isError: false,
}));

jest.mock("next/navigation", () => ({
  useParams: () => ({ seller: "acme", id: "inv-1" }),
  useRouter: () => ({ push: jest.fn() }),
}));

jest.mock("@/lib/buyer-auth-context", () => ({
  ...jest.requireActual("@/lib/buyer-auth-context"),
  useBuyerAuth: () => ({ activeSeller: { id: "seller-1", slug: "acme" }, isLoading: false }),
}));

jest.mock("@/lib/api/buyer", () => ({
  ...jest.requireActual("@/lib/api/buyer"),
  useBuyerInvoice: (...args: unknown[]) => mockUseBuyerInvoice(...args),
}));

jest.mock("@routeflow/ui/web", () => ({
  ...jest.requireActual("@routeflow/ui/web"),
  useToast: () => ({ toast: jest.fn(), dismiss: jest.fn() }),
}));

/** The element's own class plus every ancestor's, up to (and including) `stopAt`. */
function classesUpTo(el: HTMLElement, stopAt: HTMLElement): string[] {
  const out: string[] = [];
  for (let n: HTMLElement | null = el; n; n = n.parentElement) {
    out.push(n.className);
    if (n === stopAt) break;
  }
  return out;
}

const STATES: Array<{
  status: BuyerInvoiceDetail["status"];
  payments: BuyerInvoiceDetail["payments"];
  balanceDue: number;
  balanceText: string;
}> = [
  {
    status: "PARTIAL",
    payments: [invoicePayment({ id: "p1", amount: 249_999.5, method: "CASH", status: "PAID" })],
    balanceDue: 750_000.5,
    balanceText: "$750,000.50",
  },
  {
    status: "PAID",
    payments: [invoicePayment({ id: "p1", amount: 1_000_000, method: "CASH", status: "PAID" })],
    balanceDue: 0,
    balanceText: "$0.00",
  },
  {
    status: "OVERDUE",
    payments: [],
    balanceDue: 1_000_000,
    balanceText: "$1,000,000.00",
  },
];

describe("buyer invoice detail — money fits on phones (B1150)", () => {
  it.each(STATES)(
    "$status: the tile grid is two-up below sm, four-up from sm",
    ({ status, payments, balanceDue }) => {
      mockUseBuyerInvoice.mockReturnValue({
        data: makeInvoice({ status, payments, balanceDue }),
        isLoading: false,
        isError: false,
      });
      renderWithProviders(<Page />);

      const grid = screen.getByTestId("invoice-summary-tiles");
      expect(grid.classList.contains("grid-cols-2")).toBe(true);
      expect(grid.classList.contains("sm:grid-cols-4")).toBe(true);
      // The bug's own value: an unconditional four-up grid at every width.
      expect(grid.classList.contains("grid-cols-4")).toBe(false);
    },
  );

  it.each(STATES)(
    "$status: every tile renders its full amount and nothing clips or ellipsises it",
    ({ status, payments, balanceDue, balanceText }) => {
      mockUseBuyerInvoice.mockReturnValue({
        data: makeInvoice({ status, payments, balanceDue }),
        isLoading: false,
        isError: false,
      });
      renderWithProviders(<Page />);

      const grid = screen.getByTestId("invoice-summary-tiles");
      const expected: Record<string, string> = {
        subtotal: "$1,000,000.00",
        tax: "$0.00",
        total: "$1,000,000.00",
        balance: balanceText,
      };
      for (const [key, text] of Object.entries(expected)) {
        const amount = screen.getByTestId(`invoice-tile-${key}`);
        expect(amount.textContent).toBe(text);
        expect(amount.classList.contains("break-words")).toBe(true);
        for (const cls of classesUpTo(amount, grid)) expect(cls).not.toMatch(CLIPPING);
      }
    },
  );

  it.each(STATES)(
    "$status: each line's subtotal renders in full, visible at every width, never clipped",
    ({ status, payments, balanceDue }) => {
      mockUseBuyerInvoice.mockReturnValue({
        data: makeInvoice({ status, payments, balanceDue }),
        isLoading: false,
        isError: false,
      });
      renderWithProviders(<Page />);

      const expected: Record<string, { sub: string; unit: string; qty: string }> = {
        "item-1": { sub: "$999,999.50", unit: "$99,999.95", qty: "10" },
        "item-2": { sub: "$0.50", unit: "$0.50", qty: "1" },
      };
      for (const [id, want] of Object.entries(expected)) {
        const line = screen.getByTestId(`invoice-line-${id}`);
        for (const [kind, text] of [
          ["subtotal", want.sub],
          ["unit", want.unit],
          ["qty", want.qty],
        ] as const) {
          const cell = screen.getByTestId(`invoice-line-${kind}-${id}`);
          expect(cell.textContent).toContain(text);
          for (const cls of classesUpTo(cell, line)) {
            expect(cls).not.toMatch(CLIPPING);
            // `hidden` (display:none at every width) would hide the money; `sm:hidden` etc. are fine
            expect(cls.split(/\s+/)).not.toContain("hidden");
          }
        }
      }
    },
  );

  it("the line stacks into a card below sm: block rows, labelled cells, table layout only from sm", () => {
    mockUseBuyerInvoice.mockReturnValue({
      data: makeInvoice(),
      isLoading: false,
      isError: false,
    });
    renderWithProviders(<Page />);

    const line = screen.getByTestId("invoice-line-item-1");
    expect(line.classList.contains("block")).toBe(true);
    expect(line.classList.contains("sm:table-row")).toBe(true);
    const sub = screen.getByTestId("invoice-line-subtotal-item-1");
    expect(sub.getAttribute("data-label")).toBe("Subtotal");
    expect(sub.classList.contains("sm:table-cell")).toBe(true);
    expect(screen.getByTestId("invoice-line-unit-item-1").getAttribute("data-label")).toBe(
      "Unit Price",
    );
    expect(screen.getByTestId("invoice-line-qty-item-1").getAttribute("data-label")).toBe("Qty");
  });
});
