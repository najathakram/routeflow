import * as React from "react";
import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { renderWithProviders } from "@/test-utils/render";
import BuyerOrderDetailPage from "./page";

/**
 * REG-B1395 (SA-1292): the buyer edit grid stepped a boxed line ONE PIECE per tap and read a typed number as
 * pieces. "+" on a 3-box line (12 a box, $18.00 a box) sent 37 pieces and priced $55.50; a typed 2 sent 2 pieces
 * ($3.00). The grid now steps, types and clamps in the line's SELLING unit (one box) through the one pricing helper,
 * and the wire stays pieces. The page is exercised end to end: tap, read the row, press Save, read the payload.
 * Fixtures are placeholders (`Sample ...`, `acme`).
 */

jest.mock("next/navigation", () => ({
  useParams: () => ({ seller: "acme", id: "ord-1" }),
  useRouter: () => ({ push: jest.fn() }),
}));

jest.mock("@/lib/buyer-auth-context", () => ({
  ...jest.requireActual("@/lib/buyer-auth-context"),
  useBuyerAuth: () => ({
    isLoading: false,
    activeSeller: {
      tenant: { slug: "acme", name: "Acme Wholesale" },
      customer: { businessName: "Sample Buyer Co" },
    },
  }),
}));

jest.mock("@/lib/api/buyer-capabilities", () => ({
  useBuyerSellerCapabilities: () => ({
    data: { portalMethods: [], portalDefault: null, fleet: true },
    isLoading: false,
    isError: false,
  }),
}));

let mockOrder: unknown;
const mockUpdateItems = jest.fn().mockResolvedValue({});
jest.mock("@/lib/api/buyer", () => ({
  ...jest.requireActual("@/lib/api/buyer"),
  useBuyerOrderTracking: () => ({
    data: { status: "PENDING", tracking: null },
    isLoading: false,
    isError: false,
    refetch: jest.fn(),
  }),
  useBuyerOrder: () => ({
    data: mockOrder,
    isLoading: false,
    isError: false,
    refetch: jest.fn(),
  }),
  useBuyerCancelOrder: () => ({ mutateAsync: jest.fn(), mutate: jest.fn(), isPending: false }),
  useBuyerUpdateOrderItems: () => ({
    mutateAsync: mockUpdateItems,
    mutate: jest.fn(),
    isPending: false,
  }),
  useBuyerProducts: () => ({
    data: {
      data: [
        { id: "p-9", name: "Sample Soda", unit: "each", buyerPrice: 5, unitsPerBox: null },
        { id: "p-8", name: "Sample Water", unit: "each", buyerPrice: 18, unitsPerBox: 12 },
      ],
    },
  }),
  useBuyerCreateChangeRequest: () => ({
    mutateAsync: jest.fn(),
    mutate: jest.fn(),
    isPending: false,
  }),
}));

/** A stored 3-box line: 12 to the box, $18.00 a box, 36 pieces. */
function boxLine(over: Record<string, unknown> = {}) {
  return {
    id: "li-1",
    productId: "p-1",
    qty: 36,
    unitPrice: 18,
    subtotal: 54,
    priceType: "STANDARD",
    originalPrice: null,
    notes: null,
    status: "PENDING",
    deliveredQty: 0,
    boxes: 3,
    pieces: 0,
    unitsPerBox: 12,
    product: { id: "p-1", name: "Sample Cola 12oz", unit: "each", unitsPerBox: 12 },
    ...over,
  };
}

function order(lineItems: unknown[]) {
  return {
    id: "ord-1",
    orderNumber: "ORD-00001",
    status: "PENDING",
    total: 54,
    subtotal: 54,
    taxAmount: 0,
    createdAt: "2026-09-10T12:00:00Z",
    requestedDeliveryDate: null,
    customer: { id: "c-1", businessName: "Sample Buyer Co" },
    lineItems,
    invoices: [],
    changeRequests: [],
    editWindow: { editable: true, editableUntil: null, closedReason: null },
    routeRun: null,
    revisionNumber: 3,
  };
}

function open(lines: unknown[]) {
  mockOrder = order(lines);
  renderWithProviders(<BuyerOrderDetailPage />);
  fireEvent.click(screen.getByRole("button", { name: /edit items/i }));
}

/** The qty box, its [-] and [+] of the Nth edit row. */
function controls(n = 0) {
  const box = screen.getAllByRole("spinbutton")[n] as HTMLInputElement;
  const [minus, plus] = Array.from(box.parentElement!.querySelectorAll("button"));
  return { box, minus, plus, row: box.closest("tr") as HTMLElement };
}

async function saved() {
  fireEvent.click(screen.getByRole("button", { name: /save changes/i }));
  await waitFor(() => expect(mockUpdateItems).toHaveBeenCalledTimes(1));
  return mockUpdateItems.mock.calls[0][0].items;
}

const subtotal = (row: HTMLElement) => within(row).getAllByRole("cell").slice(-1)[0].textContent;

beforeEach(() => jest.clearAllMocks());

describe("REG-B1395 buyer edit grid steps and types the selling unit (SA-1292)", () => {
  it("a stored 3-box line shows 3 in the box, not 36", () => {
    open([boxLine()]);
    expect(controls().box.value).toBe("3");
  });

  it('"+" adds one BOX: 48 pieces sent, $72.00 shown', async () => {
    open([boxLine()]);
    const c = controls();
    fireEvent.click(c.plus);
    expect(c.box.value).toBe("4");
    expect(subtotal(c.row)).toBe("$72.00");
    expect(await saved()).toEqual([{ productId: "p-1", qty: 48, orderItemId: "li-1" }]);
  });

  it('"-" takes one BOX off: 24 pieces sent, $36.00 shown', async () => {
    open([boxLine()]);
    const c = controls();
    fireEvent.click(c.minus);
    expect(c.box.value).toBe("2");
    expect(subtotal(c.row)).toBe("$36.00");
    expect(await saved()).toEqual([{ productId: "p-1", qty: 24, orderItemId: "li-1" }]);
  });

  it("a typed 2 means 2 boxes: 24 pieces, $36.00", async () => {
    open([boxLine()]);
    const c = controls();
    fireEvent.change(c.box, { target: { value: "2" } });
    expect(subtotal(c.row)).toBe("$36.00");
    expect(await saved()).toEqual([{ productId: "p-1", qty: 24, orderItemId: "li-1" }]);
  });

  it("a typed 4 means 4 boxes: 48 pieces, $72.00", async () => {
    open([boxLine()]);
    const c = controls();
    fireEvent.change(c.box, { target: { value: "4" } });
    expect(subtotal(c.row)).toBe("$72.00");
    expect(await saved()).toEqual([{ productId: "p-1", qty: 48, orderItemId: "li-1" }]);
  });

  it("a typed number past the limit sets the box to the limit and says so (8,333 boxes at 12 a box)", () => {
    open([boxLine()]);
    const c = controls();
    fireEvent.change(c.box, { target: { value: "9000" } });
    expect(c.box.value).toBe("8333");
    expect(screen.getByText("The most you can order at once is 8,333 boxes.")).toBeInTheDocument();
  });

  it('"+" at the limit stays at the limit and shows the limit line', async () => {
    open([boxLine()]);
    const c = controls();
    fireEvent.change(c.box, { target: { value: "8333" } });
    fireEvent.click(c.plus);
    expect(c.box.value).toBe("8333");
    expect(screen.getByText("The most you can order at once is 8,333 boxes.")).toBeInTheDocument();
    expect(await saved()).toEqual([{ productId: "p-1", qty: 99996, orderItemId: "li-1" }]);
  });

  it('"-" at 1 box stays at 1 (the row delete is the way to remove)', () => {
    open([boxLine({ qty: 12, boxes: 1, subtotal: 18 })]);
    const c = controls();
    fireEvent.click(c.minus);
    expect(c.box.value).toBe("1");
  });

  it("a promo row keeps its free units following buyerLineFreeUnits at the new count (12 boxes, 2 free, minus one box)", () => {
    open([boxLine({ qty: 144, boxes: 12, subtotal: 180, promoFreeUnits: 2, priceType: "PROMO" })]);
    const c = controls();
    expect(within(c.row).getByText("2 free")).toBeInTheDocument();
    fireEvent.click(c.minus);
    expect(c.box.value).toBe("11");
    // OBSERVED on the helper's count: floor(2 * 11 / 12) = 1 free, never more than was agreed.
    expect(within(c.row).getByText("1 free")).toBeInTheDocument();
    // 11 boxes less 1 free is 10 paid boxes at $18.00.
    expect(subtotal(c.row)).toBe("$180.00");
  });
});

describe("REG-B1395 greens: rows that are NOT a whole-box line keep stepping their own unit", () => {
  it("a pack row (stored in packs, no split) at 2, plus: 3", async () => {
    open([
      boxLine({
        qty: 2,
        boxes: null,
        pieces: null,
        unitsPerBox: null,
        subtotal: 36,
        product: { id: "p-1", name: "Sample Cola 12oz", unit: "case", unitsPerBox: null },
      }),
    ]);
    const c = controls();
    expect(c.box.value).toBe("2");
    fireEvent.click(c.plus);
    expect(c.box.value).toBe("3");
    expect(await saved()).toEqual([{ productId: "p-1", qty: 3, orderItemId: "li-1" }]);
  });

  it("a new search row at 1, plus: 2, sent with no orderItemId", async () => {
    open([boxLine({ qty: 12, boxes: 1, subtotal: 18 })]);
    fireEvent.change(screen.getByPlaceholderText(/search products to add/i), {
      target: { value: "soda" },
    });
    fireEvent.click(await screen.findByRole("button", { name: /Sample Soda/ }));
    const c = controls(1);
    expect(c.box.value).toBe("1");
    fireEvent.click(c.plus);
    expect(c.box.value).toBe("2");
    expect(await saved()).toEqual([
      { productId: "p-1", qty: 12, orderItemId: "li-1" },
      { productId: "p-9", qty: 2 },
    ]);
  });

  it("a repacked row (stored 12, live 6) at 36, plus: 37 pieces", async () => {
    open([
      boxLine({
        product: { id: "p-1", name: "Sample Cola 12oz", unit: "each", unitsPerBox: 6 },
      }),
    ]);
    const c = controls();
    expect(c.box.value).toBe("36");
    fireEvent.click(c.plus);
    expect(c.box.value).toBe("37");
    expect(await saved()).toEqual([{ productId: "p-1", qty: 37, orderItemId: "li-1" }]);
  });

  it("a loose-piece row (3 boxes and 2 pieces = 38) plus: 39 pieces", async () => {
    open([boxLine({ qty: 38, boxes: 3, pieces: 2, subtotal: 57 })]);
    const c = controls();
    expect(c.box.value).toBe("38");
    fireEvent.click(c.plus);
    expect(c.box.value).toBe("39");
    expect(await saved()).toEqual([{ productId: "p-1", qty: 39, orderItemId: "li-1" }]);
  });

  it("a 4-box row saves { productId, qty: 48, orderItemId } with no other keys", async () => {
    open([boxLine({ qty: 48, boxes: 4, subtotal: 72 })]);
    const items = await saved();
    expect(items).toEqual([{ productId: "p-1", qty: 48, orderItemId: "li-1" }]);
    expect(Object.keys(items[0]).sort()).toEqual(["orderItemId", "productId", "qty"]);
  });

  it("an untouched box line saves its own pieces unchanged", async () => {
    open([boxLine()]);
    expect(await saved()).toEqual([{ productId: "p-1", qty: 36, orderItemId: "li-1" }]);
  });
});
