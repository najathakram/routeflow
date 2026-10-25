import * as React from "react";
import { screen, renderWithProviders } from "@/test-utils/render";
import { seedSession } from "@/test-utils/session";
import InvoiceDetailPage from "./page";

/**
 * Row 689: at 390 px the invoice-detail line table ran wider than the screen (px-8 item cell, px-4 qty/price, px-8 amount),
 * so the Amount column sat past the right edge and the card scrolled sideways, in box mode and (12 px wider) in piece mode.
 * Below md each line is now a stacked card row (the order-detail pattern, row 508): item full width, then Qty, Unit Price
 * and Amount as labelled cells. jsdom has no layout, so these pin the breakpoint wiring and the md+ classes. The pixel
 * proof (document scrollWidth <= innerWidth at 390, every cell's right edge <= 390) is the browser capture.
 */
let mockInvoice: Record<string, unknown>;

jest.mock("next/navigation", () => ({
  useRouter: () => ({ push: jest.fn(), replace: jest.fn() }),
  useParams: () => ({ id: "inv-1" }),
  usePathname: () => "/invoices/inv-1",
  useSearchParams: () => new URLSearchParams(),
}));
jest.mock("@/lib/api/invoices", () => {
  const actual = jest.requireActual("@/lib/api/invoices");
  const idle = () => ({
    data: undefined,
    isLoading: false,
    isError: false,
    isPending: false,
    mutate: jest.fn(),
    mutateAsync: jest.fn(),
  });
  const hooks: Record<string, unknown> = {};
  for (const key of Object.keys(actual)) {
    if (/^use[A-Z]/.test(key)) hooks[key] = idle;
  }
  return {
    ...actual,
    ...hooks,
    useInvoice: () => ({ data: mockInvoice, isLoading: false, isError: false }),
  };
});
jest.mock("@/lib/api/counter-sale", () => ({
  ...jest.requireActual("@/lib/api/counter-sale"),
  useCounterSaleGate: () => ({
    capability: { methods: ["ROUTE"], staffDefault: "ROUTE", counter: "optional" },
    loading: false,
  }),
}));
jest.mock("@/lib/api/tracked-categories", () => ({
  useTrackedCategories: () => ({ data: [] }),
}));
jest.mock("@/lib/api/credit-notes", () => ({
  ...jest.requireActual("@/lib/api/credit-notes"),
  useUnapplyCreditNote: () => ({ mutate: jest.fn(), isPending: false }),
}));
jest.mock("@/lib/api/customers", () => ({
  ...jest.requireActual("@/lib/api/customers"),
  useCustomerAdvancePayments: () => ({ data: [], isLoading: false }),
}));
jest.mock("@/lib/use-duplicate-invoice-action", () => ({
  useDuplicateInvoiceAction: () => ({ duplicate: jest.fn() }),
}));

const line = (over: Record<string, unknown>) => ({
  id: "li-1",
  description: "Sample Cola 12oz",
  qty: 24,
  unitPrice: "21.60",
  subtotal: "43.20",
  priceType: "STANDARD",
  ...over,
});

const boxLine = line({ id: "box", boxes: 2, pieces: 0, unitsPerBox: 24, qty: 48 });
const pieceLine = line({
  id: "pcs",
  description: "Sample Nuts 16oz",
  boxes: 0,
  pieces: 48,
  unitsPerBox: 24,
  qty: 48,
  unitPrice: "0.90",
});

const invoice = () => ({
  id: "inv-1",
  invoiceNumber: "INV-0042",
  status: "SENT",
  total: "86.40",
  subtotal: "86.40",
  paidAmount: "0.00",
  balanceDue: "86.40",
  issueDate: "2026-09-01T00:00:00.000Z",
  customer: { id: "c1", businessName: "Acme Foods" },
  items: [boxLine, pieceLine],
  payments: [],
});

beforeEach(() => {
  seedSession("OPERATOR");
  mockInvoice = invoice();
});
afterEach(() => seedSession(null));

const MOBILE_CELL = ["max-md:block", "max-md:p-0", "max-md:before:content-[attr(data-label)]"];

function lineTable() {
  renderWithProviders(<InvoiceDetailPage />);
  return screen.getAllByRole("table").find((t) => t.querySelector("tbody tr"))!;
}

describe("invoice detail line table: stacked card rows below md (row 689)", () => {
  it("re-flows the table into blocks and keeps the column headers for screen readers", () => {
    const table = lineTable();
    expect(table).toHaveClass("max-md:block");
    const thead = table.querySelector("thead") as HTMLElement;
    expect(thead).toHaveClass("max-md:sr-only");
    expect(thead).not.toHaveClass("max-md:hidden");
    expect(table.querySelector("tbody")).toHaveClass("max-md:block", "max-md:px-8");
    expect(Array.from(table.querySelectorAll("th")).map((h) => h.textContent)).toEqual([
      "Item",
      "Qty",
      "Unit Price",
      "Amount",
    ]);
  });

  it.each([
    ["box", 0],
    ["piece", 1],
  ])("%s line: a grid row with a full-width item and labelled Qty, Unit Price, Amount", (_m, i) => {
    const row = lineTable().querySelectorAll("tbody tr")[i] as HTMLElement;
    expect(row).toHaveClass("max-md:grid", "max-md:grid-cols-2");
    const cells = Array.from(row.querySelectorAll("td"));
    expect(cells.map((c) => c.getAttribute("data-label"))).toEqual([
      null,
      "Qty",
      "Unit Price",
      "Amount",
    ]);
    expect(cells[0]).toHaveClass("max-md:col-span-2", "max-md:block", "max-md:p-0");
    cells.slice(1).forEach((c) => expect(c).toHaveClass(...MOBILE_CELL));
  });

  it("keeps the money: the Amount cell still reads the stored subtotal on both lines", () => {
    const rows = lineTable().querySelectorAll("tbody tr");
    expect(rows[0].querySelector('td[data-label="Amount"]')).toHaveTextContent("$43.20");
    expect(rows[1].querySelector('td[data-label="Amount"]')).toHaveTextContent("$43.20");
    expect(rows[0].querySelector('td[data-label="Qty"]')).toHaveTextContent(/2/);
    expect(rows[1].querySelector('td[data-label="Qty"]')).toHaveTextContent(/48/);
  });

  it("lets a long item name wrap instead of widening the card", () => {
    const row = lineTable().querySelector("tbody tr") as HTMLElement;
    expect(row.querySelector("td")).toHaveClass("max-md:break-words");
  });

  it("leaves the md+ table classes exactly as they were", () => {
    const table = lineTable();
    expect(table).toHaveClass("w-full", "text-sm");
    const cells = Array.from(table.querySelectorAll("tbody tr")[0].querySelectorAll("td"));
    expect(cells[0]).toHaveClass("px-8", "py-3");
    expect(cells[1]).toHaveClass("px-4", "py-3", "text-right");
    expect(cells[2]).toHaveClass("px-4", "py-3", "text-right");
    expect(cells[3]).toHaveClass("px-8", "py-3", "text-right");
  });
});
