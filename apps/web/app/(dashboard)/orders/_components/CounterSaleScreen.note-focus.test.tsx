import * as React from "react";
import userEvent from "@testing-library/user-event";
import { renderWithProviders, screen, waitFor, fireEvent } from "@/test-utils/render";
import { createNavShortcutHandler } from "@/lib/nav-shortcuts";
import { RegisterHeader } from "@/components/RegisterHeader";
import { CounterSaleScreen } from "./CounterSaleScreen";

/**
 * Typing a line note on the counter must never reach the shell's "g" page shortcuts ("gift wrap" -> g i = Invoices, and the
 * cart is gone). (1) Opening the note puts focus IN the note field. (2) With lines in the cart and focus NOT in a text field,
 * a g shortcut asks the shared leave guard: the same "Discard this sale?" dialog as every other way out (Discard goes once; a
 * sale being recorded is covered in lib/nav-shortcuts.test.ts); an empty cart navigates at once. The shell's real handler
 * (lib/nav-shortcuts, given the RAW push) is attached to window here, exactly as the layout does, with the real register
 * header beside the real CounterSaleScreen (the header renders the dialog).
 */

const push = jest.fn();
jest.mock("next/navigation", () => ({ useRouter: () => ({ push, replace: jest.fn() }) }));
jest.mock("@/lib/auth-context", () => ({
  ...jest.requireActual("@/lib/auth-context"),
  useOptionalAuth: () => ({ user: { id: "u-a", tenantSlug: "acme" } }),
}));
jest.mock("@/lib/api/drafts", () => ({
  useCreateDraft: () => ({ mutateAsync: jest.fn(), isPending: false }),
}));
const COLA = {
  id: "p-cola",
  name: "Cola",
  pricePerUnit: 2.5,
  unit: "each",
  unitsPerBox: null,
};
jest.mock("@/lib/barcode-resolve", () => ({
  ...jest.requireActual("@/lib/barcode-resolve"),
  resolveProductByCode: async (code: string) =>
    code === "COLA" ? { product: COLA, source: "sku" } : { notFound: true },
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
jest.mock("@/lib/api-client", () => ({
  apiClient: { get: jest.fn().mockResolvedValue({ data: { taxRate: 0 } }), post: jest.fn() },
}));
let mockSalePending = false;
jest.mock("@/lib/api/counter-sale", () => ({
  useCounterSaleGate: () => ({
    showButton: true,
    opensAsCounter: true,
    offerShipInstead: true,
    capability: { counter: "always", methods: ["SHIP"], staffDefault: "SHIP" },
  }),
  useCreateCounterSale: () => ({ mutateAsync: jest.fn(), isPending: mockSalePending }),
  useCounterSaleByKey: () => ({ mutateAsync: jest.fn(), isPending: false }),
}));

const navigate = jest.fn();
let detach: () => void = () => undefined;

/** The register header (it renders the Discard dialog) beside the real counter screen. */
const counter = () => (
  <>
    <RegisterHeader onOpenMobileNav={jest.fn()} />
    <CounterSaleScreen />
  </>
);

beforeEach(() => {
  jest.clearAllMocks();
  mockSalePending = false;
  window.localStorage.clear();
  window.sessionStorage.clear();
  const handler = createNavShortcutHandler({
    push: navigate,
    routesAccess: true,
    counterEnabled: true,
    toggleHelp: jest.fn(),
  });
  window.addEventListener("keydown", handler);
  detach = () => window.removeEventListener("keydown", handler);
});
afterEach(() => detach());

const scan = async (text: string) => {
  const field = screen.getByLabelText("Scan or search items");
  fireEvent.change(field, { target: { value: text } });
  fireEvent.submit(field.closest("form")!);
  await waitFor(() => expect((field as HTMLInputElement).value).toBe(""));
  await screen.findByRole("button", { name: "Add a note to Cola" });
};

const pressGI = () => {
  (document.activeElement as HTMLElement | null)?.blur(); // the screen may hand focus back to its scan field between presses
  fireEvent.keyDown(document.body, { key: "g" });
  fireEvent.keyDown(document.body, { key: "i" });
};

describe("counter line note: focus and the g-shortcuts", () => {
  it("Add note puts focus in the note field; typing 'g i' stays in the note and goes nowhere", async () => {
    const user = userEvent.setup();
    renderWithProviders(counter());
    await scan("COLA");

    await user.click(screen.getByRole("button", { name: "Add a note to Cola" }));
    const note = await screen.findByLabelText("Note for Cola");
    expect(note).toHaveFocus();
    // the scan field's focus-recovery timer must not take it back
    await new Promise((r) => setTimeout(r, 20));
    expect(note).toHaveFocus();

    await user.keyboard("g i");
    expect(note).toHaveValue("g i");
    expect(navigate).not.toHaveBeenCalled();
    expect(push).not.toHaveBeenCalled();
    expect(screen.queryByText("Discard this sale?")).toBeNull(); // typing opens no dialog either
    // the cart is still there
    expect(screen.getByText(/Cola · /)).toBeInTheDocument();
  });

  it("with lines in the cart and focus on the page, g then i opens the Discard dialog; Discard navigates once", async () => {
    renderWithProviders(counter());
    await scan("COLA");

    (document.activeElement as HTMLElement | null)?.blur();
    expect(document.activeElement).toBe(document.body);
    pressGI();

    expect(await screen.findByText("Discard this sale?")).toBeInTheDocument();
    expect(navigate).not.toHaveBeenCalled();
    expect(push).not.toHaveBeenCalled();
    expect(screen.getByText(/Cola · /)).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Discard" }));
    expect(navigate).toHaveBeenCalledTimes(1);
    expect(navigate).toHaveBeenCalledWith("/invoices");
    expect(push).not.toHaveBeenCalled();
    await waitFor(() => expect(screen.queryByText("Discard this sale?")).toBeNull());
  });

  it("Keep selling closes the dialog and the shortcut goes nowhere", async () => {
    renderWithProviders(counter());
    await scan("COLA");

    (document.activeElement as HTMLElement | null)?.blur();
    pressGI();
    await screen.findByText("Discard this sale?");

    fireEvent.click(screen.getByRole("button", { name: "Keep selling" }));

    await waitFor(() => expect(screen.queryByText("Discard this sale?")).toBeNull());
    expect(navigate).not.toHaveBeenCalled();
    expect(screen.getByText(/Cola · /)).toBeInTheDocument();
  });

  it("an empty cart: g then i navigates at once, with no dialog", () => {
    renderWithProviders(counter());
    expect(screen.getByTestId("counter-sale-screen")).toBeInTheDocument();

    (document.activeElement as HTMLElement | null)?.blur(); // the scan field holds focus on mount: a text field
    pressGI();

    expect(navigate).toHaveBeenCalledTimes(1);
    expect(navigate).toHaveBeenCalledWith("/invoices");
    expect(screen.queryByText("Discard this sale?")).toBeNull();
  });
});

describe("counter line note: the scan field is re-armed (SA-762r #8)", () => {
  const openNote = async (user: ReturnType<typeof userEvent.setup>) => {
    await user.click(screen.getByRole("button", { name: "Add a note to Cola" }));
    return screen.findByLabelText("Note for Cola");
  };

  it("Enter saves and closes the note, and the next keystrokes land in the scan field", async () => {
    const user = userEvent.setup();
    renderWithProviders(counter());
    await scan("COLA");
    const note = await openNote(user);
    await user.type(note, "gift wrap{Enter}");

    expect(screen.queryByLabelText("Note for Cola")).toBeNull();
    expect(screen.getByTestId("line-note")).toHaveTextContent("gift wrap");
    const scanField = screen.getByLabelText("Scan or search items");
    await waitFor(() => expect(scanField).toHaveFocus());
    await user.keyboard("0123");
    expect(scanField).toHaveValue("0123");
  });

  it("Escape cancels the edit (the note is as it was when the field opened) and re-arms the scan field", async () => {
    const user = userEvent.setup();
    renderWithProviders(counter());
    await scan("COLA");
    let note = await openNote(user);
    await user.type(note, "cold{Enter}");
    await user.click(screen.getByRole("button", { name: "Edit the note on Cola" }));
    note = await screen.findByLabelText("Note for Cola");
    await user.type(note, " extra{Escape}");

    expect(screen.queryByLabelText("Note for Cola")).toBeNull();
    expect(screen.getByTestId("line-note")).toHaveTextContent(/^cold$/);
    await waitFor(() => expect(screen.getByLabelText("Scan or search items")).toHaveFocus());
  });

  it("Clear note puts focus on the scan field (it was <body> when the note field unmounted)", async () => {
    const user = userEvent.setup();
    renderWithProviders(counter());
    await scan("COLA");
    const note = await openNote(user);
    await user.type(note, "cold");
    await user.click(screen.getByRole("button", { name: "Clear the note on Cola" }));

    expect(screen.queryByLabelText("Note for Cola")).toBeNull();
    expect(screen.queryByTestId("line-note")).toBeNull();
    await waitFor(() => expect(screen.getByLabelText("Scan or search items")).toHaveFocus());
  });

  it("while the note is open, a re-arm (a scan landing) never pulls the cursor out of it", async () => {
    const user = userEvent.setup();
    renderWithProviders(counter());
    await scan("COLA");
    const note = await openNote(user);
    await user.type(note, "abc");
    await new Promise((r) => setTimeout(r, 20));
    expect(note).toHaveFocus();
    expect(note).toHaveValue("abc");
  });

  it("the Undo chip vanishing while it holds focus hands the cursor back to the scan field", async () => {
    const user = userEvent.setup();
    renderWithProviders(counter());
    await scan("COLA");
    await user.click(screen.getByRole("button", { name: "Remove Cola" }));
    const undo = await screen.findByRole("button", { name: /Undo: put back Cola/ });
    undo.focus();
    await user.click(undo);
    expect(screen.queryByRole("button", { name: /Undo: put back/ })).toBeNull();
    await waitFor(() => expect(screen.getByLabelText("Scan or search items")).toHaveFocus());
  });
});
