import * as React from "react";
import { render, screen, fireEvent, act, waitFor } from "@testing-library/react";
import { Providers } from "@/app/providers";
import { seedSession } from "@/test-utils/session";
import OrderDetailPage from "./page";

/** Row 698 (F23): a double Save on Edit Items sends ONE write and shows no false "Someone else changed" error. */
const get = jest.fn();
const patch = jest.fn();
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
    patch: (...a: unknown[]) => patch(...a),
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

describe("double Save on Edit Items (F23 / row 698)", () => {
  it("two quick Save Changes clicks send ONE write while the first is in flight", async () => {
    patch.mockImplementation(() => new Promise(() => undefined));
    await openEdit();
    fireEvent.change(qty(), { target: { value: "7" } });
    const save = screen.getByRole("button", { name: /^save changes$/i });
    await act(async () => {
      save.click();
      save.click();
    });
    expect(patch).toHaveBeenCalledTimes(1);
  });

  it("a Save after the first one failed is allowed again", async () => {
    patch
      .mockRejectedValueOnce(new Error("boom"))
      .mockImplementation(() => new Promise(() => undefined));
    await openEdit();
    fireEvent.change(qty(), { target: { value: "7" } });
    fireEvent.click(screen.getByRole("button", { name: /^save changes$/i }));
    await waitFor(() => expect(patch).toHaveBeenCalledTimes(1));
    await waitFor(() =>
      expect(screen.getByRole("button", { name: /^save changes$/i })).toBeEnabled(),
    );
    fireEvent.click(screen.getByRole("button", { name: /^save changes$/i }));
    await waitFor(() => expect(patch).toHaveBeenCalledTimes(2));
  });
});
