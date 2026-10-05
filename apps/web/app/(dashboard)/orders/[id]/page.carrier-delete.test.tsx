import * as React from "react";
import { render, screen } from "@testing-library/react";
import { Providers } from "@/app/providers";
import OrderDetailPage from "./page";

/**
 * #3219 S3: an order with the carrier (`cancelBlockedReason: "WITH_CARRIER"`) shows neither Cancel nor
 * Delete in any tier: the server refuses both (409), so offering Delete was a dead end with a
 * "instead of cancelling" toast. Without the block, the controls are exactly as before.
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
jest.mock("@/lib/api-client", () => ({
  ...jest.requireActual("@/lib/api-client"),
  apiClient: { get: (...a: unknown[]) => get(...a), patch: jest.fn(), post: jest.fn() },
}));

const order = (status: string, cancelBlockedReason: "WITH_CARRIER" | null) => ({
  id: "o1",
  orderNumber: "ORD-1",
  customerId: "cust-9",
  customer: { id: "cust-9", businessName: "Acme Retail" },
  status,
  fulfillPath: "SHIP",
  shippedAt: "2026-10-01T00:00:00.000Z",
  cancelBlockedReason,
  urgent: false,
  subtotal: 10,
  tax: 0,
  total: 10,
  lineItems: [],
});

const open = async (status: string, blocked: "WITH_CARRIER" | null) => {
  get.mockImplementation((url: string) =>
    Promise.resolve({ data: url === "/orders/o1" ? order(status, blocked) : [] }),
  );
  render(
    <Providers>
      <OrderDetailPage />
    </Providers>,
  );
  await screen.findByText(/ORD-1/);
};
const deleteButton = () =>
  screen.queryByRole("button", { name: /^Delete( order)?$/ }) ??
  screen.queryByRole("button", { name: /Delete order/ });

beforeEach(() => jest.clearAllMocks());

describe("order detail: Delete is hidden while the order is with the carrier (#3219 S3)", () => {
  it.each(["PENDING", "CONFIRMED", "OUT_FOR_DELIVERY"])(
    "%s, WITH_CARRIER: no Delete",
    async (s) => {
      await open(s, "WITH_CARRIER");
      expect(deleteButton()).toBeNull();
    },
  );

  it.each(["PENDING", "CONFIRMED", "OUT_FOR_DELIVERY"])(
    "%s, not blocked: Delete as before",
    async (s) => {
      await open(s, null);
      expect(deleteButton()).not.toBeNull();
    },
  );
});
