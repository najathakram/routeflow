import * as React from "react";
import { render, screen, fireEvent, within, act, waitFor } from "@testing-library/react";
import { Providers } from "@/app/providers";
import { seedSession } from "@/test-utils/session";
import OrderDetailPage from "./page";

/** Row 604 F24 / row 699a: Back (or a tab close) with unsaved Edit Items edits asks before dropping them. */
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

const qty = () => screen.getByRole("spinbutton", { name: /qty/i }) as HTMLInputElement;
const pressBack = () => act(() => void window.dispatchEvent(new PopStateEvent("popstate")));

describe("Edit Items leave guard (F24)", () => {
  it("Back with an unsaved edit stays on the order and asks, Keep editing focused", async () => {
    await openEdit();
    fireEvent.change(qty(), { target: { value: "7" } });
    pressBack();
    const dialog = await screen.findByRole("dialog", { name: /discard your changes/i });
    expect(within(dialog).getByRole("button", { name: /keep editing/i })).toHaveFocus();
    fireEvent.click(within(dialog).getByRole("button", { name: /keep editing/i }));
    expect(qty()).toHaveValue(7);
    expect(screen.getByRole("button", { name: /^save changes$/i })).toBeInTheDocument();
  });

  it("Discard drops the edits and leaves edit mode", async () => {
    await openEdit();
    fireEvent.change(qty(), { target: { value: "7" } });
    pressBack();
    fireEvent.click(await screen.findByRole("button", { name: /^discard$/i }));
    await waitFor(() =>
      expect(screen.queryByRole("button", { name: /^save changes$/i })).toBeNull(),
    );
  });

  it("an untouched edit session asks nothing", async () => {
    await openEdit();
    pressBack();
    expect(screen.queryByRole("dialog", { name: /discard your changes/i })).toBeNull();
  });

  it("a tab close with unsaved edits gets the browser prompt; a clean one does not", async () => {
    await openEdit();
    const clean = new Event("beforeunload", { cancelable: true });
    window.dispatchEvent(clean);
    expect(clean.defaultPrevented).toBe(false);
    fireEvent.change(qty(), { target: { value: "7" } });
    const dirty = new Event("beforeunload", { cancelable: true });
    window.dispatchEvent(dirty);
    expect(dirty.defaultPrevented).toBe(true);
  });

  it("the Orders link asks too when edits are unsaved", async () => {
    await openEdit();
    fireEvent.change(qty(), { target: { value: "7" } });
    fireEvent.click(screen.getByRole("link", { name: /^orders$/i }));
    expect(
      await screen.findByRole("dialog", { name: /discard your changes/i }),
    ).toBeInTheDocument();
  });
});
