import * as React from "react";
import { fireEvent, screen, waitFor } from "@testing-library/react";
import { renderWithProviders } from "@/test-utils/render";
import { readFileSync } from "fs";
import { join } from "path";
import { componentSubLineText } from "@routeflow/pricing";
import BuyerOrderDetailPage from "./page";

/**
 * B586 — the buyer order detail crashed ("Cannot read properties of null (reading 'name')") for
 * any order containing a staff-added custom (unlisted) line: such a line has `product: null` and
 * its label in `name`. The page read `li.product.name` unguarded in the items table, the
 * change-request select and edit-mode entry.
 *
 * Fixtures are placeholders (`Sample …`); no live-client names.
 */

const push = jest.fn();
jest.mock("next/navigation", () => ({
  useParams: () => ({ seller: "acme", id: "ord-1" }),
  useRouter: () => ({ push }),
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

// Business profiles 1B: an UNSET seller — this suite pins today's screen.
jest.mock("@/lib/api/buyer-capabilities", () => ({
  useBuyerSellerCapabilities: () => ({
    data: { portalMethods: [], portalDefault: null, fleet: true },
    isLoading: false,
    isError: false,
  }),
}));

let mockOrder: unknown;
const mockUpdateItems = jest.fn().mockResolvedValue({});
// #2095: the page now renders the "Track your delivery" card, which reads this hook.
let mockTracking: unknown;
jest.mock("@/lib/api/buyer", () => ({
  ...jest.requireActual("@/lib/api/buyer"),
  useBuyerOrderTracking: () => mockTracking,
  useBuyerOrder: () => ({ data: mockOrder, isLoading: false, isError: false }),
  useBuyerCancelOrder: () => ({ mutateAsync: jest.fn(), mutate: jest.fn(), isPending: false }),
  useBuyerUpdateOrderItems: () => ({
    mutateAsync: mockUpdateItems,
    mutate: jest.fn(),
    isPending: false,
  }),
  useBuyerProducts: () => ({ data: undefined }),
  useBuyerCreateChangeRequest: () => ({
    mutateAsync: jest.fn(),
    mutate: jest.fn(),
    isPending: false,
  }),
}));

const LISTED = {
  id: "li-1",
  productId: "p-1",
  qty: 2,
  unitPrice: 10,
  subtotal: 20,
  priceType: "STANDARD",
  originalPrice: null,
  notes: null,
  status: "PENDING",
  deliveredQty: 0,
  boxes: null,
  pieces: null,
  product: { id: "p-1", name: "Sample Cola 12oz", unit: "each", unitsPerBox: null },
};

const CUSTOM = {
  id: "li-2",
  productId: null,
  name: "Delivery surcharge",
  qty: 1,
  unitPrice: 15,
  subtotal: 15,
  priceType: "MANUAL",
  originalPrice: null,
  notes: null,
  status: "PENDING",
  deliveredQty: 0,
  boxes: null,
  pieces: null,
  product: null,
};

function order(lineItems: unknown[], over: Record<string, unknown> = {}) {
  return {
    id: "ord-1",
    orderNumber: "ORD-00001",
    status: "PENDING",
    total: 35,
    subtotal: 35,
    taxAmount: 0,
    createdAt: "2026-09-10T12:00:00Z",
    requestedDeliveryDate: null,
    customer: { id: "c-1", businessName: "Sample Buyer Co" },
    lineItems,
    invoices: [],
    changeRequests: [],
    editWindow: { editable: true, editableUntil: null, closedReason: null },
    routeRun: null,
    ...over,
  };
}

beforeEach(() => {
  jest.clearAllMocks();
  mockTracking = {
    data: { status: "PENDING", tracking: null },
    isLoading: false,
    isError: false,
    refetch: jest.fn(),
  };
});

describe("BuyerOrderDetailPage — Track your delivery (#2095)", () => {
  it("shows the tracking card under the timeline, fed by this order's tracking", () => {
    mockOrder = order([LISTED], { status: "CONFIRMED" });
    mockTracking = {
      data: {
        status: "CONFIRMED",
        tracking: {
          runId: "run-1",
          routeName: null,
          driverName: "Sam",
          runStatus: "IN_PROGRESS",
          stopNumber: 5,
          stopStatus: "PENDING",
          stopsAhead: 2,
          scheduledDate: "2026-09-29T00:00:00.000Z",
          estimatedArrivalWindow: { start: "09:00", end: "11:00" },
        },
      },
      isLoading: false,
      isError: false,
      refetch: jest.fn(),
    };
    renderWithProviders(<BuyerOrderDetailPage />);
    expect(screen.getByRole("heading", { name: "Track your delivery" })).toBeInTheDocument();
    expect(screen.getByTestId("tracking-headline")).toHaveTextContent("2 stops before you");
  });

  it("a not-yet-scheduled order says so", () => {
    mockOrder = order([LISTED]);
    renderWithProviders(<BuyerOrderDetailPage />);
    expect(screen.getByTestId("tracking-headline")).toHaveTextContent("Not scheduled yet");
  });
});

describe("BuyerOrderDetailPage — order with a custom line (B586)", () => {
  it("REG-B586: renders instead of crashing, showing the custom line's own label", () => {
    mockOrder = order([LISTED, CUSTOM]);
    renderWithProviders(<BuyerOrderDetailPage />);
    expect(screen.getByText("Sample Cola 12oz")).toBeInTheDocument();
    expect(screen.getByText("Delivery surcharge")).toBeInTheDocument();
  });

  it("a custom line with no label at all reads 'Custom item'", () => {
    mockOrder = order([{ ...CUSTOM, name: null }]);
    renderWithProviders(<BuyerOrderDetailPage />);
    expect(screen.getByText("Custom item")).toBeInTheDocument();
  });

  it("Edit is still offered on an order with a custom line; edit mode lists only the catalog lines and says the custom item stays", () => {
    mockOrder = order([LISTED, CUSTOM]);
    renderWithProviders(<BuyerOrderDetailPage />);
    expect(screen.queryByTestId("custom-line-edit-note")).toBeNull(); // only while editing
    fireEvent.click(screen.getByRole("button", { name: /edit items/i }));

    expect(screen.getByTestId("custom-line-edit-note")).toHaveTextContent("stay on your order");
    expect(screen.getByText("Sample Cola 12oz")).toBeInTheDocument();
    expect(screen.queryByText("Delivery surcharge")).toBeNull();
  });

  it("saving sends catalog lines only — the server keeps the seller's custom line (REG-B51)", async () => {
    mockOrder = order([LISTED, CUSTOM]);
    renderWithProviders(<BuyerOrderDetailPage />);
    fireEvent.click(screen.getByRole("button", { name: /edit items/i }));
    fireEvent.click(screen.getByRole("button", { name: /save changes/i }));

    await waitFor(() => expect(mockUpdateItems).toHaveBeenCalledTimes(1));
    expect(mockUpdateItems).toHaveBeenCalledWith({
      orderId: "ord-1",
      items: [{ productId: "p-1", qty: 2, orderItemId: "li-1" }],
    });
  });

  // B297 row 352: after a rate change one product can be two lines sold at different excise rates. Each row
  // is its own stored line: stepping one never touches the other, and Save names each line.
  it("row 352: two lines of one product are two rows and Save names each line", async () => {
    mockOrder = order([LISTED, { ...LISTED, id: "li-2", qty: 8 }]);
    renderWithProviders(<BuyerOrderDetailPage />);
    fireEvent.click(screen.getByRole("button", { name: /edit items/i }));
    const qtyInputs = screen.getAllByRole("spinbutton");
    expect(qtyInputs).toHaveLength(2);
    fireEvent.change(qtyInputs[1], { target: { value: "5" } });
    fireEvent.click(screen.getByRole("button", { name: /save changes/i }));

    await waitFor(() => expect(mockUpdateItems).toHaveBeenCalledTimes(1));
    expect(mockUpdateItems).toHaveBeenCalledWith({
      orderId: "ord-1",
      items: [
        { productId: "p-1", qty: 2, orderItemId: "li-1" },
        { productId: "p-1", qty: 5, orderItemId: "li-2" },
      ],
    });
  });

  it("row 352: a 409 ORDER_EDIT_NEEDS_LINE_IDS tells the buyer to refresh", async () => {
    mockUpdateItems.mockRejectedValueOnce({
      response: { status: 409, data: { code: "ORDER_EDIT_NEEDS_LINE_IDS", message: "x" } },
    });
    mockOrder = order([LISTED]);
    renderWithProviders(<BuyerOrderDetailPage />);
    fireEvent.click(screen.getByRole("button", { name: /edit items/i }));
    fireEvent.click(screen.getByRole("button", { name: /save changes/i }));
    expect(await screen.findByText(/Refresh and try again/)).toBeInTheDocument();
  });

  it("a custom line does not get a 'Special' pill (its MANUAL price type is not a customer special)", () => {
    mockOrder = order([CUSTOM]);
    renderWithProviders(<BuyerOrderDetailPage />);
    expect(screen.queryByText("Special")).toBeNull();
  });

  it("cancelling is still available on such an order", () => {
    mockOrder = order([LISTED, CUSTOM]);
    renderWithProviders(<BuyerOrderDetailPage />);
    expect(screen.getByRole("button", { name: /cancel order/i })).toBeInTheDocument();
  });

  it("no custom-item note when the only custom line is cancelled", () => {
    mockOrder = order([LISTED, { ...CUSTOM, status: "CANCELLED" }]);
    renderWithProviders(<BuyerOrderDetailPage />);
    fireEvent.click(screen.getByRole("button", { name: /edit items/i }));
    expect(screen.queryByTestId("custom-line-edit-note")).toBeNull();
  });

  it("an order of catalog lines only is unchanged: Edit is offered and enters edit mode", () => {
    mockOrder = order([LISTED]);
    renderWithProviders(<BuyerOrderDetailPage />);
    fireEvent.click(screen.getByRole("button", { name: /edit items/i }));
    expect(screen.getByRole("button", { name: /save changes/i })).toBeInTheDocument();
    expect(screen.queryByTestId("custom-line-edit-note")).toBeNull();
  });

  it("the change-request line picker labels a custom line instead of crashing", () => {
    mockOrder = order([LISTED, CUSTOM], {
      status: "OUT_FOR_DELIVERY",
      editWindow: { editable: false, editableUntil: null, closedReason: "DISPATCHED" },
      routeRun: { status: "IN_PROGRESS" },
    });
    renderWithProviders(<BuyerOrderDetailPage />);
    fireEvent.click(screen.getByRole("button", { name: /request a change/i }));
    fireEvent.click(screen.getByRole("button", { name: "Change a quantity" }));
    expect(screen.getByRole("option", { name: "Delivery surcharge (qty 1)" })).toBeInTheDocument();
    expect(screen.getByRole("option", { name: "Sample Cola 12oz (qty 2)" })).toBeInTheDocument();
  });
});

describe("BuyerOrderDetailPage — composed line sub-lines (#2717 M3)", () => {
  const COMPONENTS = [
    {
      componentProductId: "c1",
      name: "Almond",
      qty: 12,
      unitSku: "ALM-1",
      unitBarcode: "012345678905",
      barcodeSymbology: "UPC_A",
      displayUnitPrice4: 0.63,
      position: 0,
    },
    {
      componentProductId: "c2",
      name: "Oat",
      qty: 12,
      unitSku: "OAT-1",
      unitBarcode: null,
      barcodeSymbology: null,
      displayUnitPrice4: null,
      position: 1,
    },
  ];
  const COMPOSED = { ...LISTED, id: "li-c", components: COMPONENTS };

  it("shows one shared sub-line per component under the composed line only", () => {
    mockOrder = order([COMPOSED, { ...LISTED, id: "li-p", productId: "p-2" }]);
    renderWithProviders(<BuyerOrderDetailPage />);
    const subs = screen.getAllByTestId("line-component-sub-line");
    expect(subs).toHaveLength(2);
    expect(subs.map((n) => n.textContent)).toEqual(
      COMPONENTS.map((c) =>
        componentSubLineText({
          name: c.name,
          qty: c.qty,
          unitSku: c.unitSku,
          unitBarcode: c.unitBarcode,
          displayUnitPrice4: c.displayUnitPrice4,
        }),
      ),
    );
    const lists = screen.getAllByTestId("line-components");
    expect(lists).toHaveLength(1);
    const rows = screen.getAllByRole("row");
    const plainRow = rows.find(
      (r) => r.textContent?.includes("Sample Cola 12oz") && !r.contains(lists[0]),
    );
    expect(plainRow).toBeDefined();
    expect(plainRow!.querySelector('[data-testid="line-components"]')).toBeNull();
  });

  it("renders no sub-lines in edit mode (display-only)", () => {
    mockOrder = order([COMPOSED]);
    renderWithProviders(<BuyerOrderDetailPage />);
    fireEvent.click(screen.getByRole("button", { name: /edit items/i }));
    expect(screen.queryByTestId("line-component-sub-line")).toBeNull();
    expect(screen.queryByTestId("line-components")).toBeNull();
  });

  it("uses the shared ComponentSubLines and has no second text rendering", () => {
    const src = readFileSync(join(__dirname, "page.tsx"), "utf8");
    expect(src).toMatch(
      /import\s*\{\s*ComponentSubLines\s*\}\s*from\s*"@\/components\/ComponentSubLines"/,
    );
    expect(src).not.toMatch(/componentSubLineText/);
  });
});
