import * as React from "react";
import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { ToastProvider } from "@routeflow/ui/web";
import { computeLineSubtotal } from "@routeflow/pricing";
import ShopPage from "../shop/page";
import BuyerCartPage from "./page";

/**
 * Row 531 (P0), the whole buyer flow through the REAL shop page, the REAL cart hook (localStorage)
 * and the REAL cart page: Add a 12/box product, type 2 in the stepper, open the cart. The row, the
 * subtotal and the checkout payload must all describe the same quantity.
 *
 * Before the fix the stepper rewrote only `qty` (2) and left `boxes: 1`, so the cart priced the
 * split ($15.60 for one box) while the row said "2", and checkout sent {qty 2, boxes 1, pieces 0}
 * for the server to store as 12 units. Now the stepper counts the line's selling unit (Case):
 * typing 2 is 2 Cases, 24 pieces, $31.20; the Each toggle switches the stepper and its label.
 */

const BOX_PRICE = 15.6;
const mockProduct = {
  id: "p1",
  name: "Widget",
  description: null,
  sku: "W-1",
  barcode: null,
  unit: "each",
  category: null,
  buyerPrice: BOX_PRICE,
  unitsPerBox: 12,
  thumbnailUrl: null,
  imageKeys: [],
  imageUrls: [],
  isFeatured: false,
  isNew: false,
  isDeal: false,
  inStock: true,
  stockStatus: "IN_STOCK",
  stockLeft: null,
};

const mutateAsync = jest.fn();
const push = jest.fn();
/** When true the catalog also offers a second product, so a two-line cart resolves both lines. */
let mockSecondProduct = false;

jest.mock("next/navigation", () => ({
  useParams: () => ({ seller: "acme" }),
  useRouter: () => ({ push }),
}));
jest.mock("@/lib/buyer-auth-context", () => ({
  useBuyerAuth: () => ({
    buyer: { id: "b1" },
    activeSeller: { linkId: "l1", slug: "acme", tenant: { slug: "acme", name: "Acme" } },
    sellers: [],
    isLoading: false,
  }),
}));
jest.mock("@/lib/api/buyer-capabilities", () => ({
  useBuyerSellerCapabilities: () => ({ data: undefined, isLoading: false, isError: false }),
}));
jest.mock("@/lib/api/buyer", () => {
  const page = () => ({
    data: mockSecondProduct
      ? [mockProduct, { ...mockProduct, id: "p2", name: "Widget p2" }]
      : [mockProduct],
    meta: { page: 1, limit: 24, total: 1, totalPages: 1 },
  });
  const none = { data: undefined };
  const mutation = { mutate: jest.fn(), mutateAsync: jest.fn(), isPending: false };
  return {
    useBuyerProducts: () => ({
      data: page(),
      isLoading: false,
      isError: false,
      isSuccess: true,
    }),
    useBuyerCatalogCounts: () => none,
    useBuyerPromotions: () => ({ data: [] }),
    useBuyerReplenishment: () => none,
    useBuyerFavorites: () => ({ data: [] }),
    useBuyerAddFavorite: () => mutation,
    useBuyerRemoveFavorite: () => mutation,
    useBuyerStockAlerts: () => ({ data: { productIds: [] } }),
    useSubscribeStockAlert: () => mutation,
    useUnsubscribeStockAlert: () => mutation,
    useBuyerShelf: () => none,
    useBuyerCreateOrder: () => ({ mutateAsync, isPending: false }),
    useBuyerActiveOrder: () => none,
    toPromotionRules: () => [],
  };
});

function wrap(ui: React.ReactElement) {
  const qc = new QueryClient();
  return render(
    <QueryClientProvider client={qc}>
      <ToastProvider>{ui}</ToastProvider>
    </QueryClientProvider>,
  );
}

function typeInto(field: HTMLElement, value: string) {
  fireEvent.change(field, { target: { value } });
  fireEvent.blur(field);
}

beforeEach(() => {
  mockSecondProduct = false;
  mockProduct.unitsPerBox = 12;
  localStorage.clear();
  mutateAsync.mockReset().mockResolvedValue({ id: "o1", orderNumber: "ORD-1" });
  push.mockReset();
});

describe("buyer shop to cart to checkout keeps the quantity honest", () => {
  // UI-agnostic invariant (also the red on master): whatever the stepper means by "2", the payload
  // checkout sends must agree with itself, and the cart's total must price exactly that payload.
  it.each(["1", "2", "5", "11", "12", "13", "24", "25"])(
    "typing %s in the shop stepper sends a payload where qty === boxes*12 + pieces",
    async (typed) => {
      const shop = wrap(<ShopPage />);
      const tile = screen.getByTestId("product-tile");
      fireEvent.click(within(tile).getByRole("button", { name: /^add$/i }));
      typeInto(within(tile).getByRole("textbox", { name: "Quantity" }), typed);
      shop.unmount();

      wrap(<BuyerCartPage />);
      // what the cart told the buyer they will pay, read BEFORE the order clears it
      const shownTotal = screen.getByText("Estimated Total").nextElementSibling!.textContent;
      await act(async () => {
        fireEvent.click(screen.getByRole("button", { name: /place order/i }));
      });
      const [line] = mutateAsync.mock.calls[0][0].items;
      expect(line.qty).toBe(line.boxes * 12 + line.pieces);
      const billed = computeLineSubtotal({
        unitPrice: BOX_PRICE,
        qty: line.qty,
        boxes: line.boxes,
        pieces: line.pieces,
        unitsPerBox: 12,
      });
      const money = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" });
      expect(shownTotal).toBe(money.format(billed));
    },
  );

  it("Add, type 2: the row says 2 Cases (24 ea), the subtotal prices 2 Cases, the payload is {24, 2, 0}", async () => {
    const shop = wrap(<ShopPage />);
    const tile = screen.getByTestId("product-tile");
    fireEvent.click(within(tile).getByRole("button", { name: /^add$/i }));

    // Add writes one Case.
    expect(within(tile).getByTestId("cart-line-qty-text")).toHaveTextContent("1 Case (12 ea)");
    typeInto(within(tile).getByRole("textbox", { name: "Quantity" }), "2");
    expect(within(tile).getByTestId("cart-line-qty-text")).toHaveTextContent("2 Cases (24 ea)");
    expect(within(tile).getByRole("textbox", { name: "Quantity" })).toHaveValue("2");
    shop.unmount();

    wrap(<BuyerCartPage />);
    const row = screen.getAllByRole("row")[1];
    expect(within(row).getByTestId("cart-line-qty-text")).toHaveTextContent("2 Cases (24 ea)");
    expect(within(row).getByRole("spinbutton")).toHaveValue(2);
    // the line subtotal and the order total both price exactly 2 Cases
    expect(within(row).getByText("$31.20")).toBeInTheDocument();
    expect(screen.getAllByText("$31.20").length).toBeGreaterThanOrEqual(2);
    expect(screen.queryByText("$15.60", { selector: "td span, td" })).toBeInTheDocument(); // the unit (Case) price

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /place order/i }));
    });
    expect(mutateAsync).toHaveBeenCalledTimes(1);
    const payload = mutateAsync.mock.calls[0][0];
    expect(payload.items).toEqual([{ productId: "p1", qty: 24, boxes: 2, pieces: 0 }]);
  });

  it("Each: type 2 and the row, the subtotal and the payload all say 2 pieces", async () => {
    const shop = wrap(<ShopPage />);
    const tile = screen.getByTestId("product-tile");
    fireEvent.click(within(tile).getByRole("button", { name: /^add$/i }));
    fireEvent.click(within(tile).getByRole("button", { name: /order widget by the each/i }));
    typeInto(within(tile).getByRole("textbox", { name: "Quantity" }), "2");
    expect(within(tile).getByTestId("cart-line-qty-text")).toHaveTextContent("2 Each");
    shop.unmount();

    wrap(<BuyerCartPage />);
    const row = screen.getAllByRole("row")[1];
    expect(within(row).getByTestId("cart-line-qty-text")).toHaveTextContent("2 Each");
    expect(within(row).getByText("$2.60")).toBeInTheDocument(); // 2 of 12 of the $15.60 box
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /place order/i }));
    });
    expect(mutateAsync.mock.calls[0][0].items).toEqual([
      { productId: "p1", qty: 2, boxes: 0, pieces: 2 },
    ]);
  });

  it("the cart row's stepper walks Cases with no drift: + + - reads 2 Cases and never snaps back", () => {
    localStorage.setItem(
      "buyerCart_b1_acme",
      JSON.stringify({
        items: [
          {
            productId: "p1",
            name: "Widget",
            unit: "each",
            unitsPerBox: 12,
            qty: 12,
            boxes: 1,
            pieces: 0,
          },
        ],
      }),
    );
    wrap(<BuyerCartPage />);
    const row = () => screen.getAllByRole("row")[1];
    fireEvent.click(within(row()).getByRole("button", { name: "Increase Widget" }));
    fireEvent.click(within(row()).getByRole("button", { name: "Increase Widget" }));
    fireEvent.click(within(row()).getByRole("button", { name: "Decrease Widget" }));
    expect(within(row()).getByTestId("cart-line-qty-text")).toHaveTextContent("2 Cases (24 ea)");
    expect(within(row()).getByRole("spinbutton")).toHaveValue(2);
    expect(within(row()).getByText("$31.20")).toBeInTheDocument();
  });

  it("a cart stored by the buggy client (qty 2 / boxes 1) is repaired on load: 2 Each at $2.60", async () => {
    localStorage.setItem(
      "buyerCart_b1_acme",
      JSON.stringify({
        items: [
          {
            productId: "p1",
            name: "Widget",
            unit: "each",
            unitsPerBox: 12,
            qty: 2,
            boxes: 1,
            pieces: 0,
          },
        ],
      }),
    );
    wrap(<BuyerCartPage />);
    const row = screen.getAllByRole("row")[1];
    expect(within(row).getByTestId("cart-line-qty-text")).toHaveTextContent("2 Each");
    expect(within(row).getByText("$2.60")).toBeInTheDocument();
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /place order/i }));
    });
    expect(mutateAsync.mock.calls[0][0].items).toEqual([
      { productId: "p1", qty: 2, boxes: 0, pieces: 2 },
    ]);
  });

  it("a line stored without a pack size (an older dashboard Add) is completed from the catalog as Cases", async () => {
    localStorage.setItem(
      "buyerCart_b1_acme",
      JSON.stringify({ items: [{ productId: "p1", name: "Widget", unit: "each", qty: 1 }] }),
    );
    wrap(<BuyerCartPage />);
    const row = screen.getAllByRole("row")[1];
    expect(within(row).getByTestId("cart-line-qty-text")).toHaveTextContent("1 Case (12 ea)");
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /place order/i }));
    });
    expect(mutateAsync.mock.calls[0][0].items).toEqual([
      { productId: "p1", qty: 12, boxes: 1, pieces: 0 },
    ]);
  });
});

describe("R1: a stored pack that differs from the catalog's (a repack) is rebuilt, never 400'd forever", () => {
  const line = (over: Record<string, unknown>) => ({
    productId: "p1",
    name: "Widget",
    unit: "each",
    unitsPerBox: 12,
    ...over,
  });

  it("a Case line keeps its CASE COUNT: 2 Cases of 12 meet a 6-pack catalog and read 2 Cases (12 ea) at the Case price", async () => {
    mockProduct.unitsPerBox = 6;
    localStorage.setItem(
      "buyerCart_b1_acme",
      JSON.stringify({ items: [line({ qty: 24, boxes: 2, pieces: 0, sellBy: "CASE" })] }),
    );
    wrap(<BuyerCartPage />);
    const row = screen.getAllByRole("row")[1];
    expect(within(row).getByTestId("cart-line-qty-text")).toHaveTextContent("2 Cases (12 ea)");
    // priced with the CATALOG pack: 2 Cases x $15.60
    expect(within(row).getByText("$31.20")).toBeInTheDocument();
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /place order/i }));
    });
    expect(mutateAsync.mock.calls[0][0].items).toEqual([
      { productId: "p1", qty: 12, boxes: 2, pieces: 0 },
    ]);
  });

  it("an Each line keeps its PIECES: 14 each meet a 6-pack catalog and read 2 Cases + 2 ea, payload {14, 2, 2}", async () => {
    mockProduct.unitsPerBox = 6;
    localStorage.setItem(
      "buyerCart_b1_acme",
      JSON.stringify({ items: [line({ qty: 14, boxes: 1, pieces: 2, sellBy: "EACH" })] }),
    );
    wrap(<BuyerCartPage />);
    const row = screen.getAllByRole("row")[1];
    expect(within(row).getByTestId("cart-line-qty-text")).toHaveTextContent(
      "14 Each (2 Cases + 2 ea)",
    );
    // 2 boxes + 2 of 6 of a $15.60 box = $36.40
    expect(within(row).getByText("$36.40")).toBeInTheDocument();
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /place order/i }));
    });
    expect(mutateAsync.mock.calls[0][0].items).toEqual([
      { productId: "p1", qty: 14, boxes: 2, pieces: 2 },
    ]);
  });

  it("the buyer is told: a repacked line raises the corrected-quantity banner", () => {
    mockProduct.unitsPerBox = 6;
    localStorage.setItem(
      "buyerCart_b1_acme",
      JSON.stringify({ items: [line({ qty: 24, boxes: 2, pieces: 0, sellBy: "CASE" })] }),
    );
    wrap(<BuyerCartPage />);
    expect(screen.getByTestId("cart-corrected-notice")).toHaveTextContent(
      "We corrected the quantity on 1 item. Please review.",
    );
  });
});

describe("R2: a silently repriced cart is announced once (qty wins; the buyer reviews)", () => {
  const stale = (id: string) => ({
    productId: id,
    name: `Widget ${id}`,
    unit: "each",
    unitsPerBox: 12,
    qty: 2,
    boxes: 1,
    pieces: 0,
  });

  it("a stored qty 2 / boxes 1 line shows the one-time banner, calm (status, not alert)", () => {
    localStorage.setItem("buyerCart_b1_acme", JSON.stringify({ items: [stale("p1")] }));
    wrap(<BuyerCartPage />);
    const notice = screen.getByTestId("cart-corrected-notice");
    expect(notice).toHaveTextContent("We corrected the quantity on 1 item. Please review.");
    expect(notice).toHaveAttribute("role", "status");
    expect(notice.className).not.toMatch(/danger|red/);
  });

  it("counts every corrected line, with the plural", () => {
    mockSecondProduct = true;
    localStorage.setItem(
      "buyerCart_b1_acme",
      JSON.stringify({ items: [stale("p1"), stale("p2")] }),
    );
    wrap(<BuyerCartPage />);
    expect(screen.getByTestId("cart-corrected-notice")).toHaveTextContent(
      "We corrected the quantity on 2 items. Please review.",
    );
  });

  it("OK dismisses it for good: it does not come back when the cart is opened again", () => {
    localStorage.setItem("buyerCart_b1_acme", JSON.stringify({ items: [stale("p1")] }));
    const first = wrap(<BuyerCartPage />);
    fireEvent.click(
      within(screen.getByTestId("cart-corrected-notice")).getByRole("button", { name: "OK" }),
    );
    expect(screen.queryByTestId("cart-corrected-notice")).toBeNull();
    first.unmount();
    wrap(<BuyerCartPage />);
    expect(screen.queryByTestId("cart-corrected-notice")).toBeNull();
    // the repaired line itself is still there, unchanged
    expect(screen.getByTestId("cart-line-qty-text")).toHaveTextContent("2 Each");
  });

  it("a cart that was never contradicted shows no banner", () => {
    localStorage.setItem(
      "buyerCart_b1_acme",
      JSON.stringify({
        items: [{ ...stale("p1"), qty: 24, boxes: 2, pieces: 0, sellBy: "CASE" }],
      }),
    );
    wrap(<BuyerCartPage />);
    expect(screen.queryByTestId("cart-corrected-notice")).toBeNull();
  });

  it("an older dashboard Add completed from the catalog is NOT a correction (no banner)", () => {
    localStorage.setItem(
      "buyerCart_b1_acme",
      JSON.stringify({ items: [{ productId: "p1", name: "Widget", unit: "each", qty: 1 }] }),
    );
    wrap(<BuyerCartPage />);
    expect(screen.queryByTestId("cart-corrected-notice")).toBeNull();
    expect(screen.getByTestId("cart-line-qty-text")).toHaveTextContent("1 Case (12 ea)");
  });
});
