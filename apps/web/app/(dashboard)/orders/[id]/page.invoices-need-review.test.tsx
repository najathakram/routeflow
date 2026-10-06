import * as React from "react";
import { render, screen } from "@testing-library/react";
import { Providers } from "@/app/providers";
import OrderDetailPage from "./page";

/**
 * B1116: the staff order detail header shows an "Invoices need review" badge beside the status when
 * the order read carries `invoicesNeedReview.flagged`, and nothing otherwise.
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
  },
}));

const baseOrder = {
  id: "o1",
  orderNumber: "ORD-1",
  customerId: "cust-9",
  customer: { id: "cust-9", businessName: "Acme Retail" },
  status: "CONFIRMED",
  fulfillPath: "ROUTE",
  urgent: false,
  subtotal: 10,
  tax: 0,
  total: 10,
  lineItems: [],
  createdAt: "2026-10-01T00:00:00.000Z",
};

const renderWith = async (extra: Record<string, unknown>) => {
  get.mockImplementation((url: string) =>
    Promise.resolve({ data: url === "/orders/o1" ? { ...baseOrder, ...extra } : [] }),
  );
  render(
    <Providers>
      <OrderDetailPage />
    </Providers>,
  );
  await screen.findByText("ORD-1");
};

beforeEach(() => jest.clearAllMocks());

describe("order detail header — Invoices need review (B1116)", () => {
  it("shows the badge, with the reason and who flagged it at a stop, when flagged", async () => {
    await renderWith({
      invoicesNeedReview: {
        flagged: true,
        reason: "This order's invoices don't match its lines.",
        flaggedAtStop: { by: "Dana Driver", at: "2026-10-05T15:30:00.000Z" },
      },
    });
    const badge = await screen.findByTestId("order-invoices-need-review-badge");
    expect(badge).toHaveTextContent("Invoices need review");
    expect(badge.getAttribute("title")).toContain("Flagged at stop completion by Dana Driver");
  });

  it("shows nothing when the invoices are in step", async () => {
    await renderWith({ invoicesNeedReview: { flagged: false } });
    expect(screen.queryByTestId("order-invoices-need-review-badge")).toBeNull();
    expect(screen.queryByText(/Invoices need review/i)).toBeNull();
  });

  it("shows nothing when the read carries no field at all", async () => {
    await renderWith({});
    expect(screen.queryByTestId("order-invoices-need-review-badge")).toBeNull();
  });
});
