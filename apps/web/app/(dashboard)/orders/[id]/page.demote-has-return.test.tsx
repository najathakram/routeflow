import * as React from "react";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { Providers } from "@/app/providers";
import { seedSession } from "@/test-utils/session";
import OrderDetailPage from "./page";

/**
 * SA-1101 A-5 (B1272): the office "Reopen order" on a delivered order that has a live return is refused with
 * 409 ORDER_HAS_RETURN. The page must say the A-5 sentence (cancel the return, to change the delivery status), not the
 * Deliver-again sentence the global toast has for that code ("To deliver it again..."), and say it once.
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
  customerId: "cust-9",
  customer: { id: "cust-9", businessName: "Acme Retail" },
  status: "DELIVERED",
  fulfillPath: "ROUTE",
  urgent: false,
  subtotal: 10,
  tax: 0,
  total: 10,
  lineItems: [],
};

const A5_SENTENCE =
  "This order has a return. To change its delivery status, cancel the return first.";
const DELIVER_AGAIN_SENTENCE =
  "This order has a return. To deliver it again, cancel the return first, or create a new order.";

const axiosErr = (status: number, data: unknown) =>
  Object.assign(new Error(`Request failed with status code ${status}`), {
    response: { status, data },
  });

const reopenWith = async (refusal: unknown) => {
  get.mockImplementation((url: string) =>
    Promise.resolve({ data: url === "/orders/o1" ? order : [] }),
  );
  patch.mockRejectedValueOnce(refusal);
  render(
    <Providers>
      <OrderDetailPage />
    </Providers>,
  );
  fireEvent.click(await screen.findByRole("button", { name: /Reopen order/ }));
  fireEvent.change(await screen.findByPlaceholderText(/Customer called/), {
    target: { value: "office correction" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Confirm" }));
  await waitFor(() => expect(patch).toHaveBeenCalledTimes(1));
};

const titles = () => toast.mock.calls.map((c) => (c[0] as { title?: string }).title);

beforeEach(() => {
  jest.clearAllMocks();
  seedSession("OPERATOR");
});

describe("order detail — Reopen order refused by a live return (SA-1101 A-5)", () => {
  it("409 ORDER_HAS_RETURN reads the A-5 sentence, once, never the Deliver-again one", async () => {
    await reopenWith(
      axiosErr(409, { code: "ORDER_HAS_RETURN", message: "server wording that must not show" }),
    );
    await waitFor(() => expect(titles()).toContain(A5_SENTENCE));
    expect(titles().filter((t) => t === A5_SENTENCE)).toHaveLength(1);
    expect(titles()).not.toContain(DELIVER_AGAIN_SENTENCE);
    expect(titles().join(" ")).not.toContain("server wording that must not show");
  });

  it("any other refusal still gets the global fixed-copy toast, not the return sentence", async () => {
    await reopenWith(axiosErr(409, { code: "ORDER_CHANGED_DURING_EDIT", message: "x" }));
    await waitFor(() => expect(toast).toHaveBeenCalled());
    expect(titles()).not.toContain(A5_SENTENCE);
  });
});
