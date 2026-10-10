import * as React from "react";
import { render, screen } from "@testing-library/react";
import { Providers } from "@/app/providers";
import OrderDetailPage from "./page";

/**
 * SA-593e (M3 fold 1): at PAGE level, the staff order detail shows a composed line's sub-lines in
 * read-only mode on BOTH renderers: the default table (orderUiV2 off) and the v2 cards. Harness
 * mirrors page.locked-unit-line.test.tsx; the flag is mocked through useOrderUiV2.
 */
let v2 = false;
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
jest.mock("@/lib/api/addons", () => ({
  ...jest.requireActual("@/lib/api/addons"),
  useOrderUiV2: () => ({ enabled: v2, resolved: true }),
}));
jest.mock("@/lib/api-client", () => ({
  ...jest.requireActual("@/lib/api-client"),
  apiClient: { get: (...a: unknown[]) => get(...a), patch: jest.fn(), post: jest.fn() },
}));

const comp = (id: string, name: string, position: number) => ({
  componentProductId: id,
  name,
  qty: 24,
  unitSku: `SKU-${id}`,
  unitBarcode: null,
  barcodeSymbology: null,
  displayUnitPrice4: 1.25,
  position,
});
const order = {
  id: "o1",
  orderNumber: "ORD-1",
  customerId: "cust-9",
  customer: { id: "cust-9", businessName: "Acme Retail" },
  status: "DELIVERED",
  fulfillPath: "ROUTE",
  urgent: false,
  subtotal: 60,
  tax: 0,
  total: 60,
  lineItems: [
    {
      id: "li-1",
      productId: "p-mix",
      product: { id: "p-mix", name: "Mixed Pack", unit: "Box", unitsPerBox: 24 },
      qty: 48,
      boxes: 2,
      pieces: 0,
      unitsPerBox: 24,
      unitPrice: 30,
      subtotal: 60,
      status: "DELIVERED",
      components: [comp("a", "Almond", 0), comp("o", "Oat", 1)],
    },
  ],
};

beforeEach(() => {
  jest.clearAllMocks();
  get.mockImplementation((url: string) =>
    Promise.resolve({ data: url === "/orders/o1" ? order : [] }),
  );
});

describe("order detail page sub-lines (read-only, not edit mode)", () => {
  it.each([
    ["default table (orderUiV2 off)", false],
    ["v2 cards (orderUiV2 on)", true],
  ])("%s renders both component sub-lines", async (_n, flag) => {
    v2 = flag;
    render(
      <Providers>
        <OrderDetailPage />
      </Providers>,
    );
    const rows = await screen.findAllByTestId("line-component-sub-line");
    expect(rows).toHaveLength(2);
  });
});
