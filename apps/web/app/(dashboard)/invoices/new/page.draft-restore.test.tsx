import * as React from "react";
import userEvent from "@testing-library/user-event";
import { act, renderWithProviders, screen, waitFor, within } from "@/test-utils/render";
import NewInvoicePage from "./page";
import { invoiceDraftKey } from "@/lib/invoice-draft-storage";

/**
 * ROW 447 — the in-progress new invoice survives a refresh. The draft lives in localStorage under a tenant + user
 * key; on return the page OFFERS "Restore unsaved invoice?" (never restores silently); Restore fills the form and the
 * totals are recomputed from the lines; Discard / a successful save clears it; broken storage changes nothing.
 */

window.HTMLElement.prototype.scrollIntoView = jest.fn();

jest.mock("next/navigation", () => ({
  useRouter: () => ({ push: jest.fn() }),
}));

let mockUser: Record<string, unknown> | null = null;
jest.mock("@/lib/auth-context", () => ({
  ...jest.requireActual("@/lib/auth-context"),
  useAuth: () => ({ user: mockUser, isAuthenticated: !!mockUser, isLoading: false }),
}));

let mockCustomers: Array<Record<string, unknown>> = [];
jest.mock("@/lib/api/customers", () => ({
  useCustomers: () => ({ data: { data: mockCustomers } }),
  useCustomerPrices: () => ({ data: [] }),
}));

const mockGet = jest.fn((url: string): Promise<{ data: unknown }> => {
  void url;
  return Promise.resolve({ data: {} });
});
jest.mock("@/lib/api/products", () => ({
  ...jest.requireActual("@/lib/api/products"),
  useProducts: () => ({ data: { data: [] } }),
  useCreateProduct: () => ({ mutate: jest.fn(), mutateAsync: jest.fn(), isPending: false }),
}));

const createInvoiceMutate = jest.fn();
jest.mock("@/lib/api/invoices", () => ({
  ...jest.requireActual("@/lib/api/invoices"),
  useCreateInvoice: () => ({ mutate: createInvoiceMutate, isPending: false }),
  useUpdateInvoice: () => ({ mutate: jest.fn(), isPending: false }),
  useCreateInvoiceFromOrder: () => ({ mutate: jest.fn(), isPending: false }),
  useInvoiceSettings: () => ({ data: undefined }),
}));

const createSaleMutate = jest.fn();
jest.mock("@/lib/api/orders", () => ({
  ...jest.requireActual("@/lib/api/orders"),
  useCreateSale: () => ({ mutate: createSaleMutate, isPending: false }),
  useUninvoicedOrders: () => ({ orders: [], isLoading: false }),
}));

jest.mock("@/lib/api/margin", () => ({
  useMarginConfig: () => ({ data: undefined }),
  floorForCategory: () => null,
}));
jest.mock("@/lib/api/tracked-categories", () => ({
  useTrackedCategories: () => ({ data: [] }),
}));

jest.mock("@/lib/api-client", () => ({
  apiClient: {
    get: (url: string) => mockGet(url),
    post: jest.fn().mockResolvedValue({ data: {} }),
    patch: jest.fn(),
    delete: jest.fn(),
  },
}));
jest.mock("@/components/BarcodeScannerButton", () => ({ BarcodeScannerButton: () => null }));
jest.mock("@/components/InlineCreateProductModal", () => ({
  InlineCreateProductModal: () => null,
}));

const KEY = invoiceDraftKey("acme", "user-1")!;
const NOW = Date.now();

function snapshot(over: Record<string, unknown> = {}) {
  return {
    basis: "standalone",
    customer: { id: "cust-1", businessName: "Acme Co" },
    reference: "PO-77",
    subject: "",
    terms: "",
    issueDate: "2026-10-13",
    dueDate: "2026-11-12",
    dueDateEdited: false,
    termsText: "",
    notes: "",
    deliveredNow: true,
    deliveredOn: "2026-10-13",
    depositOpen: false,
    depositPercent: null,
    depositDueDate: "",
    adjustment: 0,
    lines: [
      {
        productId: "p-1",
        description: "Widget",
        qty: 3,
        unitPrice: 10,
        discount: 0,
        taxable: false,
      },
    ],
    ...over,
  };
}

function seed(over: Record<string, unknown> = {}, savedAt = NOW - 5 * 60_000, key = KEY) {
  window.localStorage.setItem(
    key,
    JSON.stringify({ v: 1, savedAt, data: snapshot(over), total: 999 }),
  );
}

const footerTotal = () => screen.getByText("Total Amount").nextElementSibling?.textContent;
const stored = (key = KEY) => window.localStorage.getItem(key);

beforeEach(() => {
  jest.clearAllMocks();
  window.localStorage.clear();
  mockUser = { id: "user-1", role: "SUPER_ADMIN", tenantSlug: "acme" };
  mockCustomers = [{ id: "cust-1", businessName: "Acme Co" }];
  mockGet.mockImplementation(() => Promise.resolve({ data: {} }));
});
afterEach(() => jest.restoreAllMocks());

describe("ROW 447 — unsaved new-invoice draft", () => {
  it("offers to restore a stored draft, with customer, item count and age, and does NOT fill the form", async () => {
    seed();
    renderWithProviders(<NewInvoicePage />);
    expect(await screen.findByText("Restore unsaved invoice?")).toBeInTheDocument();
    expect(screen.getByText(/Acme Co/)).toBeInTheDocument();
    expect(screen.getByText(/1 item/)).toBeInTheDocument();
    expect(screen.getByText(/saved 5 min ago/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Restore" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Discard" })).toBeInTheDocument();
    // Nothing was applied: still the basis chooser, draft still stored.
    expect(screen.getByText("Create an invoice")).toBeInTheDocument();
    expect(stored()).not.toBeNull();
  });

  it("does not steal focus when the banner appears", async () => {
    seed();
    renderWithProviders(<NewInvoicePage />);
    await screen.findByText("Restore unsaved invoice?");
    expect(document.activeElement).toBe(document.body);
  });

  it("Restore fills the form and the total is recomputed from the lines, never from a stored total", async () => {
    seed({
      lines: [
        {
          productId: "p-1",
          description: "Widget",
          qty: 2,
          unitPrice: 12.5,
          discount: 0,
          taxable: false,
        },
      ],
    });
    const user = userEvent.setup();
    renderWithProviders(<NewInvoicePage />);
    await user.click(await screen.findByRole("button", { name: "Restore" }));
    expect(await screen.findByDisplayValue("Widget")).toBeInTheDocument();
    expect(screen.getByDisplayValue("PO-77")).toBeInTheDocument();
    expect(screen.getByText("Acme Co")).toBeInTheDocument();
    // 2 x 12.50 = 25.00, not the 999 planted beside the snapshot.
    expect(footerTotal()).toBe("$25.00");
    expect(screen.queryByText("Restore unsaved invoice?")).not.toBeInTheDocument();
    // Restore never submits anything.
    expect(createInvoiceMutate).not.toHaveBeenCalled();
    expect(createSaleMutate).not.toHaveBeenCalled();
  });

  it("restoring a new-sale draft opens the sale form", async () => {
    seed({ basis: "newSale" });
    const user = userEvent.setup();
    renderWithProviders(<NewInvoicePage />);
    await user.click(await screen.findByRole("button", { name: "Restore" }));
    expect(await screen.findByRole("heading", { name: "New sale" })).toBeInTheDocument();
    expect(footerTotal()).toBe("$30.00");
  });

  it("Discard clears the storage and removes the banner", async () => {
    seed();
    const user = userEvent.setup();
    renderWithProviders(<NewInvoicePage />);
    await user.click(await screen.findByRole("button", { name: "Discard" }));
    expect(screen.queryByText("Restore unsaved invoice?")).not.toBeInTheDocument();
    expect(stored()).toBeNull();
    expect(screen.getByText("Create an invoice")).toBeInTheDocument();
  });

  it("a successful Save as draft clears the stored draft", async () => {
    seed();
    const user = userEvent.setup();
    renderWithProviders(<NewInvoicePage />);
    await user.click(await screen.findByRole("button", { name: "Restore" }));
    await screen.findByDisplayValue("Widget");
    await user.click(screen.getByRole("button", { name: /save as draft/i }));
    await waitFor(() => expect(createInvoiceMutate).toHaveBeenCalled());
    expect(stored()).not.toBeNull(); // not cleared until the server says yes
    act(() => {
      createInvoiceMutate.mock.calls[0][1].onSuccess({ id: "inv-1", invoiceNumber: "INV-1" });
    });
    expect(stored()).toBeNull();
  });

  it("a successful new-sale create clears the stored draft", async () => {
    seed({ basis: "newSale" });
    const user = userEvent.setup();
    renderWithProviders(<NewInvoicePage />);
    await user.click(await screen.findByRole("button", { name: "Restore" }));
    await screen.findByDisplayValue("Widget");
    await user.click(screen.getByRole("button", { name: /create sale/i }));
    await waitFor(() => expect(createSaleMutate).toHaveBeenCalled());
    act(() => {
      createSaleMutate.mock.calls[0][1].onSuccess({ id: "inv-2" });
    });
    expect(stored()).toBeNull();
  });

  it("a failed save keeps the stored draft", async () => {
    seed();
    const user = userEvent.setup();
    renderWithProviders(<NewInvoicePage />);
    await user.click(await screen.findByRole("button", { name: "Restore" }));
    await screen.findByDisplayValue("Widget");
    await user.click(screen.getByRole("button", { name: /save as draft/i }));
    await waitFor(() => expect(createInvoiceMutate).toHaveBeenCalled());
    act(() => {
      createInvoiceMutate.mock.calls[0][1].onError(new Error("boom"));
    });
    expect(stored()).not.toBeNull();
  });

  it("a product that no longer exists is dropped with a visible note, not a crash", async () => {
    seed({
      lines: [
        {
          productId: "p-gone",
          description: "Old item",
          qty: 1,
          unitPrice: 5,
          discount: 0,
          taxable: false,
        },
        {
          productId: "p-1",
          description: "Widget",
          qty: 3,
          unitPrice: 10,
          discount: 0,
          taxable: false,
        },
      ],
    });
    mockGet.mockImplementation((url: string) =>
      url === "/products/p-gone"
        ? Promise.reject({ response: { status: 404 } })
        : Promise.resolve({ data: {} }),
    );
    const user = userEvent.setup();
    renderWithProviders(<NewInvoicePage />);
    await user.click(await screen.findByRole("button", { name: "Restore" }));
    expect(await screen.findByDisplayValue("Widget")).toBeInTheDocument();
    expect(screen.queryByDisplayValue("Old item")).not.toBeInTheDocument();
    expect(
      screen.getByText(/1 item is no longer in your catalog and was left out/),
    ).toBeInTheDocument();
    expect(footerTotal()).toBe("$30.00");
  });

  it("a customer that no longer exists is cleared with a visible note", async () => {
    seed();
    mockGet.mockImplementation((url: string) =>
      url === "/customers/cust-1"
        ? Promise.reject({ response: { status: 404 } })
        : Promise.resolve({ data: {} }),
    );
    const user = userEvent.setup();
    renderWithProviders(<NewInvoicePage />);
    await user.click(await screen.findByRole("button", { name: "Restore" }));
    expect(await screen.findByDisplayValue("Widget")).toBeInTheDocument();
    expect(screen.queryByText("Acme Co")).not.toBeInTheDocument();
    expect(screen.getByText(/customer is no longer available/i)).toBeInTheDocument();
  });

  it("a network failure while checking keeps the draft as stored", async () => {
    seed();
    mockGet.mockImplementation((url: string) =>
      url.startsWith("/products/") || url.startsWith("/customers/")
        ? Promise.reject(new Error("offline"))
        : Promise.resolve({ data: {} }),
    );
    const user = userEvent.setup();
    renderWithProviders(<NewInvoicePage />);
    await user.click(await screen.findByRole("button", { name: "Restore" }));
    expect(await screen.findByDisplayValue("Widget")).toBeInTheDocument();
    expect(screen.getByText("Acme Co")).toBeInTheDocument();
  });

  it("while the offer is open, typing in a fresh form does not overwrite the stored draft", async () => {
    seed({ reference: "ORIGINAL" });
    const user = userEvent.setup();
    renderWithProviders(<NewInvoicePage />);
    await screen.findByText("Restore unsaved invoice?");
    await user.click(screen.getByRole("button", { name: /other charge/i }));
    await user.type(screen.getByPlaceholderText(/PO-1234/), "NEW");
    await act(() => new Promise((r) => setTimeout(r, 800)));
    expect(JSON.parse(stored()!).data.reference).toBe("ORIGINAL");
  });

  it("writes a debounced snapshot as the user types, and no totals", async () => {
    const user = userEvent.setup();
    renderWithProviders(<NewInvoicePage />);
    await user.click(screen.getByRole("button", { name: /other charge/i }));
    await user.type(screen.getByPlaceholderText(/PO-1234/), "PO-9");
    expect(stored()).toBeNull(); // debounced, not per keystroke
    await waitFor(() => expect(stored()).not.toBeNull(), { timeout: 2000 });
    const json = stored()!;
    expect(JSON.parse(json).data.reference).toBe("PO-9");
    expect(json).not.toMatch(/total|subtotal|grand/i);
  });

  it("a pristine form writes nothing", async () => {
    const user = userEvent.setup();
    renderWithProviders(<NewInvoicePage />);
    await user.click(screen.getByRole("button", { name: /other charge/i }));
    await act(() => new Promise((r) => setTimeout(r, 800)));
    expect(window.localStorage.length).toBe(0);
  });

  it("another user's or tenant's draft is not offered", async () => {
    seed({}, NOW - 60_000, invoiceDraftKey("acme", "user-2")!);
    seed({}, NOW - 60_000, invoiceDraftKey("globex", "user-1")!);
    renderWithProviders(<NewInvoicePage />);
    await screen.findByText("Create an invoice");
    await act(() => new Promise((r) => setTimeout(r, 100)));
    expect(screen.queryByText("Restore unsaved invoice?")).not.toBeInTheDocument();
  });

  it("without a tenant or user nothing is read or written", async () => {
    seed();
    mockUser = { id: "user-1", role: "SUPER_ADMIN", tenantSlug: null };
    const user = userEvent.setup();
    renderWithProviders(<NewInvoicePage />);
    await screen.findByText("Create an invoice");
    expect(screen.queryByText("Restore unsaved invoice?")).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: /other charge/i }));
    await user.type(screen.getByPlaceholderText(/PO-1234/), "X");
    await act(() => new Promise((r) => setTimeout(r, 800)));
    expect(JSON.parse(stored()!).data.reference).toBe("PO-77");
  });

  it("an expired draft is not offered and is cleared", async () => {
    seed({}, NOW - 15 * 24 * 3600 * 1000);
    renderWithProviders(<NewInvoicePage />);
    await screen.findByText("Create an invoice");
    await waitFor(() => expect(stored()).toBeNull());
    expect(screen.queryByText("Restore unsaved invoice?")).not.toBeInTheDocument();
  });

  it("storage that throws on get and set: the page renders and works, no banner, no error toast", async () => {
    // Only the draft's own key is broken: the rest of the app (auth, i18n) keeps its working storage.
    const proto = Storage.prototype;
    const real = {
      get: proto.getItem,
      set: proto.setItem,
      remove: proto.removeItem,
    };
    const mine = (k: string) => k.startsWith("rf.invoice-draft");
    jest.spyOn(proto, "getItem").mockImplementation(function (this: Storage, k: string) {
      if (mine(k)) throw new Error("blocked");
      return real.get.call(this, k);
    });
    jest.spyOn(proto, "setItem").mockImplementation(function (this: Storage, k: string, v: string) {
      if (mine(k)) throw new DOMException("full", "QuotaExceededError");
      real.set.call(this, k, v);
    });
    jest.spyOn(proto, "removeItem").mockImplementation(function (this: Storage, k: string) {
      if (mine(k)) throw new Error("blocked");
      real.remove.call(this, k);
    });
    const user = userEvent.setup();
    renderWithProviders(<NewInvoicePage />);
    await user.click(screen.getByRole("button", { name: /other charge/i }));
    await user.type(screen.getByPlaceholderText(/PO-1234/), "PO-5");
    await act(() => new Promise((r) => setTimeout(r, 800)));
    expect(screen.getByPlaceholderText(/PO-1234/)).toHaveValue("PO-5");
    expect(screen.queryByText("Restore unsaved invoice?")).not.toBeInTheDocument();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("the banner is a polite, keyboard-reachable status region with fixed copy", async () => {
    seed();
    renderWithProviders(<NewInvoicePage />);
    const region = await screen.findByRole("region", { name: "Unsaved invoice" });
    expect(within(region).getByRole("status")).toHaveAttribute("aria-live", "polite");
    expect(within(region).getAllByRole("button")).toHaveLength(2);
  });
});
