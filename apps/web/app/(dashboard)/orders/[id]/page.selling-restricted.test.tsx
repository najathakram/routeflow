import * as React from "react";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { Providers } from "@/app/providers";
import OrderDetailPage from "./page";

/**
 * A staff status change the API refuses with SELLING_RESTRICTED (409) opens the blocked-items dialog
 * and shows NO toast: the real global MutationCache handler (app/providers.tsx) is in play, so a
 * missing HANDLED_CODES entry or a missing page branch fails this spec.
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

const order = {
  id: "o1",
  orderNumber: "ORD-1",
  customerId: "c1",
  customer: { id: "c1", businessName: "Acme Retail" },
  status: "PENDING",
  fulfillPath: "ROUTE",
  urgent: false,
  subtotal: 10,
  tax: 0,
  total: 10,
  lineItems: [],
};
const blocked = {
  code: "SELLING_RESTRICTED",
  blockedLines: [
    {
      productId: "p1",
      productName: "Hemp Gummies",
      ruleId: "r1",
      categoryId: "cat1",
      categoryName: "Hemp",
      restrictionType: "STATE",
      state: "TX",
      cause: "RULE",
    },
  ],
};
const reject = (status: number, data: object) =>
  patch.mockRejectedValueOnce(
    Object.assign(new Error("Request failed"), { response: { status, data } }),
  );

beforeEach(() => {
  jest.clearAllMocks();
  get.mockImplementation((url: string) =>
    Promise.resolve({ data: url === "/orders/o1" ? order : [] }),
  );
});

const confirm = async () => {
  render(
    <Providers>
      <OrderDetailPage />
    </Providers>,
  );
  fireEvent.click(await screen.findByRole("button", { name: /Confirm Order/ }));
};

describe("order detail — SELLING_RESTRICTED", () => {
  it("confirming a blocked order opens the dialog and raises no toast", async () => {
    reject(409, blocked);
    await confirm();
    expect(await screen.findByText(/Hemp Gummies/)).toBeInTheDocument();
    expect(toast).not.toHaveBeenCalled();
  });

  it("any other failure still gets the single global toast (no dialog)", async () => {
    reject(500, { message: "Boom" });
    await confirm();
    await waitFor(() => expect(toast).toHaveBeenCalledTimes(1));
    expect(screen.queryByText(/Hemp Gummies/)).not.toBeInTheDocument();
  });
});
