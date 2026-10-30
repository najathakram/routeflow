import * as React from "react";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { Providers } from "@/app/providers";
import { seedSession } from "@/test-utils/session";
import OrderDetailPage from "./page";

/**
 * apple-ux r5 N10: after Save Changes the page used to stay mid-page with the saved lines above the fold. Saving
 * brings the Line Items card top into view (and only a SAVE does: Cancel, or opening the editor, does not scroll).
 */
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

let scrollIntoView: jest.Mock;

async function openEdit() {
  get.mockImplementation((url: string) => {
    if (url === "/orders/o1") return Promise.resolve({ data: baseOrder });
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
  scrollIntoView = jest.fn();
  Element.prototype.scrollIntoView = scrollIntoView;
});

const qty = () => screen.getByRole("spinbutton", { name: /qty/i }) as HTMLInputElement;

describe("Edit Items: after Save Changes the saved lines come into view (N10)", () => {
  it("scrolls the Line Items card top into view once the save lands", async () => {
    patch.mockResolvedValue({ data: { ...baseOrder } });
    await openEdit();
    scrollIntoView.mockClear();
    fireEvent.change(qty(), { target: { value: "7" } });
    fireEvent.click(screen.getByRole("button", { name: /^save changes$/i }));
    await waitFor(() =>
      expect(screen.queryByRole("button", { name: /^save changes$/i })).toBeNull(),
    );
    await waitFor(() => expect(scrollIntoView).toHaveBeenCalled());
    const target = scrollIntoView.mock.contexts[
      scrollIntoView.mock.contexts.length - 1
    ] as HTMLElement;
    expect(target).toBe(screen.getByTestId("order-line-items-card"));
    expect(scrollIntoView.mock.calls[0][0]).toMatchObject({ block: "start" });
  });

  it("does not scroll when the edit is cancelled", async () => {
    await openEdit();
    scrollIntoView.mockClear();
    fireEvent.click(screen.getByRole("button", { name: /^cancel$/i }));
    await waitFor(() =>
      expect(screen.queryByRole("button", { name: /^save changes$/i })).toBeNull(),
    );
    expect(scrollIntoView).not.toHaveBeenCalled();
  });

  it("does not scroll when the save failed (still editing)", async () => {
    patch.mockRejectedValue(new Error("boom"));
    await openEdit();
    scrollIntoView.mockClear();
    fireEvent.change(qty(), { target: { value: "7" } });
    fireEvent.click(screen.getByRole("button", { name: /^save changes$/i }));
    await waitFor(() => expect(patch).toHaveBeenCalled());
    await waitFor(() =>
      expect(screen.getByRole("button", { name: /^save changes$/i })).toBeEnabled(),
    );
    expect(scrollIntoView).not.toHaveBeenCalled();
  });
});
