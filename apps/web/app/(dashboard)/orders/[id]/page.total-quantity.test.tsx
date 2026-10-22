import * as React from "react";
import { render, screen } from "@testing-library/react";
import { Providers } from "@/app/providers";
import { seedSession } from "@/test-utils/session";
import OrderDetailPage from "./page";

/** F03 / F19: Total quantity per unit, never one unitless sum. */
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

const order = {
  ...baseOrder,
  lineItems: [
    {
      id: "li-1",
      productId: "p1",
      product: { id: "p1", name: "Chips", unit: "case", unitsPerBox: 12 },
      qty: 36,
      boxes: 3,
      pieces: 0,
      unitsPerBox: 12,
      unitPrice: 18,
      subtotal: 54,
      status: "CONFIRMED",
    },
    {
      id: "li-2",
      productId: "p2",
      product: { id: "p2", name: "Cola", unit: "bottle", unitsPerBox: null },
      qty: 6,
      unitPrice: 2,
      subtotal: 12,
      status: "CONFIRMED",
    },
  ],
};

beforeEach(() => seedSession("OPERATOR"));

it("Total quantity names each unit and is not the unitless sum 42", async () => {
  get.mockImplementation((url: string) => {
    if (url === "/orders/o1") return Promise.resolve({ data: order });
    if (url === "/tenants/me/addons") return Promise.resolve({ data: { addons: [] } });
    return Promise.resolve({ data: [] });
  });
  render(
    <Providers>
      <OrderDetailPage />
    </Providers>,
  );
  const dt = await screen.findByText("Total quantity");
  const text = dt.parentElement!.textContent ?? "";
  expect(text).toContain("3 boxes + 6 bottles");
  expect(text).not.toMatch(/42/);
});
