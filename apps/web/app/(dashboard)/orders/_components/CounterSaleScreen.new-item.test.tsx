import * as React from "react";
import userEvent from "@testing-library/user-event";
import { renderWithProviders, screen, waitFor, fireEvent, within } from "@/test-utils/render";
import { apiClient } from "@/lib/api-client";
import { CounterSaleScreen } from "./CounterSaleScreen";

/**
 * W-1042 (SA-1062 MUSTs 9-14a): a new item at the counter. Nothing opens by itself: an unknown scan's miss line and the
 * live list's "No items match." each carry a Create button. A new item needs EDIT_LINE_PRICE and a price above $0; a
 * business with tracked categories is asked "licensed or regulated?" first and Yes stops. Save adds ONE line of 1.
 * The API is mocked at apiClient; the scan ladder, the product create hook and the modal are the real ones.
 */

let mockRole = "TENANT_ADMIN";
let mockDenied: string[] = [];
jest.mock("@/lib/auth-context", () => ({
  ...jest.requireActual("@/lib/auth-context"),
  useOptionalAuth: () => ({ user: { id: "u-a", role: mockRole, tenantSlug: "acme" } }),
}));
jest.mock("next/navigation", () => ({
  useRouter: () => ({ push: jest.fn(), replace: jest.fn() }),
}));
jest.mock("@/lib/api/customers", () => ({
  useCustomers: () => ({ data: { data: [] } }),
  useCustomerPrices: () => ({
    data: [],
    isSuccess: true,
    isError: false,
    isFetching: false,
    refetch: jest.fn(),
  }),
}));
jest.mock("@/lib/api-client", () => ({ apiClient: { get: jest.fn(), post: jest.fn() } }));
jest.mock("@/lib/api/counter-sale", () => ({
  useCounterSaleGate: () => ({
    showButton: true,
    opensAsCounter: true,
    offerShipInstead: false,
    capability: { counter: "always" },
    deniedGroups: mockDenied,
  }),
  useCreateCounterSale: () => ({ mutateAsync: jest.fn(), isPending: false }),
  useCounterSaleByKey: () => ({ mutateAsync: jest.fn(), isPending: false }),
}));

const TOBACCO = { id: "tc-1", name: "Regulated goods", active: true };
let tracked: Array<Record<string, unknown>> = [];
let created: Record<string, any> | null = null;
let lookupFails = false;
let postError: unknown = null;
const posts: Array<Record<string, unknown>> = [];
const MISS = "200000009999";

beforeEach(() => {
  jest.clearAllMocks();
  window.localStorage.clear();
  window.sessionStorage.clear();
  mockRole = "TENANT_ADMIN";
  mockDenied = [];
  tracked = [];
  created = null;
  lookupFails = false;
  postError = null;
  posts.length = 0;
  (apiClient.get as jest.Mock).mockImplementation(async (url: string, cfg?: any) => {
    if (url === "/settings") return { data: { taxRate: 0 } };
    if (url === "/tracked-categories") return { data: tracked };
    if (url === "/products/categories") return { data: [] };
    if (url.startsWith("/products/barcode/")) {
      if (lookupFails) return Promise.reject({ response: { status: 500 } });
      const code = decodeURIComponent(url.slice("/products/barcode/".length));
      return created && created.sku === code
        ? { data: created }
        : Promise.reject({ response: { status: 404 } });
    }
    if (url === "/products") {
      const code = cfg?.params?.scanCode ?? cfg?.params?.search;
      return { data: { data: created && created.sku === code ? [created] : [] } };
    }
    throw new Error(`unexpected GET ${url}`);
  });
  (apiClient.post as jest.Mock).mockImplementation(async (url: string, body: any) => {
    if (url !== "/products") throw new Error(`unexpected POST ${url}`);
    posts.push(body);
    if (postError) throw postError;
    created = {
      id: "p-new",
      name: body.name,
      sku: body.sku,
      unit: body.unit,
      pricePerUnit: body.pricePerUnit,
      unitsPerBox: null,
      isActive: true,
    };
    return { data: created };
  });
});

const field = () => screen.getByLabelText("Scan or search items") as HTMLInputElement;
const submitScan = (text: string) => {
  fireEvent.change(field(), { target: { value: text } });
  fireEvent.submit(field().closest("form")!);
};
const lines = () =>
  within(screen.getByRole("list", { name: "Items" }))
    .queryAllByRole("listitem")
    .filter((li) => li.textContent !== "No items yet.");
const createItem = () => screen.queryByRole("button", { name: "Create item" });
const openDialog = () =>
  document.querySelector('[data-scan-pause],[role="dialog"][data-state="open"]');
const nameInput = () => screen.getByPlaceholderText("e.g. Sourdough Bread") as HTMLInputElement;
const skuInput = () => screen.getByPlaceholderText("Scan or type") as HTMLInputElement;
const unitInput = () => screen.getByPlaceholderText("e.g. case, kg, unit") as HTMLInputElement;
const priceInput = () => screen.getByPlaceholderText("0.00") as HTMLInputElement;
const saveButton = () =>
  screen.getByRole("button", { name: /create product/i }) as HTMLButtonElement;

async function missThenCreate() {
  renderWithProviders(<CounterSaleScreen />);
  submitScan(MISS);
  await screen.findByText(`No product for '${MISS}'`);
  await waitFor(() => expect(createItem()).not.toBeNull());
  fireEvent.click(createItem()!);
}
async function fillAndSave(name = "Fresh Pie", price = "4.5") {
  await screen.findByRole("heading", { name: "New product" });
  fireEvent.change(nameInput(), { target: { value: name } });
  fireEvent.change(unitInput(), { target: { value: "each" } });
  fireEvent.change(priceInput(), { target: { value: price } });
  fireEvent.submit(saveButton().closest("form")!);
}

describe("W-1042 the miss line", () => {
  it("R6: an unknown scan that is a final not-found carries a Create item button", async () => {
    renderWithProviders(<CounterSaleScreen />);
    submitScan(MISS);
    await screen.findByText(`No product for '${MISS}'`);
    expect(createItem()).not.toBeNull();
  });

  it("R6 guard: the window never opens by itself and the cursor stays in the scan field", async () => {
    renderWithProviders(<CounterSaleScreen />);
    field().focus();
    submitScan(MISS);
    await screen.findByText(`No product for '${MISS}'`);
    await waitFor(() => expect(document.activeElement).toBe(field()));
    expect(openDialog()).toBeNull();
    expect(screen.queryByText("New product")).toBeNull();
  });

  it("R6: Create item opens the window with the scanned code in SKU", async () => {
    await missThenCreate();
    await screen.findByRole("heading", { name: "New product" });
    expect(skuInput().value).toBe(MISS);
    expect(nameInput().value).toBe("");
  });

  it("R7 guard: a lookup failure shows the failure panel and no Create item", async () => {
    lookupFails = true;
    renderWithProviders(<CounterSaleScreen />);
    submitScan(MISS);
    await screen.findByTestId("counter-scan-error");
    expect(createItem()).toBeNull();
  });

  it("R9 guard: a price-denied operator gets no Create item on a miss", async () => {
    mockRole = "OPERATOR";
    mockDenied = ["PRICING"];
    renderWithProviders(<CounterSaleScreen />);
    submitScan(MISS);
    await screen.findByText(`No product for '${MISS}'`);
    expect(createItem()).toBeNull();
  });
});

describe("W-1042 the live list", () => {
  it('"No items match." carries Create "<typed>" and the typed text goes to the name', async () => {
    renderWithProviders(<CounterSaleScreen />);
    fireEvent.change(field(), { target: { value: "fresh pie" } });
    await screen.findByText("No items match.");
    const btn = screen.queryByRole("button", { name: 'Create "fresh pie"' });
    expect(btn).not.toBeNull();
    fireEvent.click(btn!);
    await screen.findByRole("heading", { name: "New product" });
    expect(nameInput().value).toBe("fresh pie");
    expect(skuInput().value).toBe("");
  });

  it("R9 guard: a price-denied operator gets no Create button under No items match", async () => {
    mockRole = "OPERATOR";
    mockDenied = ["PRICING"];
    renderWithProviders(<CounterSaleScreen />);
    fireEvent.change(field(), { target: { value: "fresh pie" } });
    await screen.findByText("No items match.");
    expect(screen.queryByRole("button", { name: /^Create/ })).toBeNull();
  });
});

describe("W-1042 save, then scan again", () => {
  it("R5 + R8: blank price cannot save; Save adds ONE line of 1, the cursor returns, the next scan adds to it", async () => {
    await missThenCreate();
    await screen.findByRole("heading", { name: "New product" });
    fireEvent.change(nameInput(), { target: { value: "Fresh Pie" } });
    fireEvent.change(unitInput(), { target: { value: "each" } });
    expect(saveButton().disabled).toBe(true);
    fireEvent.change(priceInput(), { target: { value: "4.5" } });
    expect(saveButton().disabled).toBe(false);
    fireEvent.submit(saveButton().closest("form")!);
    await waitFor(() => expect(lines()).toHaveLength(1));
    expect(posts).toHaveLength(1);
    expect(posts[0]).toMatchObject({ name: "Fresh Pie", sku: MISS, pricePerUnit: "4.5" });
    expect(lines()[0]).toHaveTextContent("Fresh Pie");
    expect(lines()[0]).not.toHaveTextContent("× 2");
    expect(openDialog()).toBeNull();
    await waitFor(() => expect(document.activeElement).toBe(field()));
    submitScan(MISS);
    await waitFor(() => expect(lines()[0]).toHaveTextContent("× 2"));
    expect(lines()).toHaveLength(1);
  });

  it("R12: a code held by another active item stays in the window with a message, and no line is added", async () => {
    postError = { response: { status: 400, data: { code: "PRODUCT_CODE_IN_USE", field: "sku" } } };
    await missThenCreate();
    await fillAndSave();
    const alert = await screen.findByText("That code is already used by another item.");
    expect(alert.closest("[role='alert']")).not.toBeNull();
    expect(openDialog()).not.toBeNull();
    expect(lines()).toHaveLength(0);
  });

  it("R4-style guard: Cancel closes the window and leaves the cart alone", async () => {
    await missThenCreate();
    await screen.findByRole("heading", { name: "New product" });
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(openDialog()).toBeNull();
    expect(posts).toHaveLength(0);
    expect(lines()).toHaveLength(0);
  });
});

describe("W-1042 MUST 12: regulated goods", () => {
  it("R10: a tracked business is asked first, and Yes stops: nothing is created, the cart stays", async () => {
    tracked = [TOBACCO];
    await missThenCreate();
    await screen.findByText("Is this a licensed or regulated item?");
    expect(screen.queryByRole("heading", { name: "New product" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Yes" }));
    expect(
      screen.queryByText("Add it from Products, so its category and tax are set."),
    ).not.toBeNull();
    const link = screen.getByRole("link", { name: /products/i });
    expect(link.getAttribute("href")).toBe("/products");
    expect(link.getAttribute("target")).toBe("_blank");
    expect(screen.queryByRole("heading", { name: "New product" })).toBeNull();
    expect(posts).toHaveLength(0);
    expect(lines()).toHaveLength(0);
  });

  it("R10: No continues to the New product window", async () => {
    tracked = [TOBACCO];
    await missThenCreate();
    await screen.findByText("Is this a licensed or regulated item?");
    fireEvent.click(screen.getByRole("button", { name: "No" }));
    await screen.findByRole("heading", { name: "New product" });
    expect(skuInput().value).toBe(MISS);
  });

  it("R11: a business with no tracked categories never sees the question", async () => {
    tracked = [];
    await missThenCreate();
    await screen.findByRole("heading", { name: "New product" });
    expect(screen.queryByText("Is this a licensed or regulated item?")).toBeNull();
  });
});

describe("W-1042 MUST 14a at the screen: the counter holds scans while a window is open", () => {
  const paused = () => document.querySelector("[data-scan-pause]");

  it("R13: while the question and then the form are open, the scan pause is held; closing releases it", async () => {
    tracked = [TOBACCO];
    await missThenCreate();
    await screen.findByText("Is this a licensed or regulated item?");
    expect(paused()).not.toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "No" }));
    await screen.findByRole("heading", { name: "New product" }).catch(() => null);
    expect(paused()).not.toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(paused()).toBeNull();
  });

  it("R13: Esc closes the question, and the cart is untouched", async () => {
    tracked = [TOBACCO];
    await missThenCreate();
    await screen.findByText("Is this a licensed or regulated item?");
    fireEvent.keyDown(document.body, { key: "Escape" });
    expect(paused()).toBeNull();
    expect(posts).toHaveLength(0);
    expect(lines()).toHaveLength(0);
  });

  it("R13e: with the question open and the cursor in the scan box, a scan adds no line and clears the box; after Esc the same scan adds it", async () => {
    tracked = [TOBACCO];
    await missThenCreate();
    await screen.findByText("Is this a licensed or regulated item?");
    created = {
      id: "p-cola",
      name: "Sample Cola",
      sku: "200000000001",
      unit: "each",
      pricePerUnit: 2.5,
      unitsPerBox: null,
      isActive: true,
    };
    field().focus();
    submitScan("200000000001");
    await new Promise((r) => setTimeout(r, 80));
    expect(lines()).toHaveLength(0);
    expect(field().value).toBe("");
    fireEvent.keyDown(document.body, { key: "Escape" });
    expect(openDialog()).toBeNull();
    submitScan("200000000001");
    await waitFor(() => expect(lines()).toHaveLength(1));
    expect(lines()[0]).toHaveTextContent("Sample Cola");
  });

  it("R13a: focus on a button, a re-arm fires, then a wedge scan: focus stays out of the scan box and no line is added", async () => {
    await missThenCreate();
    await waitFor(() => expect(paused()).not.toBeNull());
    const button = screen.getByRole("button", { name: "Cancel" });
    button.focus();
    fireEvent.blur(field()); // the scan box losing focus asks for a re-arm
    submitScan("200000008888"); // a scan while the window is open is dropped
    await new Promise((r) => setTimeout(r, 80));
    expect(document.activeElement).toBe(button);
    await userEvent.keyboard("200000008888{Enter}");
    await new Promise((r) => setTimeout(r, 80));
    expect(field().value).toBe("");
    expect(lines()).toHaveLength(0);
  });
});

describe("SA-1066 F10: the regulated question takes focus on its box, never a button, and has Cancel", () => {
  const box = () => screen.getByRole("dialog").firstElementChild as HTMLElement;
  const COLA_ROW = {
    id: "p-cola",
    name: "Sample Cola",
    sku: "200000000001",
    unit: "each",
    pricePerUnit: 2.5,
    unitsPerBox: null,
    isActive: true,
  };

  it("R10: opening moves focus into the dialog box (tabIndex -1), not onto a button", async () => {
    tracked = [TOBACCO];
    await missThenCreate();
    await screen.findByText("Is this a licensed or regulated item?");
    expect(document.activeElement).toBe(box());
    expect(box()).toHaveAttribute("tabindex", "-1");
    expect(document.activeElement?.tagName).not.toBe("BUTTON");
  });

  it("R10: the step change (Yes) puts focus back on the box, still not a button", async () => {
    tracked = [TOBACCO];
    await missThenCreate();
    await screen.findByText("Is this a licensed or regulated item?");
    fireEvent.click(screen.getByRole("button", { name: "Yes" }));
    await screen.findByText("Add it from Products, so its category and tax are set.");
    expect(document.activeElement).toBe(box());
  });

  it("R10: the question has a Cancel that closes it like Esc, leaving the cart alone", async () => {
    tracked = [TOBACCO];
    await missThenCreate();
    await screen.findByText("Is this a licensed or regulated item?");
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(openDialog()).toBeNull();
    expect(posts).toHaveLength(0);
    expect(lines()).toHaveLength(0);
  });

  it("R10a: a wedge code and its Enter while the question is open add no line and press no answer", async () => {
    tracked = [TOBACCO];
    await missThenCreate();
    await screen.findByText("Is this a licensed or regulated item?");
    await userEvent.keyboard("200000008888{Enter}");
    await new Promise((r) => setTimeout(r, 80));
    expect(lines()).toHaveLength(0);
    expect(screen.queryByText("Is this a licensed or regulated item?")).not.toBeNull();
    expect(screen.queryByRole("heading", { name: "New product" })).toBeNull();
    expect(screen.queryByText("Add it from Products, so its category and tax are set.")).toBeNull();
  });

  it("R10b: a re-arm that fires while the question is open leaves focus on the box", async () => {
    tracked = [TOBACCO];
    await missThenCreate();
    await screen.findByText("Is this a licensed or regulated item?");
    fireEvent.blur(field());
    await new Promise((r) => setTimeout(r, 80));
    expect(document.activeElement).toBe(box());
  });

  it("R10c: Cancel, then the same scan adds a line", async () => {
    tracked = [TOBACCO];
    await missThenCreate();
    await screen.findByText("Is this a licensed or regulated item?");
    created = COLA_ROW;
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    submitScan("200000000001");
    await waitFor(() => expect(lines()).toHaveLength(1));
    expect(lines()[0]).toHaveTextContent("Sample Cola");
  });
});

describe("SA-1066 F11: the dim layer fills the screen under a space-y parent", () => {
  // `[data-scan-pause]` is fixed inset-0 but sits in a space-y-4 column, which gives it margin-top 16px: a white strip.
  it("the question's overlay root has no top margin", async () => {
    tracked = [TOBACCO];
    await missThenCreate();
    await screen.findByText("Is this a licensed or regulated item?");
    expect(openDialog()?.className).toMatch(/(^|\s)!mt-0(\s|$)/);
  });

  it("the New product window's overlay root has no top margin either", async () => {
    await missThenCreate();
    await screen.findByRole("heading", { name: "New product" });
    expect(openDialog()?.className).toMatch(/(^|\s)!mt-0(\s|$)/);
  });
});

describe("SA-1066 F14: Open Products reads white on a darker teal", () => {
  it("the link is bg-brand-600, not the lighter bg-brand-500", async () => {
    tracked = [TOBACCO];
    await missThenCreate();
    await screen.findByText("Is this a licensed or regulated item?");
    fireEvent.click(screen.getByRole("button", { name: "Yes" }));
    const link = screen.getByRole("link", { name: /open products/i });
    expect(link.className).toMatch(/(^|\s)bg-brand-600(\s|$)/);
    expect(link.className).not.toMatch(/bg-brand-500/);
  });
});
