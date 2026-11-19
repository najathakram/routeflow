import * as React from "react";
import { render, screen, within } from "@testing-library/react";
import BuyerCartPage from "./page";

/**
 * B304 / SA-1172: the cart's money rows are the server's own quote (what create() will bill), labelled for what they
 * cover; without one the page says plainly that tax and fees are added, and Place order never waits on the quote.
 * Fixtures are placeholders (acme).
 */
const QUOTE = { subtotal: 31.2, tax: 2.57, levy: 36, total: 69.77, taxExempt: false };
let quoteResult: { quote: typeof QUOTE | undefined; busy: boolean };
let activeOrder: unknown;
const quoteHook = jest.fn();

const mockCart = {
  items: [
    { productId: "p1", qty: 2, name: "Acme 12-pack", unitPrice: 15.6 },
    { productId: "p2", qty: 1, name: "Acme mystery box", unitPrice: 0 },
  ],
  itemCount: 2,
  totalQty: 3,
  clearCart: jest.fn(),
  removeItem: jest.fn(),
  adoptCatalogPacks: jest.fn(),
};
const mockProducts = {
  isSuccess: true,
  data: {
    data: [{ id: "p1", name: "Acme 12-pack", buyerPrice: 15.6, category: null, unitsPerBox: null }],
  },
};
const mockRouter = { push: jest.fn() };

jest.mock("next/navigation", () => ({
  useParams: () => ({ seller: "acme" }),
  useRouter: () => mockRouter,
}));
jest.mock("@/lib/buyer-auth-context", () => ({
  useBuyerAuth: () => ({
    buyer: { id: "b1" },
    activeSeller: { linkId: "l1", tenant: { slug: "acme" } },
    sellers: [{ linkId: "l1", tenant: { slug: "acme" } }],
    isLoading: false,
  }),
}));
jest.mock("@/lib/api/buyer-capabilities", () => ({
  useBuyerSellerCapabilities: () => ({ data: undefined, isLoading: false, isError: false }),
}));
jest.mock("@/lib/buyer-cart", () => ({ useBuyerCart: () => mockCart }));
jest.mock("@/lib/api/buyer", () => ({
  useBuyerCartQuote: (...args: unknown[]) => {
    quoteHook(...args);
    return quoteResult;
  },
  useBuyerProducts: () => mockProducts,
  useBuyerCreateOrder: () => ({ mutateAsync: jest.fn(), isPending: false }),
  useBuyerActiveOrder: () => ({
    data: activeOrder,
    isSuccess: true,
    isError: false,
    refetch: jest.fn(),
  }),
  useBuyerPromotions: () => ({ data: [] }),
  toPromotionRules: () => [],
}));

beforeEach(() => {
  quoteHook.mockClear();
  quoteResult = { quote: QUOTE, busy: false };
  activeOrder = "";
});

const text = (el: Element | null) => el?.textContent ?? "";
const valueOf = (label: string | RegExp) =>
  text(screen.getByText(label).nextElementSibling).replace(/[$,]/g, "");

describe("buyer cart summary shows the server's quote", () => {
  it("9: Subtotal, Tax, Other taxes and fees and Total all come from the quote", () => {
    render(<BuyerCartPage />);
    expect(valueOf(/^Subtotal \(/)).toBe("31.20");
    expect(valueOf("Tax")).toBe("2.57");
    expect(valueOf("Other taxes and fees")).toBe("36.00");
    expect(valueOf("Total")).toBe("69.77");
    expect(screen.queryByText(/calculated at checkout/i)).toBeNull();
    expect(screen.queryByText(/estimated total/i)).toBeNull();
  });

  it("17: the displayed rows add up to the displayed total", () => {
    render(<BuyerCartPage />);
    const sum =
      Number(valueOf(/^Subtotal \(/)) +
      Number(valueOf("Tax")) +
      Number(valueOf("Other taxes and fees"));
    expect(Math.round(sum * 100)).toBe(Math.round(Number(valueOf("Total")) * 100));
  });

  it("a levy of 0 shows no 'Other taxes and fees' row, and an exempt buyer reads Tax $0.00", () => {
    quoteResult = {
      quote: { subtotal: 31.2, tax: 0, levy: 0, total: 31.2, taxExempt: true },
      busy: false,
    };
    render(<BuyerCartPage />);
    expect(screen.queryByText("Other taxes and fees")).toBeNull();
    expect(valueOf("Tax")).toBe("0.00");
    expect(valueOf("Total")).toBe("31.20");
  });

  it("15: when the cart will fold into an open order the last row never reads a bare 'Total'", () => {
    activeOrder = { id: "o-old", orderNumber: "ORD-100", fulfillPath: "ROUTE" };
    render(<BuyerCartPage />);
    expect(screen.getByText("Total for these items")).toBeInTheDocument();
    expect(screen.queryByText("Total")).toBeNull();
    expect(valueOf("Total for these items")).toBe("69.77");
  });

  it("18: with no quote (pending, failed or throttled) the fallback shows and Place order stays enabled", () => {
    quoteResult = { quote: undefined, busy: false };
    render(<BuyerCartPage />);
    expect(screen.getByText("Any tax and fees are added to your order.")).toBeInTheDocument();
    expect(screen.queryByText("Tax")).toBeNull();
    expect(screen.queryByText("Total")).toBeNull();
    expect(screen.getByRole("button", { name: "Place order" })).toBeEnabled();
  });

  it("the unresolved note shows only with the fallback, in its new wording", () => {
    quoteResult = { quote: undefined, busy: false };
    const { unmount } = render(<BuyerCartPage />);
    expect(
      screen.getByText(
        "1 item isn't priced here and isn't in this total. Your seller will confirm its price when they review the order.",
      ),
    ).toBeInTheDocument();
    unmount();
    quoteResult = { quote: QUOTE, busy: false };
    render(<BuyerCartPage />);
    expect(screen.queryByText(/isn't priced here/i)).toBeNull();
  });

  it("14: the quote body is what the submit sends: every line, the unresolved one included", () => {
    render(<BuyerCartPage />);
    const [seller, items, , enabled] = quoteHook.mock.calls[0];
    expect(seller).toBe("acme");
    expect(items.map((i: { productId: string }) => i.productId)).toEqual(["p1", "p2"]);
    expect(enabled).toBe(true);
  });

  it("8 (a11y): one polite status line speaks the settled total; a loading quote stays, dimmed and busy", () => {
    const { container, rerender } = render(<BuyerCartPage />);
    const status = container.querySelector('[role="status"][aria-atomic="true"]');
    expect(status).toHaveTextContent("Total $69.77");
    expect(status).toHaveAttribute("aria-atomic", "true");
    quoteResult = { quote: QUOTE, busy: true };
    rerender(<BuyerCartPage />);
    expect(container.querySelector('[role="status"][aria-atomic="true"]')).toHaveTextContent("");
    expect(container.querySelector('[aria-busy="true"]')).not.toBeNull();
    expect(within(container).getByText("$69.77", { selector: "span" })).toBeInTheDocument();
  });
});
