import * as React from "react";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { Providers } from "@/app/providers";
import { seedSession } from "@/test-utils/session";
import OrderDetailPage from "./page";

/**
 * B1372 (SA-1177 K2, owner box Q2 "Warn, re-send at hand-over"): Save on Edit Items of an order whose sent invoice the edit
 * turns back into a draft (the order read's `editRevertsSentInvoices`) asks first; no PATCH goes until "Edit anyway".
 * An order with nothing to revert saves at once (guard). Harness: page.edit-own-replay.test.tsx's. Placeholders only.
 */
const get = jest.fn();
const patch = jest.fn();
const toast = jest.fn();
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
    delete: jest.fn(),
  },
}));

const line = (qty: number, extra: Record<string, unknown> = {}) => ({
  id: "li-1",
  productId: "p1",
  product: { id: "p1", name: "Widget", unit: "each", unitsPerBox: null },
  qty,
  unitPrice: 2,
  status: "CONFIRMED",
  ...extra,
});
const order = (qty: number, revisionNumber: number, lineExtra: Record<string, unknown> = {}) => ({
  id: "o1",
  orderNumber: "ORD-1",
  customerId: "c1",
  customer: { id: "c1", businessName: "Acme Retail" },
  status: "PENDING",
  fulfillPath: "ROUTE",
  urgent: false,
  subtotal: qty * 2,
  tax: 0,
  total: qty * 2,
  revisionNumber,
  lineItems: [line(qty, lineExtra)],
});
async function openEdit(editRevertsSentInvoices: string[]) {
  const server = { ...order(10, 1), editRevertsSentInvoices };
  get.mockImplementation((url: string) => {
    if (url === "/orders/o1") return Promise.resolve({ data: server });
    if (url === "/tenants/me/addons") return Promise.resolve({ data: { addons: [] } });
    return Promise.resolve({ data: [] });
  });
  render(
    <Providers>
      <OrderDetailPage />
    </Providers>,
  );
  fireEvent.click(await screen.findByRole("button", { name: /edit items/i }));
  await screen.findByRole("button", { name: /^save changes$/i });
  fireEvent.change(screen.getByRole("spinbutton", { name: /qty/i }), { target: { value: "7" } });
}
const saveBtn = () => screen.getByRole("button", { name: /^save changes$/i });

beforeEach(() => {
  jest.clearAllMocks();
  seedSession("OPERATOR");
  patch.mockImplementation(() => new Promise(() => undefined));
});

describe("Edit Items on an order with a sent invoice confirms first (B1372 K2)", () => {
  it("Save asks, names the invoice, and writes nothing; Edit anyway sends the one PATCH", async () => {
    await openEdit(["INV-2026-0007"]);
    fireEvent.click(saveBtn());
    expect(
      await screen.findByText(
        "Invoice INV-2026-0007 was already sent. This edit turns it back into a draft. It is sent again when the order is handed over or delivered.",
      ),
    ).toBeInTheDocument();
    expect(patch).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Edit anyway" }));
    await waitFor(() => expect(patch).toHaveBeenCalledTimes(1));
    expect(patch.mock.calls[0][0]).toBe("/orders/o1/items");
  });

  it("Cancel keeps the editor open and writes nothing", async () => {
    await openEdit(["INV-2026-0007"]);
    fireEvent.click(saveBtn());
    fireEvent.click(await screen.findByRole("button", { name: "Cancel" }));
    expect(patch).not.toHaveBeenCalled();
    expect(saveBtn()).toBeInTheDocument();
  });

  it("nothing to revert: Save writes at once, no confirm (guard)", async () => {
    await openEdit([]);
    fireEvent.click(saveBtn());
    await waitFor(() => expect(patch).toHaveBeenCalledTimes(1));
    expect(screen.queryByRole("button", { name: "Edit anyway" })).toBeNull();
  });
});
