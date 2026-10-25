import * as React from "react";
import { render, screen, fireEvent, within, waitFor, act } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Providers } from "@/app/providers";
import { seedSession } from "@/test-utils/session";
import OrderDetailPage from "./page";

/**
 * apple-ux r4 PR-GH (Q19, F07, F16, F05, row 724): Order detail + Edit Items.
 *  - at phone width the actions are ONE row: Confirm leads and fills it, the rest sit behind "More actions"
 *  - Generate Invoice says the new invoice is a draft that was not sent, in a status region, and keeps focus there
 *  - Save changes confirms with "Order updated"; Ctrl/Cmd+Enter saves from any field while editing
 *  - the trash button is "Remove ..." in both its title and its name
 * jsdom has no stylesheet or viewport: the phone width is a matchMedia stub (the page reads the query), and
 * class claims pin the tokens the CSS keys off. The pixel proof is the host-run capture.
 */
const get = jest.fn();
const post = jest.fn();
const patch = jest.fn();
const del = jest.fn();
const mockToast = jest.fn();
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
  useToast: () => ({ toast: mockToast, dismiss: jest.fn() }),
}));
jest.mock("@/lib/api-client", () => ({
  ...jest.requireActual("@/lib/api-client"),
  apiClient: {
    get: (...a: unknown[]) => get(...a),
    patch: (...a: unknown[]) => patch(...a),
    post: (...a: unknown[]) => post(...a),
    delete: (...a: unknown[]) => del(...a),
  },
}));

const baseOrder = {
  id: "o1",
  orderNumber: "ORD-1",
  customerId: "c1",
  customer: { id: "c1", businessName: "Acme Retail" },
  status: "PENDING",
  fulfillPath: "ROUTE",
  urgent: false,
  subtotal: 20,
  tax: 0,
  total: 20,
  lineItems: [
    {
      id: "li-1",
      productId: "p1",
      product: { id: "p1", name: "Widget", unit: "each", unitsPerBox: null },
      qty: 10,
      invoicedQty: 0,
      unitPrice: 2,
      subtotal: 20,
      status: "CONFIRMED",
    },
  ],
};

/** Phone width: the page asks matchMedia, so a stub that matches the phone query is the viewport. */
function setPhone(on: boolean) {
  Object.defineProperty(window, "matchMedia", {
    configurable: true,
    writable: true,
    value: on
      ? (q: string) => ({
          matches: q.includes("max-width: 639px"),
          media: q,
          onchange: null,
          addEventListener: jest.fn(),
          removeEventListener: jest.fn(),
          addListener: jest.fn(),
          removeListener: jest.fn(),
          dispatchEvent: () => false,
        })
      : undefined,
  });
}

// The open menu leaves Radix's body pointer-events lock in jsdom, which user-event would refuse to click through.
const menuUser = () => userEvent.setup({ pointerEventsCheck: 0 });

let invoiced = false;
const draftInvoice = {
  id: "inv-1",
  invoiceNumber: "INV-2026-0003",
  status: "DRAFT",
  total: 20,
  dueDate: null,
};

function wire(extra: Record<string, unknown> = {}, addons: string[] = []) {
  get.mockImplementation((url: string) => {
    if (url === "/orders/o1")
      return Promise.resolve({
        data: { ...baseOrder, ...extra, ...(invoiced ? { invoices: [draftInvoice] } : {}) },
      });
    if (url === "/tenants/me/addons") return Promise.resolve({ data: { addons } });
    if (url === "/returns" || url === "/credit-notes" || url === "/orders")
      return Promise.resolve({
        data: { data: [], meta: { total: 0, page: 1, limit: 50, totalPages: 0 } },
      });
    if (url === "/orders/o1/cancel-impact")
      return Promise.resolve({
        data: {
          invoicesToVoid: [],
          creditsToRestore: [],
          advanceToRestore: 0,
          blockingPayments: [],
          canCancel: true,
        },
      });
    return Promise.resolve({ data: [] });
  });
}
async function open(extra: Record<string, unknown> = {}, addons: string[] = []) {
  wire(extra, addons);
  render(
    <Providers>
      <OrderDetailPage />
    </Providers>,
  );
  await screen.findByRole("button", { name: /edit items/i });
}
async function openEdit(extra: Record<string, unknown> = {}) {
  await open(extra);
  fireEvent.click(screen.getByRole("button", { name: /edit items/i }));
  await screen.findByRole("button", { name: /^save changes$/i });
}

beforeEach(() => {
  jest.clearAllMocks();
  invoiced = false;
  setPhone(false);
  seedSession("OPERATOR");
});
afterEach(() => setPhone(false));

describe("Q19: one action row at phone width", () => {
  it("PENDING: the bar is Edit Items, Confirm order and one More menu; Cancel, Delete and Record return are not on it", async () => {
    setPhone(true);
    await open({}, ["orders_inline_returns"]);
    const bar = screen.getByTestId("order-actions");
    const names = within(bar)
      .getAllByRole("button")
      .map((b) => b.getAttribute("aria-label") ?? b.textContent?.trim());
    expect(names.sort()).toEqual(["Confirm order", "Edit Items", "More actions"]);
  });

  it("Confirm order is the full-width primary: it fills what the row leaves, as a 44px target", async () => {
    setPhone(true);
    await open();
    const confirm = screen.getByRole("button", { name: /^confirm order$/i });
    const tier = confirm.closest('[data-tier="primary"]') as HTMLElement;
    expect(tier).toHaveClass("flex-1", "[&_button]:w-full", "[&_button]:min-h-11");
    expect(tier).toContainElement(confirm);
    // the bar is one row (it never carries the stacked-rows wrapper)
    expect(screen.getByTestId("order-actions")).not.toHaveClass("flex-col");
  });

  it("the More menu holds Record return, Cancel order and Delete; Cancel order still goes through its confirm", async () => {
    setPhone(true);
    await open({}, ["orders_inline_returns"]);
    await menuUser().click(screen.getByRole("button", { name: "More actions" }));
    expect(await screen.findByRole("menuitem", { name: "Record return" })).toBeInTheDocument();
    expect(screen.getByRole("menuitem", { name: "Delete order" })).toBeInTheDocument();
    await menuUser().click(screen.getByRole("menuitem", { name: "Cancel order" }));
    expect(await screen.findByText("Cancel this order?")).toBeInTheDocument();
    expect(patch).not.toHaveBeenCalled();
  });

  it("Delete is reachable from the menu and still behind its confirm: nothing is deleted until Confirm delete", async () => {
    setPhone(true);
    del.mockResolvedValue({ data: {} });
    await open();
    const user = menuUser();
    await user.click(screen.getByRole("button", { name: "More actions" }));
    await user.click(await screen.findByRole("menuitem", { name: "Delete order" }));
    expect(await screen.findByText("Delete order?")).toBeInTheDocument();
    expect(del).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Confirm delete" }));
    await waitFor(() => expect(del).toHaveBeenCalledWith("/orders/o1"));
  });

  it("Record return opens its dialog from the menu", async () => {
    setPhone(true);
    await open({}, ["orders_inline_returns"]);
    await menuUser().click(screen.getByRole("button", { name: "More actions" }));
    await menuUser().click(await screen.findByRole("menuitem", { name: "Record return" }));
    expect(await screen.findByRole("dialog")).toBeInTheDocument();
  });

  it("CONFIRMED: Unconfirm moves into the menu too, so the row is Edit, primary, More", async () => {
    setPhone(true);
    await open({ status: "CONFIRMED" });
    const bar = screen.getByTestId("order-actions");
    expect(within(bar).queryByRole("button", { name: /^unconfirm$/i })).toBeNull();
    expect(within(bar).queryByRole("button", { name: /^cancel order$/i })).toBeNull();
    await menuUser().click(within(bar).getByRole("button", { name: "More actions" }));
    expect(await screen.findByRole("menuitem", { name: "Unconfirm" })).toBeInTheDocument();
    expect(screen.getByRole("menuitem", { name: "Cancel order" })).toBeInTheDocument();
  });

  it("wider than a phone nothing moves: Cancel order and Delete stay as buttons, there is no More menu", async () => {
    await open({}, ["orders_inline_returns"]);
    expect(screen.getByRole("button", { name: /^cancel order$/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /^delete$/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /^record return$/i })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "More actions" })).toBeNull();
  });
});

describe("F07: Generate Invoice says the draft was not sent", () => {
  const generate = () => screen.getByRole("button", { name: /^Generate Invoice \(full order\)$/ });
  beforeEach(() => {
    post.mockImplementation((url: string) => {
      if (url === "/invoices/from-order/o1") {
        invoiced = true;
        return Promise.resolve({ data: [draftInvoice] });
      }
      return Promise.resolve({ data: {} });
    });
  });

  it("announces 'INV-... created as a draft. Not sent to the customer.' in a status region", async () => {
    await open({ status: "CONFIRMED" });
    fireEvent.click(generate());
    const text = await screen.findByText(
      "INV-2026-0003 created as a draft. Not sent to the customer.",
    );
    expect(text.closest('[role="status"]')).not.toBeNull();
    expect(text.closest('[role="status"]')).toBeInTheDocument();
  });

  it("the status region sits in the Invoice card and is there before the text, so it is read out", async () => {
    await open({ status: "CONFIRMED" });
    const card = screen.getByRole("heading", { name: "Invoice" }).parentElement as HTMLElement;
    expect(within(card).getByRole("status")).toBeEmptyDOMElement();
    fireEvent.click(generate());
    await waitFor(() =>
      expect(within(card).getByRole("status")).toHaveTextContent(
        "INV-2026-0003 created as a draft. Not sent to the customer.",
      ),
    );
  });

  it("moves focus to the new invoice number (not BODY) and keeps it there", async () => {
    await open({ status: "CONFIRMED" });
    generate().focus();
    fireEvent.click(generate());
    await screen.findByText("INV-2026-0003 created as a draft. Not sent to the customer.");
    const card = screen.getByRole("heading", { name: "Invoice" }).parentElement as HTMLElement;
    await waitFor(() => expect(document.activeElement).toHaveTextContent("INV-2026-0003"));
    expect(card).toContainElement(document.activeElement as HTMLElement);
    await act(async () => {
      await new Promise((r) => setTimeout(r, 60));
    });
    expect(document.activeElement).toHaveTextContent("INV-2026-0003");
    expect(document.activeElement).not.toBe(document.body);
  });
});

describe("F16: Save changes confirms", () => {
  const qty = () => screen.getByRole("spinbutton", { name: /qty/i });
  beforeEach(() => {
    patch.mockResolvedValue({
      data: { ...baseOrder, lineItems: [{ ...baseOrder.lineItems[0], qty: 7, subtotal: 14 }] },
    });
  });

  it("shows 'Order updated' after a save that wrote something", async () => {
    await openEdit();
    fireEvent.change(qty(), { target: { value: "7" } });
    fireEvent.click(screen.getByRole("button", { name: /^save changes$/i }));
    await waitFor(() =>
      expect(mockToast).toHaveBeenCalledWith(
        expect.objectContaining({ title: "Order updated", variant: "success" }),
      ),
    );
  });

  it("says nothing when nothing changed (no write, no confirmation)", async () => {
    await openEdit();
    fireEvent.click(screen.getByRole("button", { name: /^save changes$/i }));
    await screen.findByRole("button", { name: /edit items/i });
    expect(patch).not.toHaveBeenCalled();
    expect(mockToast).not.toHaveBeenCalledWith(expect.objectContaining({ title: "Order updated" }));
  });

  it("does not confirm a save the server refused", async () => {
    patch.mockRejectedValue(new Error("boom"));
    await openEdit();
    fireEvent.change(qty(), { target: { value: "7" } });
    fireEvent.click(screen.getByRole("button", { name: /^save changes$/i }));
    await waitFor(() => expect(patch).toHaveBeenCalled());
    await act(async () => {
      await new Promise((r) => setTimeout(r, 30));
    });
    expect(mockToast).not.toHaveBeenCalledWith(expect.objectContaining({ title: "Order updated" }));
  });
});

describe("F05: Ctrl/Cmd+Enter saves from any field while editing", () => {
  const qty = () => screen.getByRole("spinbutton", { name: /qty/i });
  beforeEach(() => {
    patch.mockResolvedValue({
      data: { ...baseOrder, lineItems: [{ ...baseOrder.lineItems[0], qty: 7, subtotal: 14 }] },
    });
  });

  it("Ctrl+Enter in the qty field saves once", async () => {
    await openEdit();
    fireEvent.change(qty(), { target: { value: "7" } });
    fireEvent.keyDown(qty(), { key: "Enter", ctrlKey: true });
    await waitFor(() => expect(patch).toHaveBeenCalledTimes(1));
  });

  it("Cmd+Enter works from the line note too (any field)", async () => {
    await openEdit();
    fireEvent.change(qty(), { target: { value: "7" } });
    fireEvent.keyDown(screen.getByPlaceholderText(/note for this line/i), {
      key: "Enter",
      metaKey: true,
    });
    await waitFor(() => expect(patch).toHaveBeenCalledTimes(1));
  });

  it("a bare Enter does nothing (no bare keys)", async () => {
    await openEdit();
    fireEvent.change(qty(), { target: { value: "7" } });
    fireEvent.keyDown(qty(), { key: "Enter" });
    fireEvent.keyDown(qty(), { key: "s" });
    fireEvent.keyDown(qty(), { key: "s", ctrlKey: true });
    await act(async () => {
      await new Promise((r) => setTimeout(r, 30));
    });
    expect(patch).not.toHaveBeenCalled();
  });

  it("when not editing the chord does nothing", async () => {
    await open();
    fireEvent.keyDown(document.body, { key: "Enter", ctrlKey: true });
    fireEvent.keyDown(screen.getByRole("button", { name: /edit items/i }), {
      key: "Enter",
      ctrlKey: true,
    });
    await act(async () => {
      await new Promise((r) => setTimeout(r, 30));
    });
    expect(patch).not.toHaveBeenCalled();
    expect(screen.queryByRole("button", { name: /^save changes$/i })).toBeNull();
  });

  it("Save changes advertises the chord with aria-keyshortcuts", async () => {
    await openEdit();
    const keys = screen
      .getByRole("button", { name: /^save changes$/i })
      .getAttribute("aria-keyshortcuts");
    expect(keys).toBe("Control+Enter Meta+Enter");
  });
});

describe("Row 724: the trash button is 'Remove ...' in title and name", () => {
  it("title and aria-label are the same words, 'Remove Widget'", async () => {
    await openEdit();
    const trash = screen.getByRole("button", { name: "Remove Widget" });
    expect(trash).toHaveAttribute("title", "Remove Widget");
    expect(screen.queryByTitle("Delete item")).toBeNull();
  });
});
