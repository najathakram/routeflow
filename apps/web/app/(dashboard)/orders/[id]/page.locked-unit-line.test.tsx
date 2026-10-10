import * as React from "react";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { Providers } from "@/app/providers";
import OrderDetailPage from "./page";

/**
 * SA-388 (#938, tier 1): a stored unit line with no derivable count (qty 40 pieces, boxes 0,
 * snapshot factor 12 — 40 is not a whole number of Cases) is LOCKED. The row says it needs repair,
 * and a note-only save is refused with a visible message and NO request: the PATCH that would
 * have re-billed the line is never sent. Harness mirrors page.credit-limit.test.tsx.
 */
const toast = jest.fn();
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
  useToast: () => ({ toast }),
}));
jest.mock("@/lib/api-client", () => ({
  ...jest.requireActual("@/lib/api-client"),
  apiClient: {
    get: (...a: unknown[]) => get(...a),
    patch: (...a: unknown[]) => patch(...a),
    post: jest.fn(),
  },
}));

const lockedLine = {
  id: "li-locked",
  productId: "p-case",
  product: { id: "p-case", name: "Widget", unit: "Box", unitsPerBox: 12 },
  qty: 40, // base pieces — not a whole multiple of the 12-piece Case
  unitPrice: 65,
  subtotal: 216.67,
  boxes: 0,
  pieces: 0,
  unitsPerBox: 12,
  unitLabel: "Case",
  status: "CONFIRMED",
};
const order = {
  id: "o1",
  orderNumber: "ORD-1",
  customerId: "cust-9",
  customer: { id: "cust-9", businessName: "Acme Retail" },
  status: "DRAFT",
  fulfillPath: "ROUTE",
  urgent: false,
  subtotal: 216.67,
  tax: 0,
  total: 216.67,
  lineItems: [lockedLine],
};

beforeEach(() => {
  jest.clearAllMocks();
  get.mockImplementation((url: string) =>
    Promise.resolve({ data: url === "/orders/o1" ? order : [] }),
  );
});

describe("order edit — a LOCKED unit line (SA-388)", () => {
  it("shows the needs-repair marker instead of a qty input", async () => {
    render(
      <Providers>
        <OrderDetailPage />
      </Providers>,
    );
    expect(await screen.findByText("This line needs repair")).toBeInTheDocument();
  });

  it("a note-only save is refused visibly and sends no request", async () => {
    render(
      <Providers>
        <OrderDetailPage />
      </Providers>,
    );
    fireEvent.change(await screen.findByPlaceholderText(/Note for this line/), {
      target: { value: "leave at the side door" },
    });
    fireEvent.click(await screen.findByRole("button", { name: /Save Draft/ }));

    await waitFor(() =>
      expect(toast).toHaveBeenCalledWith(
        expect.objectContaining({ title: expect.stringMatching(/needs repair/), variant: "error" }),
      ),
    );
    expect(patch).not.toHaveBeenCalled();
  });
});
