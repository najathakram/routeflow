import * as React from "react";
import { render, screen, fireEvent } from "@testing-library/react";
import { Providers } from "@/app/providers";
import { seedSession } from "@/test-utils/session";
import OrderDetailPage from "./page";

/**
 * #2089 (owner ruling): "once an order is delivered, automatically open that order's
 * invoice and ask whether to send it." `handleDeliver` already auto-creates the invoice
 * and opens the send prompt; this pins that it now routes through the ONE shared
 * `postDeliveryInvoicePrompt` (packages/types) so the prompt's wording tracks the
 * invoice's real status — "Issue & Send Invoice" for the DRAFT `createInvoiceFromOrder`
 * always returns, "Invoice Ready" for one already issued.
 */
const toast = jest.fn();
const get = jest.fn();
const patch = jest.fn();
const post = jest.fn();
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
  useToast: () => ({ toast }),
}));
jest.mock("@/lib/api-client", () => ({
  ...jest.requireActual("@/lib/api-client"),
  apiClient: {
    get: (...a: unknown[]) => get(...a),
    patch: (...a: unknown[]) => patch(...a),
    post: (...a: unknown[]) => post(...a),
  },
}));

const order = {
  id: "o1",
  orderNumber: "ORD-1",
  customerId: "cust-9",
  customer: { id: "cust-9", businessName: "Acme Retail" },
  status: "OUT_FOR_DELIVERY",
  fulfillPath: "ROUTE",
  urgent: false,
  subtotal: 10,
  tax: 0,
  total: 10,
  lineItems: [],
};

const deliver = async (invoiceStatus: string) => {
  get.mockImplementation((url: string) =>
    Promise.resolve({ data: url === "/orders/o1" ? order : [] }),
  );
  patch.mockResolvedValueOnce({ data: { ...order, status: "DELIVERED" } });
  post.mockImplementation((url: string) =>
    url === "/invoices/from-order/o1"
      ? Promise.resolve({
          data: [{ id: "inv-1", invoiceNumber: "INV-1", total: 10, status: invoiceStatus }],
        })
      : Promise.resolve({ data: {} }),
  );
  render(
    <Providers>
      <OrderDetailPage />
    </Providers>,
  );
  fireEvent.click(await screen.findByRole("button", { name: /Mark as Delivered/ }));
};

// B1134: the action bar is staff-only; these specs exercise staff behaviour, so sign in as one.
beforeEach(() => {
  jest.clearAllMocks();
  seedSession("OPERATOR");
});

describe("order detail — post-delivery invoice prompt (#2089)", () => {
  it("opens the send prompt on DELIVERED, worded 'Issue & Send' for the DRAFT createInvoiceFromOrder always returns", async () => {
    await deliver("DRAFT");
    expect(await screen.findByText("Issue & Send Invoice")).toBeInTheDocument();
    expect(screen.getByText("Issue & Mark as Sent")).toBeInTheDocument();
  });

  it("words the same prompt as a plain 'Invoice Ready'/'Mark as Sent' when the invoice is already issued", async () => {
    await deliver("SENT");
    expect(await screen.findByText("Invoice Ready")).toBeInTheDocument();
    expect(screen.getByText("Mark as Sent")).toBeInTheDocument();
  });
});
