import * as React from "react";
import { render, screen, fireEvent, within } from "@testing-library/react";
import { Providers } from "@/app/providers";
import { seedSession } from "@/test-utils/session";
import OrderDetailPage from "./page";

/**
 * O2 (F11) + O7: in edit mode there is exactly ONE Save button, it sits in a sticky bar inside the
 * Line Items card (the old bottom-of-card row moved, nothing duplicated), and an invoiced order
 * says up front that saving marks the invoice for review. Harness: page.inline-return.test.tsx.
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

async function openEdit(extra: Record<string, unknown> = {}) {
  get.mockImplementation((url: string) => {
    if (url === "/orders/o1") return Promise.resolve({ data: { ...baseOrder, ...extra } });
    if (url === "/tenants/me/addons") return Promise.resolve({ data: { addons: [] } });
    return Promise.resolve({ data: [] });
  });
  render(
    <Providers>
      <OrderDetailPage />
    </Providers>,
  );
  fireEvent.click(await screen.findByRole("button", { name: /edit items/i }));
  await screen.findByRole("button", { name: /^save changes$/i });
}

beforeEach(() => {
  jest.clearAllMocks();
  seedSession("OPERATOR");
});

describe("order edit mode: one sticky Save bar (O2 / F11)", () => {
  it("has exactly one Save Changes button, and it is in the sticky bar inside the Line Items card", async () => {
    await openEdit();
    const saves = screen.getAllByRole("button", { name: /save changes/i });
    expect(saves).toHaveLength(1);
    const bar = screen.getByTestId("edit-save-bar");
    expect(bar).toContainElement(saves[0]);
    expect(bar).toHaveClass("sticky", "-bottom-24");
    expect(within(bar).getByRole("button", { name: /^cancel$/i })).toBeInTheDocument();
    const card = screen.getByRole("heading", { name: /line items/i }).closest("div.rounded-lg")!;
    expect(card).toContainElement(bar);
  });

  it("drops the duplicate 'save on Save Changes' hint from the header", async () => {
    await openEdit();
    expect(screen.queryByText(/prices & quantities save on/i)).toBeNull();
  });
});

describe("order edit mode: invoiced-order notice (O7)", () => {
  it("shows the inline notice above the lines when the order has a live invoice", async () => {
    await openEdit({
      invoices: [{ id: "i1", invoiceNumber: "INV-2026-0003", status: "DRAFT", total: 20 }],
    });
    const notice = screen.getByTestId("invoiced-edit-notice");
    expect(notice).toHaveTextContent("INV-2026-0003");
    expect(notice).toHaveTextContent(/marks the invoice for review/i);
    // Above the first line.
    const widget = screen.getAllByText("Widget")[0];
    expect(notice.compareDocumentPosition(widget) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it("shows nothing on an order with no invoice", async () => {
    await openEdit({ invoices: [] });
    expect(screen.queryByTestId("invoiced-edit-notice")).toBeNull();
  });
});
