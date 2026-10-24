import * as React from "react";
import { act } from "@testing-library/react";
import { renderWithProviders, screen, waitFor, fireEvent } from "@/test-utils/render";
import { renderTill } from "@/test-utils/render-till";
import { COUNTER_OFFLINE_COPY } from "@/lib/counter-sale";
import { CounterSaleScreen } from "./CounterSaleScreen";

/**
 * Counter audit, batch "register and payment" (538 re-check F02, F04, F07, vital-few #7, rows 188 and 240): the scan field
 * has an edge, the hint under it names the next key, the customer list names its keys, an offline Complete leaves the cursor
 * on the way out, a short cash tender says how short while it is typed, and "New customer" creates a customer in place.
 */

jest.mock("@/lib/auth-context", () => ({
  ...jest.requireActual("@/lib/auth-context"),
  useOptionalAuth: () => ({ user: { id: "u-a", tenantSlug: "acme", role: "OPERATOR" } }),
}));
jest.mock("next/navigation", () => ({
  useRouter: () => ({ push: jest.fn(), replace: jest.fn() }),
}));

const COLA = { id: "p-cola", name: "Cola", pricePerUnit: 2.5, unit: "each", unitsPerBox: null };
jest.mock("@/lib/barcode-resolve", () => ({
  ...jest.requireActual("@/lib/barcode-resolve"),
  resolveProductByCode: async (code: string) =>
    code === "COLA" ? { product: COLA, source: "sku" } : { notFound: true },
}));
let customersFor: unknown[] = [];
jest.mock("@/lib/api/customers", () => ({
  useCustomers: () => ({ data: { data: customersFor } }),
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
const mutateAsync = jest.fn();
jest.mock("@/lib/api/counter-sale", () => ({
  useCounterSaleGate: () => ({
    showButton: true,
    opensAsCounter: true,
    offerShipInstead: false,
    capability: { counter: "always" },
  }),
  useCreateCounterSale: () => ({ mutateAsync, isPending: false }),
  useCounterSaleByKey: () => ({ mutateAsync: jest.fn(), isPending: false }),
}));
// The real form is covered by its own tests; this stand-in keeps its contract: it gets the typed name, and a create is a
// react-query mutation (the real one is useCreateCustomer) whose success closes the form.
jest.mock("../../customers/_components/CustomerFormModal", () => ({
  // The real form's contract (row 240): add mode starts from `prefillName` and hands the created customer to `onCreated`.
  CustomerFormModal: ({
    isOpen,
    onClose,
    prefillName,
    onCreated,
  }: {
    isOpen: boolean;
    onClose: () => void;
    prefillName?: string;
    onCreated?: (c: { id: string; businessName: string }) => void;
  }) => {
    if (!isOpen) return null;
    return (
      <div role="dialog" aria-label="New customer form">
        <span data-testid="prefill">{prefillName}</span>
        <button
          type="button"
          onClick={() => {
            onCreated?.({ id: "c-new", businessName: prefillName ?? "" });
            onClose();
          }}
        >
          Save customer
        </button>
        <button type="button" onClick={onClose}>
          Cancel
        </button>
      </div>
    );
  },
}));

let online = true;
beforeEach(() => {
  jest.clearAllMocks();
  window.localStorage.clear();
  window.sessionStorage.clear();
  customersFor = [];
  online = true;
  Object.defineProperty(window.navigator, "onLine", { configurable: true, get: () => online });
  let n = 0;
  Object.defineProperty(globalThis.crypto, "randomUUID", {
    configurable: true,
    value: () => `key-${++n}`,
  });
});
afterEach(() => {
  delete (window.navigator as unknown as Record<string, unknown>).onLine;
});

const scanField = () => screen.getByLabelText("Scan or search items") as HTMLInputElement;
const scan = async (text: string) => {
  fireEvent.change(scanField(), { target: { value: text } });
  fireEvent.submit(scanField().closest("form")!);
  await waitFor(() => expect(scanField().value).toBe(""));
  await screen.findByRole("button", { name: "Remove Cola" });
};

describe("vital-few #7: the sticky scan field has an edge", () => {
  it("the scan bar carries a bottom border so lines do not run under it", async () => {
    renderTill(<CounterSaleScreen />);
    expect(screen.getByTestId("counter-scan-bar").className).toMatch(/\bborder-b\b/);
  });
});

describe("F02: the hint under the scan field names the next key", () => {
  it("an empty cart keeps the multiply tip", () => {
    renderTill(<CounterSaleScreen />);
    expect(screen.getByTestId("scan-hint")).toHaveTextContent("Type a quantity first to multiply.");
  });

  it("with a line in the cart and an empty field it says Press Enter to pay", async () => {
    renderTill(<CounterSaleScreen />);
    await scan("COLA");
    expect(screen.getByTestId("scan-hint")).toHaveTextContent("Press Enter to pay.");
    expect(screen.getByTestId("scan-hint")).not.toHaveTextContent("multiply");
  });

  it("typing in the field brings the multiply tip back", async () => {
    renderTill(<CounterSaleScreen />);
    await scan("COLA");
    fireEvent.change(scanField(), { target: { value: "3" } });
    expect(screen.getByTestId("scan-hint")).toHaveTextContent("Type a quantity first to multiply.");
  });
});

describe("F04: the customer list names its keys", () => {
  it("shows the key hint while the list is open, and not when there is no list", () => {
    customersFor = [{ id: "c-acme", businessName: "Acme Cafe", pricingTier: 1, fulfillPath: null }];
    renderTill(<CounterSaleScreen />);
    expect(screen.queryByText(/to choose/)).toBeNull();
    fireEvent.change(screen.getByLabelText("Find a customer"), { target: { value: "ac" } });
    expect(screen.getByRole("listbox", { name: "Matching customers" })).toBeInTheDocument();
    expect(screen.getByText("↑↓ to choose · Enter to pick")).toBeInTheDocument();
  });
});

describe("F07: an offline Complete leaves the cursor on the way out", () => {
  it("focus lands on Complete, not on the scan field", async () => {
    mutateAsync.mockRejectedValueOnce({ code: "ERR_NETWORK", message: "Network Error" });
    renderTill(<CounterSaleScreen />);
    await scan("COLA");
    fireEvent.click(screen.getByRole("button", { name: "$20" }));
    online = false;
    const complete = screen.getByRole("button", { name: "Complete & show receipt" });
    fireEvent.click(complete);
    expect(await screen.findByRole("alert")).toHaveTextContent(COUNTER_OFFLINE_COPY);
    await waitFor(() => expect(document.activeElement).toBe(complete));
    // and it stays there: the scan field's own re-arm does not take it back a tick later
    await act(async () => {
      await new Promise((r) => setTimeout(r, 30));
    });
    expect(document.activeElement).toBe(complete);
  });

  it("Complete & next sale stays the focused one when that is the button that was pressed", async () => {
    mutateAsync.mockRejectedValueOnce({ code: "ERR_NETWORK", message: "Network Error" });
    renderTill(<CounterSaleScreen />);
    await scan("COLA");
    fireEvent.click(screen.getByRole("button", { name: "$20" }));
    online = false;
    const next = screen.getByRole("button", { name: "Complete & next sale" });
    fireEvent.click(next);
    await screen.findByRole("alert");
    await waitFor(() => expect(document.activeElement).toBe(next));
  });
});

describe("row 188: a short cash tender says how short while it is typed", () => {
  const tender = () => screen.getByLabelText("Amount tendered");

  it("shows the shortfall under the field and not as an alert", async () => {
    renderTill(<CounterSaleScreen />);
    await scan("COLA");
    expect(screen.queryByTestId("tender-short")).toBeNull();
    fireEvent.change(tender(), { target: { value: "1" } });
    expect(screen.getByTestId("tender-short")).toHaveTextContent("$1.50 short");
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("rounds to the cent and goes away at the total", async () => {
    renderTill(<CounterSaleScreen />);
    await scan("COLA");
    fireEvent.change(tender(), { target: { value: "2.499" } });
    expect(screen.queryByTestId("tender-short")).toBeNull();
    fireEvent.change(tender(), { target: { value: "2.4" } });
    expect(screen.getByTestId("tender-short")).toHaveTextContent("$0.10 short");
    fireEvent.change(tender(), { target: { value: "2.5" } });
    expect(screen.queryByTestId("tender-short")).toBeNull();
  });

  it("says nothing before anything is typed, and Complete still refuses with Enter at least", async () => {
    renderTill(<CounterSaleScreen />);
    await scan("COLA");
    expect(screen.queryByTestId("tender-short")).toBeNull();
    fireEvent.change(tender(), { target: { value: "1" } });
    fireEvent.click(screen.getByRole("button", { name: "Complete & show receipt" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Enter at least $2.50.");
  });
});

describe("row 240: a named customer is created from the counter", () => {
  it("New customer opens the existing form with the typed name, and the new customer becomes the buyer", async () => {
    renderWithProviders(<CounterSaleScreen />);
    fireEvent.change(screen.getByLabelText("Find a customer"), { target: { value: "Zed Cafe" } });
    fireEvent.click(screen.getByRole("button", { name: "New customer" }));
    expect(await screen.findByRole("dialog", { name: "New customer form" })).toBeInTheDocument();
    expect(screen.getByTestId("prefill")).toHaveTextContent("Zed Cafe");
    fireEvent.click(screen.getByRole("button", { name: "Save customer" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    const group = screen.getByTestId("counter-buyer-choice");
    expect(group).toHaveAttribute("data-kind", "customer");
    expect(group).toHaveTextContent("Zed Cafe");
    expect((screen.getByLabelText("Find a customer") as HTMLInputElement).value).toBe("");
  });

  it("closing the form without saving leaves the buyer unanswered", async () => {
    renderWithProviders(<CounterSaleScreen />);
    fireEvent.change(screen.getByLabelText("Find a customer"), { target: { value: "Zed Cafe" } });
    fireEvent.click(screen.getByRole("button", { name: "New customer" }));
    fireEvent.click(await screen.findByRole("button", { name: "Cancel" }));
    expect(screen.getByTestId("counter-buyer-choice")).toHaveAttribute("data-kind", "none");
  });
});
