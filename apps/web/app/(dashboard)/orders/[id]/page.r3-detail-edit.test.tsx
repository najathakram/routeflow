import * as React from "react";
import { render, screen, fireEvent, within } from "@testing-library/react";
import { Providers } from "@/app/providers";
import { seedSession } from "@/test-utils/session";
import OrderDetailPage from "./page";

/**
 * apple-ux r3 PR-C (rows 5, 6, 8, 9): Order detail + Edit Items.
 *  - the line's trash button has a name ("Remove <product>") and "Not available" is neutral until marked
 *  - while editing, the rail total is the SAVED total and the sticky Save bar carries the New total
 *  - invoice actions are held during an unsaved edit; Generate Invoice is secondary while PENDING
 *  - Cancel Order is an outline button with red text, not a filled red one
 * jsdom has no stylesheet, so style claims are pinned on the variant classes the Button emits.
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
  useToast: () => ({ toast: jest.fn(), dismiss: jest.fn() }),
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
      invoicedQty: 0,
      unitPrice: 2,
      subtotal: 20,
      status: "CONFIRMED",
    },
  ],
};

async function open(extra: Record<string, unknown> = {}) {
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
  await screen.findByRole("button", { name: /edit items/i });
}
async function openEdit(extra: Record<string, unknown> = {}) {
  await open(extra);
  fireEvent.click(screen.getByRole("button", { name: /edit items/i }));
  await screen.findByRole("button", { name: /^save changes$/i });
}

beforeEach(() => {
  jest.clearAllMocks();
  seedSession("OPERATOR");
});

describe("Row 5: Edit Items line actions (Q26 + F11)", () => {
  it("the trash button is named after its product", async () => {
    await openEdit();
    expect(screen.getByRole("button", { name: "Remove Widget" })).toBeInTheDocument();
  });
  it("the trash button keeps a 44px touch target", async () => {
    await openEdit();
    expect(screen.getByRole("button", { name: "Remove Widget" })).toHaveClass(
      "min-h-[44px]",
      "min-w-[44px]",
    );
  });
  it("'Not available' is neutral before anything is marked, like Substitute", async () => {
    await openEdit();
    const na = screen.getByRole("button", { name: "Not available" });
    expect(na).not.toHaveClass("text-danger");
    expect(na).toHaveClass("text-navy/70");
    expect(screen.getByRole("button", { name: "Substitute" })).toHaveClass("text-navy/70");
  });
  it("red appears only once a line is marked unavailable", async () => {
    await openEdit();
    fireEvent.click(screen.getByRole("button", { name: "Not available" }));
    expect(screen.getByText("Not available")).toHaveClass("text-danger");
    expect(screen.queryByRole("button", { name: "Not available" })).toBeNull();
  });
});

describe("Row 6: which total does Save commit? (Q25 + F06, Q24)", () => {
  it("the rail says 'Order total' when not editing", async () => {
    await open();
    expect(screen.getByText("Order total")).toBeInTheDocument();
    expect(screen.queryByText("Saved total")).toBeNull();
  });
  it("while editing the rail's figure is the 'Saved total'", async () => {
    await openEdit();
    expect(screen.getByText("Saved total")).toBeInTheDocument();
    expect(screen.queryByText("Order total")).toBeNull();
  });
  it("the sticky Save bar shows the New total beside Save Changes, and follows the edit", async () => {
    await openEdit();
    const bar = screen.getByTestId("edit-save-bar");
    const total = within(bar).getByTestId("edit-bar-total");
    expect(total).toHaveTextContent("New total");
    expect(total).toHaveTextContent("$20.00");
    fireEvent.change(screen.getByRole("spinbutton", { name: /qty/i }), { target: { value: "15" } });
    expect(within(bar).getByTestId("edit-bar-total")).toHaveTextContent("$30.00");
    expect(bar).toContainElement(screen.getByRole("button", { name: /^save changes$/i }));
  });
});

describe("Row 8 + 10: invoice actions (Q27, Q16)", () => {
  const generate = () => screen.getByRole("button", { name: /^Generate Invoice \(full order\)$/ });
  const split = () => screen.getByRole("button", { name: /^Split into invoice…$/ });

  it("while PENDING, Generate Invoice is a secondary button, not a second filled primary", async () => {
    await open();
    expect(generate()).not.toHaveClass("bg-accent-strong");
    expect(generate()).toHaveClass("border");
    expect(generate()).toBeEnabled();
  });
  it("once CONFIRMED it leads as the filled primary", async () => {
    await open({ status: "CONFIRMED" });
    expect(generate()).toHaveClass("bg-accent-strong");
    expect(generate()).toBeEnabled();
  });
  it("during an unsaved edit both invoice actions are held, with a visible reason", async () => {
    await open({ status: "CONFIRMED" });
    fireEvent.click(screen.getByRole("button", { name: /edit items/i }));
    await screen.findByRole("button", { name: /^save changes$/i });
    expect(generate()).toBeDisabled();
    expect(generate()).not.toHaveClass("bg-accent-strong");
    expect(split()).toBeDisabled();
    const reason = screen.getByText(/save your changes first/i);
    expect(reason).toBeVisible();
    expect(generate()).toHaveAccessibleDescription(reason.textContent!);
  });
  it("leaving the edit brings the invoice actions back", async () => {
    await open({ status: "CONFIRMED" });
    fireEvent.click(screen.getByRole("button", { name: /edit items/i }));
    await screen.findByRole("button", { name: /^save changes$/i });
    fireEvent.click(screen.getByRole("button", { name: /^cancel$/i }));
    expect(await screen.findByRole("button", { name: /edit items/i })).toBeInTheDocument();
    expect(generate()).toBeEnabled();
    expect(screen.queryByText(/save your changes first/i)).toBeNull();
  });
});

describe("Row 9: Cancel Order (Q15)", () => {
  it("is an outline button with red text, so Confirm Order is the only filled button", async () => {
    await open();
    const cancel = screen.getByRole("button", { name: /^cancel order$/i });
    expect(cancel).not.toHaveClass("bg-danger");
    expect(cancel).toHaveClass("text-danger", "border");
  });
});
