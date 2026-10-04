import * as React from "react";
import { render, screen } from "@testing-library/react";
import { Providers } from "@/app/providers";
import OrderDetailPage from "./page";

/**
 * SHIP fulfilment mode on the order detail: no Fulfillment picker, carrier wording ("Mark shipped",
 * "Shipped") instead of "Out for Delivery". Every other account sees exactly today's screen.
 */
let ship = false;
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
jest.mock("@/lib/tenant-features", () => ({
  useTenantFeatures: () => ({
    data: ship
      ? {
          capabilities: {
            fulfilment: {
              methods: ["SHIP"],
              staffDefault: "SHIP",
              portalMethods: [],
              portalDefault: null,
              counter: "off",
              fleet: false,
            },
          },
        }
      : undefined,
  }),
}));
jest.mock("@/lib/api-client", () => ({
  ...jest.requireActual("@/lib/api-client"),
  apiClient: {
    get: (...a: unknown[]) => get(...a),
    patch: jest.fn(),
    post: jest.fn(),
  },
}));

const order = (status: string) => ({
  id: "o1",
  orderNumber: "ORD-1",
  customerId: "cust-9",
  customer: { id: "cust-9", businessName: "Acme Retail" },
  status,
  // the page words the buttons per ORDER: a ship-mode account's orders are SHIP orders
  fulfillPath: ship ? "SHIP" : "ROUTE",
  urgent: false,
  subtotal: 10,
  tax: 0,
  total: 10,
  lineItems: [],
});

const open = async (status: string) => {
  get.mockImplementation((url: string) =>
    Promise.resolve({ data: url === "/orders/o1" ? order(status) : [] }),
  );
  render(
    <Providers>
      <OrderDetailPage />
    </Providers>,
  );
  await screen.findByText("ORD-1");
};

beforeEach(() => jest.clearAllMocks());

describe("order detail — SHIP mode", () => {
  it("ship mode, CONFIRMED: Mark shipped, no Fulfillment row", async () => {
    ship = true;
    await open("CONFIRMED");
    expect(await screen.findByRole("button", { name: /mark shipped/i })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Out for Delivery" })).not.toBeInTheDocument();
    expect(screen.queryByText("Fulfillment")).not.toBeInTheDocument();
  });

  it("not ship mode, CONFIRMED (today's UI, unchanged): Out for Delivery button and the Fulfillment row", async () => {
    ship = false;
    await open("CONFIRMED");
    expect(await screen.findByRole("button", { name: "Out for Delivery" })).toBeInTheDocument();
    expect(screen.getByText("Fulfillment")).toBeInTheDocument();
  });

  it("ship mode, OUT_FOR_DELIVERY: the status badge says Shipped", async () => {
    ship = true;
    await open("OUT_FOR_DELIVERY");
    expect(screen.getAllByText("Shipped").length).toBeGreaterThan(0);
    expect(screen.queryByText("Out for Delivery")).not.toBeInTheDocument();
  });
});
