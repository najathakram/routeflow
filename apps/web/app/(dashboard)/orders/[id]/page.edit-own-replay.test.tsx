import * as React from "react";
import { render, screen, fireEvent, act, waitFor } from "@testing-library/react";
import { Providers } from "@/app/providers";
import { seedSession } from "@/test-utils/session";
import OrderDetailPage from "./page";

/**
 * Row 698: Save on Edit Items must never tell you "someone else changed this order" about YOUR OWN save.
 *  - a double click / double Ctrl+Enter makes ONE write (the latch; pinned green);
 *  - a replay of a save whose first reply was lost (it WAS applied) hits 409 ORDER_REVISION_STALE; the server now
 *    holds exactly what this client sent, so it is success, not a conflict (red at base);
 *  - a REAL concurrent change by another user still shows the conflict (stays green).
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

const line = (qty: number) => ({
  id: "li-1",
  productId: "p1",
  product: { id: "p1", name: "Widget", unit: "each", unitsPerBox: null },
  qty,
  unitPrice: 2,
  status: "CONFIRMED",
});
const order = (qty: number, revisionNumber: number) => ({
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
  lineItems: [line(qty)],
});
const stale409 = () =>
  Object.assign(new Error("Request failed with status code 409"), {
    response: { status: 409, data: { code: "ORDER_REVISION_STALE", message: "stale" } },
  });
const lostReply = () => Object.assign(new Error("Network Error"), { code: "ERR_NETWORK" });

let server: ReturnType<typeof order>;
async function openEdit() {
  server = order(10, 1);
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
}
const qty = () => screen.getByRole("spinbutton", { name: /qty/i }) as HTMLInputElement;
const saveBtn = () => screen.getByRole("button", { name: /^save changes$/i });
const conflictNotice = () => screen.queryByTestId("order-stale-notice");

beforeEach(() => {
  jest.clearAllMocks();
  seedSession("OPERATOR");
});

describe("Save on Edit Items never reports your own save as a conflict (row 698)", () => {
  it("a double Ctrl+Enter makes ONE write while the first is in flight", async () => {
    patch.mockImplementation(() => new Promise(() => undefined));
    await openEdit();
    fireEvent.change(qty(), { target: { value: "7" } });
    await act(async () => {
      fireEvent.keyDown(qty(), { key: "Enter", ctrlKey: true });
      fireEvent.keyDown(qty(), { key: "Enter", ctrlKey: true });
    });
    expect(patch).toHaveBeenCalledTimes(1);
  });

  it("Save Changes is disabled while the write is in flight", async () => {
    patch.mockImplementation(() => new Promise(() => undefined));
    await openEdit();
    fireEvent.change(qty(), { target: { value: "7" } });
    fireEvent.click(saveBtn());
    await waitFor(() => expect(saveBtn()).toBeDisabled());
  });

  it("OWN REPLAY: the first reply was lost (applied), the retry gets 409 - the server holds exactly what was sent => success", async () => {
    patch.mockRejectedValueOnce(lostReply()).mockRejectedValueOnce(stale409());
    await openEdit();
    fireEvent.change(qty(), { target: { value: "7" } });
    fireEvent.click(saveBtn());
    await waitFor(() => expect(patch).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(saveBtn()).toBeEnabled());
    // The first write had landed server-side: revision 2, qty 7.
    server = order(7, 2);
    fireEvent.click(saveBtn());
    await waitFor(() => expect(patch).toHaveBeenCalledTimes(2));
    await waitFor(() =>
      expect(toast).toHaveBeenCalledWith(
        expect.objectContaining({ title: "Order updated", variant: "success" }),
      ),
    );
    expect(conflictNotice()).toBeNull();
    expect(screen.queryByRole("button", { name: /^save changes$/i })).toBeNull();
  });

  it("REAL concurrent change: another user set a different qty => the conflict still shows", async () => {
    patch.mockRejectedValueOnce(stale409());
    await openEdit();
    fireEvent.change(qty(), { target: { value: "7" } });
    // Someone else moved the order to revision 2 with a qty of 12 while this editor was open.
    server = order(12, 2);
    fireEvent.click(saveBtn());
    await waitFor(() => expect(conflictNotice()).not.toBeNull());
    expect(toast).not.toHaveBeenCalledWith(expect.objectContaining({ title: "Order updated" }));
    expect(screen.getByRole("button", { name: /^save changes$/i })).toBeInTheDocument();
  });

  it("REAL concurrent change on a DIFFERENT field still conflicts (nothing this editor sent is on the server)", async () => {
    patch.mockRejectedValueOnce(stale409());
    await openEdit();
    fireEvent.change(qty(), { target: { value: "7" } });
    server = order(10, 2); // unchanged qty, newer revision (e.g. a price/note edit by someone else)
    fireEvent.click(saveBtn());
    await waitFor(() => expect(conflictNotice()).not.toBeNull());
  });
});
