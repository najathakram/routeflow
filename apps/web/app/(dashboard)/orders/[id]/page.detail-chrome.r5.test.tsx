import * as React from "react";
import { render, screen, fireEvent, within } from "@testing-library/react";
import { Providers } from "@/app/providers";
import { seedSession } from "@/test-utils/session";
import OrderDetailPage from "./page";

/**
 * apple-ux r5, Order detail chrome. jsdom has no layout, so these pin the class tokens the CSS keys off; the measured
 * result (one total, one back control, per width) is the host-run capture's job.
 *  - Q20: "Order total" is said ONCE per width. Below lg the Summary card is stacked under the lines (and the customer
 *    card), so the line-items footer carries the total there; from lg the Summary sits beside the lines and carries it.
 *  - Q23: ONE back control. The dashboard top bar already shows a back arrow on every sub-page, so the page has no
 *    second "← Orders" link of its own.
 */
const get = jest.fn();
jest.mock("next/navigation", () => ({
  useParams: () => ({ id: "o1" }),
  useRouter: () => ({ push: jest.fn(), replace: jest.fn() }),
  usePathname: () => "/orders/o1",
  useSearchParams: () => new URLSearchParams(),
}));
jest.mock("@/components/ReAuthProvider", () => ({
  ReAuthProvider: ({ children }: any) => children,
}));
jest.mock("@/components/PlanGateNotice", () => ({ PlanGateNotice: () => null }));
jest.mock("@routeflow/ui/web", () => ({
  ...jest.requireActual("@routeflow/ui/web"),
  useToast: () => ({ toast: jest.fn() }),
}));
jest.mock("@/lib/api-client", () => ({
  ...jest.requireActual("@/lib/api-client"),
  apiClient: {
    get: (...a: unknown[]) => get(...a),
    patch: jest.fn(),
    post: jest.fn(),
    delete: jest.fn(),
  },
}));

const baseOrder = {
  id: "o1",
  orderNumber: "ORD-1",
  customerId: "c1",
  customer: { id: "c1", businessName: "Acme Retail" },
  status: "PENDING",
  fulfillPath: "ROUTE",
  urgent: false,
  subtotal: 20,
  tax: 0,
  total: 20,
  lineItems: [
    {
      id: "li-1",
      productId: "p1",
      product: { id: "p1", name: "Widget", unit: "each", unitsPerBox: null },
      qty: 10,
      unitPrice: 2,
      status: "CONFIRMED",
    },
  ],
};

async function openDetail(addons: string[] = []) {
  get.mockImplementation((url: string) => {
    if (url === "/orders/o1") return Promise.resolve({ data: baseOrder });
    if (url === "/tenants/me/addons") return Promise.resolve({ data: { addons } });
    return Promise.resolve({ data: [] });
  });
  render(
    <Providers>
      <OrderDetailPage />
    </Providers>,
  );
  await screen.findByRole("heading", { name: "ORD-1" });
}

beforeEach(() => {
  jest.clearAllMocks();
  seedSession("OPERATOR");
});

const tokens = (el: Element | null | undefined) =>
  (el?.getAttribute("class") ?? "").split(/\s+/).filter(Boolean);

describe("Order detail says Order Total once per width (Q20)", () => {
  it("the line-items footer total is for below lg only", async () => {
    await openDetail();
    const footer = screen
      .getAllByText("Order total")
      .map((e) => e.closest("tr"))
      .find(Boolean);
    expect(tokens(footer)).toContain("lg:hidden");
  });

  it("the Summary card total is hidden below lg (so the pair is never both on screen)", async () => {
    await openDetail();
    const row =
      screen
        .getAllByText("Order total")
        .map((e) => e.closest("div"))
        .find((d) => d?.tagName === "DIV" && tokens(d).includes("max-lg:hidden")) ?? null;
    expect(tokens(row)).toContain("max-lg:hidden");
  });

  it("edit mode keeps the Summary's Saved total at every width (the footer is not rendered then)", async () => {
    await openDetail();
    fireEvent.click(screen.getByRole("button", { name: /edit items/i }));
    const row = (await screen.findByText("Saved total")).closest("div");
    expect(tokens(row)).not.toContain("max-lg:hidden");
    expect(screen.queryByText("Order total")).toBeNull();
  });
});

describe("Order detail has one back control (Q23)", () => {
  it("renders no in-page Orders link: the top bar's back arrow is the one", async () => {
    await openDetail();
    expect(screen.queryByRole("link", { name: /^orders$/i })).toBeNull();
    // the customer card's own links are untouched
    expect(within(document.body).getByRole("link", { name: /view profile/i })).toBeInTheDocument();
  });
});
