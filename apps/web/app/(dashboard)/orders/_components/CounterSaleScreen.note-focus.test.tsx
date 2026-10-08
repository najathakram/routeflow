import * as React from "react";
import userEvent from "@testing-library/user-event";
import { renderWithProviders, screen, waitFor, fireEvent } from "@/test-utils/render";
import { createNavShortcutHandler } from "@/lib/nav-shortcuts";
import { CounterSaleScreen } from "./CounterSaleScreen";

/**
 * Typing a line note on the counter must never reach the shell's "g" page shortcuts ("gift wrap" -> g i = Invoices, and the
 * cart is gone). (1) Opening the note puts focus IN the note field. (2) While the cart has lines the g-sequences are off
 * whatever has focus. The shell's real handler (lib/nav-shortcuts) is attached to window here, exactly as the layout does.
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
jest.mock("@/lib/api/counter-sale", () => ({
  useCounterSaleGate: () => ({
    showButton: true,
    opensAsCounter: true,
    offerShipInstead: true,
    capability: { counter: "always", methods: ["SHIP"], staffDefault: "SHIP" },
  }),
  useCreateCounterSale: () => ({ mutateAsync: jest.fn(), isPending: false }),
  useCounterSaleByKey: () => ({ mutateAsync: jest.fn(), isPending: false }),
}));

const navigate = jest.fn();
let detach: () => void = () => undefined;

beforeEach(() => {
  jest.clearAllMocks();
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

describe("counter line note: focus and the g-shortcuts", () => {
  it("Add note puts focus in the note field; typing 'g i' stays in the note and goes nowhere", async () => {
    const user = userEvent.setup();
    renderWithProviders(<CounterSaleScreen />);
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
    // the cart is still there
    expect(screen.getByText(/Cola · /)).toBeInTheDocument();
  });

  it("with lines in the cart and focus on the page, g then i does not navigate", async () => {
    renderWithProviders(<CounterSaleScreen />);
    await scan("COLA");

    (document.activeElement as HTMLElement | null)?.blur();
    expect(document.activeElement).toBe(document.body);
    fireEvent.keyDown(document.body, { key: "g" });
    fireEvent.keyDown(document.body, { key: "i" });

    expect(navigate).not.toHaveBeenCalled();
    expect(push).not.toHaveBeenCalled();
    expect(screen.getByText(/Cola · /)).toBeInTheDocument();
  });

  it("control: with no cart on screen the same keys DO navigate (the shortcut itself still works)", () => {
    fireEvent.keyDown(document.body, { key: "g" });
    fireEvent.keyDown(document.body, { key: "i" });
    expect(navigate).toHaveBeenCalledWith("/invoices");
  });

  it("control: an empty counter cart does not hold the shortcuts off", async () => {
    renderWithProviders(<CounterSaleScreen />);
    expect(screen.getByTestId("counter-sale-screen")).not.toHaveAttribute(
      "data-nav-shortcuts-suspended",
    );
    await scan("COLA");
    expect(screen.getByTestId("counter-sale-screen")).toHaveAttribute(
      "data-nav-shortcuts-suspended",
      "true",
    );
  });
});
