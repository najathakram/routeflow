import * as React from "react";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { Providers } from "@/app/providers";
import { seedSession } from "@/test-utils/session";
import OrderDetailPage from "./page";

// #2406 — order-edit host: the edit-mode Returns section folds an inline return into the SAME
// PATCH /orders/:id/items write. Modeled on page.selling-restricted.test.tsx's transport-level
// mocking (apiClient.get/patch/post), so the real hooks (useOrder, useUpdateOrderItems,
// useHasAddon, useReturns…) all run for real against a mocked HTTP boundary.
const toast = jest.fn();
const get = jest.fn();
const patch = jest.fn();
const post = jest.fn();
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
  useToast: () => ({ toast }),
}));
jest.mock("@/lib/api-client", () => ({
  ...jest.requireActual("@/lib/api-client"),
  apiClient: {
    get: (...a: unknown[]) => get(...a),
    patch: (...a: unknown[]) => patch(...a),
    post: (...a: unknown[]) => post(...a),
    delete: jest.fn(),
  },
}));

const order = {
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

beforeEach(() => {
  jest.clearAllMocks();
  seedSession("OPERATOR"); // B1134: the action bar is staff-only
  get.mockImplementation((url: string) => {
    if (url === "/orders/o1") return Promise.resolve({ data: order });
    if (url === "/tenants/me/addons")
      return Promise.resolve({ data: { addons: ["orders_inline_returns"] } });
    if (url === "/returns")
      return Promise.resolve({
        data: { data: [], meta: { total: 0, page: 1, limit: 50, totalPages: 0 } },
      });
    if (url === "/credit-notes")
      return Promise.resolve({
        data: { data: [], meta: { total: 0, page: 1, limit: 100, totalPages: 0 } },
      });
    // Everything else this page happens to fetch on mount (customer prices, margin config,
    // tracked categories…) is array-shaped or absent — never paginated.
    return Promise.resolve({ data: [] });
  });
  patch.mockResolvedValue({ data: { ...order, lineItems: order.lineItems } });
});

async function enterEditModeAndOpenReturns({ draft = false } = {}) {
  render(
    <Providers>
      <OrderDetailPage />
    </Providers>,
  );
  // A DRAFT auto-enters edit mode (page.tsx draftAutoEntered) — there is no Edit Items click.
  if (!draft) fireEvent.click(await screen.findByRole("button", { name: /edit items/i }));
  fireEvent.click(await screen.findByRole("button", { name: /^returns$/i }));
  // The line hydrates from the order's own line items (entryOrderId = order.id) — "Widget"
  // also appears in the page's own editable Line Items list above, so wait for TWO matches
  // rather than a single (ambiguous) one.
  await waitFor(() => expect(screen.getAllByText("Widget").length).toBeGreaterThanOrEqual(2));
  fireEvent.change(screen.getByLabelText(/qty \(pieces\)/i), { target: { value: "3" } });
  fireEvent.change(screen.getByLabelText(/^reason$/i), { target: { value: "DAMAGED" } });
}

describe("order detail edit mode — Returns section (#2406)", () => {
  it("addon off ⇒ no Returns section in edit mode", async () => {
    get.mockImplementation((url: string) => {
      if (url === "/orders/o1") return Promise.resolve({ data: order });
      if (url === "/tenants/me/addons") return Promise.resolve({ data: { addons: [] } });
      if (url === "/returns")
        return Promise.resolve({
          data: { data: [], meta: { total: 0, page: 1, limit: 50, totalPages: 0 } },
        });
      if (url === "/credit-notes")
        return Promise.resolve({
          data: { data: [], meta: { total: 0, page: 1, limit: 100, totalPages: 0 } },
        });
      return Promise.resolve({ data: [] });
    });
    render(
      <Providers>
        <OrderDetailPage />
      </Providers>,
    );
    fireEvent.click(await screen.findByRole("button", { name: /edit items/i }));
    await screen.findByRole("button", { name: /^save changes$/i });
    expect(screen.queryByRole("button", { name: /^returns$/i })).not.toBeInTheDocument();
  });

  it("a quoted return is saved via PATCH .../items as inlineReturn, without customerId/orderId", async () => {
    await enterEditModeAndOpenReturns();

    post.mockResolvedValueOnce({
      data: {
        chunks: [],
        subtotal: 0,
        taxAmount: 0,
        categoryTax: 0,
        total: 0,
        productBreakdown: {},
      },
    });
    fireEvent.click(screen.getByRole("button", { name: /get quote/i }));
    await waitFor(() =>
      expect(post).toHaveBeenCalledWith("/returns/inline/quote", expect.anything()),
    );

    fireEvent.click(screen.getByRole("button", { name: /^save changes$/i }));
    await waitFor(() => expect(patch).toHaveBeenCalledTimes(1));
    const [, body] = patch.mock.calls[0];
    expect(body.inlineReturn).toBeDefined();
    expect(body.inlineReturn.items).toEqual([{ productId: "p1", qty: 1, boxes: 0, pieces: 3 }]);
    expect(body.inlineReturn.reason).toBe("DAMAGED");
    expect(body.inlineReturn).not.toHaveProperty("customerId");
    expect(body.inlineReturn).not.toHaveProperty("orderId");
  });

  it("a refusal (4xx) keeps edit mode open and shows the message near the Returns section", async () => {
    await enterEditModeAndOpenReturns();
    post.mockResolvedValueOnce({
      data: {
        chunks: [],
        subtotal: 0,
        taxAmount: 0,
        categoryTax: 0,
        total: 0,
        productBreakdown: {},
      },
    });
    fireEvent.click(screen.getByRole("button", { name: /get quote/i }));
    await waitFor(() =>
      expect(post).toHaveBeenCalledWith("/returns/inline/quote", expect.anything()),
    );

    patch.mockRejectedValueOnce(
      Object.assign(new Error("Request failed"), {
        response: { status: 409, data: { message: "returnKey already used" } },
      }),
    );
    fireEvent.click(screen.getByRole("button", { name: /^save changes$/i }));

    await screen.findByTestId("order-return-refusal");
    expect(screen.getByTestId("order-return-refusal")).toHaveTextContent("returnKey already used");
    // Edit mode is still open — the Save button (and the Returns section) are still on screen.
    expect(screen.getByRole("button", { name: /^save changes$/i })).toBeInTheDocument();
  });

  it("a DRAFT's Publish Order carries the return too (never silently dropped)", async () => {
    const draft = { ...order, status: "DRAFT" };
    const base = get.getMockImplementation()!;
    get.mockImplementation((url: string) =>
      url === "/orders/o1" ? Promise.resolve({ data: draft }) : base(url),
    );
    patch.mockResolvedValue({ data: draft });
    await enterEditModeAndOpenReturns({ draft: true });
    // SA-484i: a return rides the save only once quoted.
    post.mockResolvedValueOnce({
      data: {
        chunks: [],
        subtotal: 0,
        taxAmount: 0,
        categoryTax: 0,
        total: 0,
        productBreakdown: {},
      },
    });
    fireEvent.click(screen.getByRole("button", { name: /get quote/i }));
    await waitFor(() =>
      expect(post).toHaveBeenCalledWith("/returns/inline/quote", expect.anything()),
    );
    await screen.findByRole("button", { name: /^back$/i }); // the quote step is showing

    fireEvent.click(await screen.findByRole("button", { name: /publish order/i }));
    await waitFor(() => expect(patch).toHaveBeenCalledWith("/orders/o1/items", expect.anything()));
    const [, body] = patch.mock.calls.find(([url]) => url === "/orders/o1/items")!;
    expect(body.inlineReturn).toBeDefined();
    expect(body.inlineReturn.reason).toBe("DAMAGED");
    expect(body.inlineReturn).not.toHaveProperty("customerId");
    expect(body.inlineReturn).not.toHaveProperty("orderId");
  });
});
