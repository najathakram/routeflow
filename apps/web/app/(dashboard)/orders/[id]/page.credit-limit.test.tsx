import * as React from "react";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { Providers } from "@/app/providers";
import OrderDetailPage from "./page";

/**
 * A status change the API refuses for credit (409 CREDIT_LIMIT_EXCEEDED) opens the credit guard
 * dialog — the server's own numbers and sentence, plus a "Collect payment" exit to the customer —
 * with NO toast. The real global MutationCache handler (app/providers.tsx) is in play, so a missing
 * HANDLED_CODES entry or a missing page branch fails here.
 */
const toast = jest.fn();
const push = jest.fn();
const get = jest.fn();
const patch = jest.fn();
jest.mock("next/navigation", () => ({
  useParams: () => ({ id: "o1" }),
  useRouter: () => ({ push, replace: jest.fn() }),
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

const order = (status: string) => ({
  id: "o1",
  orderNumber: "ORD-1",
  customerId: "cust-9",
  customer: { id: "cust-9", businessName: "Acme Retail" },
  status,
  fulfillPath: "ROUTE",
  urgent: false,
  subtotal: 10,
  tax: 0,
  total: 10,
  lineItems: [],
});
const credit409 = {
  code: "CREDIT_LIMIT_EXCEEDED",
  message:
    "This delivery would take the customer's exposure to 110.00, over their credit limit of 100.00.",
  limit: 100,
  exposure: 110,
};
const reject = (status: number, data: object) =>
  patch.mockRejectedValueOnce(
    Object.assign(new Error("Request failed"), { response: { status, data } }),
  );

const open = async (status: string, button: RegExp) => {
  get.mockImplementation((url: string) =>
    Promise.resolve({ data: url === "/orders/o1" ? order(status) : [] }),
  );
  render(
    <Providers>
      <OrderDetailPage />
    </Providers>,
  );
  fireEvent.click(await screen.findByRole("button", { name: button }));
};

beforeEach(() => jest.clearAllMocks());

describe("order detail — CREDIT_LIMIT_EXCEEDED", () => {
  it("Mark as Delivered refused for credit: the dialog with the fixed sentence built from the server's numbers, no toast", async () => {
    reject(409, credit409);
    await open("OUT_FOR_DELIVERY", /Mark as Delivered/);
    const dialog = await screen.findByRole("dialog", { name: /credit limit exceeded/i });
    expect(dialog).toHaveTextContent("$100.00");
    expect(dialog).toHaveTextContent("$110.00");
    expect(dialog).toHaveTextContent(/over their \$100\.00 credit limit/);
    expect(toast).not.toHaveBeenCalled();
  });

  it("Collect payment goes to the customer and closes the dialog; Cancel just closes", async () => {
    reject(409, credit409);
    await open("OUT_FOR_DELIVERY", /Mark as Delivered/);
    fireEvent.click(await screen.findByRole("button", { name: "Collect payment" }));
    expect(push).toHaveBeenCalledWith("/customers/cust-9");
    await waitFor(() => expect(screen.queryByRole("dialog", { name: /credit limit/i })).toBeNull());

    reject(409, credit409);
    fireEvent.click(await screen.findByRole("button", { name: /Mark as Delivered/ }));
    fireEvent.click(await screen.findByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(screen.queryByRole("dialog", { name: /credit limit/i })).toBeNull());
    expect(push).toHaveBeenCalledTimes(1);
  });

  it("any other delivery failure still gets the single global toast and no dialog", async () => {
    reject(500, { message: "Boom" });
    await open("OUT_FOR_DELIVERY", /Mark as Delivered/);
    await waitFor(() => expect(toast).toHaveBeenCalledTimes(1));
    expect(screen.queryByRole("dialog", { name: /credit limit/i })).toBeNull();
  });
});
