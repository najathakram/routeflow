import * as React from "react";
import { render, screen, within } from "@testing-library/react";
import { Providers } from "@/app/providers";
import { seedSession } from "@/test-utils/session";
import OrderDetailPage from "./page";

/**
 * M8 (390 px wrap): on a POS (pickup) order "Switch to delivery" and "Ship by carrier…" are ONE wrap unit (a
 * single flex group, full width below md so it wraps as a whole), and Delete is the LAST control of the
 * action bar, so it never shares a row with a path move.
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
jest.mock("@/app/(dashboard)/returns/_components/RecordReturnAction", () => ({
  RecordReturnAction: () => <button type="button">Record return</button>,
}));
jest.mock("@/lib/api-client", () => ({
  ...jest.requireActual("@/lib/api-client"),
  apiClient: { get: (...a: unknown[]) => get(...a), patch: jest.fn(), post: jest.fn() },
}));

const order = (status: string) => ({
  id: "o1",
  orderNumber: "ORD-1",
  customerId: "cust-9",
  customer: { id: "cust-9", businessName: "Acme Retail" },
  status,
  fulfillPath: "PICKUP",
  counterSale: false,
  cancelBlockedReason: null,
  editWindow: { editable: true },
  urgent: false,
  subtotal: 10,
  tax: 0,
  total: 10,
  lineItems: [],
  invoices: [],
});

beforeEach(() => jest.clearAllMocks());
afterEach(() => seedSession(null));

describe.each(["PENDING", "CONFIRMED"])("%s pickup order action bar", (status) => {
  const open = async () => {
    seedSession("OPERATOR");
    get.mockImplementation((url: string) =>
      Promise.resolve({ data: url === "/orders/o1" ? order(status) : [] }),
    );
    render(
      <Providers>
        <OrderDetailPage />
      </Providers>,
    );
    await screen.findByText(/ORD-1/);
  };
  const btn = (re: RegExp) => screen.getByRole("button", { name: re });

  it("the two path moves share one wrap group that goes full width on a phone", async () => {
    await open();
    const group = screen.getByRole("group", { name: /move this order off pickup/i });
    const inside = within(group).getAllByRole("button");
    expect(inside.map((b) => b.textContent?.trim())).toEqual([
      "Switch to delivery",
      "Ship by carrier…",
    ]);
    expect(group.className).toMatch(/\bflex-wrap\b/);
    expect(group.className).toMatch(/max-md:w-full/);
  });

  it("Delete comes last, after the path-move group, and outside it", async () => {
    await open();
    const del = btn(/^Delete( order)?$/);
    const all = screen
      .getAllByRole("button")
      .filter((b) =>
        /^(Edit order|Record return|Confirm Order|Unconfirm|Cancel Order|Switch to delivery|Ship by carrier…|Delete( order)?)$/.test(
          b.textContent?.trim() ?? "",
        ),
      );
    expect(all[all.length - 1]).toBe(del);
    const group = screen.getByRole("group", { name: /move this order off pickup/i });
    expect(group.contains(del)).toBe(false);
    expect(group.compareDocumentPosition(del) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });
});
