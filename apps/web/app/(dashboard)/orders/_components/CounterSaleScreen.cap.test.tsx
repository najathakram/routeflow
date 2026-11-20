import * as React from "react";
import { fireEvent, renderWithProviders, screen, waitFor } from "@/test-utils/render";
import { CounterSaleScreen } from "./CounterSaleScreen";

/**
 * W-833: a scan that would push a line past 100,000 pieces is refused. The status bar must not say "Added" for it, the
 * refusal shows once, and the disabled "+" gives its reason.
 */
jest.mock("@/lib/auth-context", () => ({
  ...jest.requireActual("@/lib/auth-context"),
  useOptionalAuth: () => ({ user: { id: "u-a", tenantSlug: "acme" } }),
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

beforeEach(() => {
  jest.clearAllMocks();
  window.localStorage.clear();
  window.sessionStorage.clear();
  mutateAsync.mockResolvedValue({
    orderId: "o1",
    orderNumber: "ORD-1",
    invoiceId: "i1",
    invoiceNumber: "INV-1",
    total: 2.5,
    paid: 5,
    balanceDue: 0,
    change: 2.5,
    paymentRecorded: true,
  });
});

const scan = async (text: string) => {
  const field = screen.getByLabelText("Scan or search items");
  fireEvent.change(field, { target: { value: text } });
  fireEvent.submit(field.closest("form")!);
  await waitFor(() => expect((field as HTMLInputElement).value).toBe(""));
};
const CAP = "That is more than one line can hold. The most is 100,000 pieces.";

describe("CounterSaleScreen: the per-line cap on a scan (W-833)", () => {
  async function fillLine() {
    renderWithProviders(<CounterSaleScreen />);
    await scan("COLA");
    const qty = await screen.findByRole("spinbutton", { name: "Set quantity of Cola" });
    fireEvent.change(qty, { target: { value: "100000" } });
    fireEvent.blur(qty);
    await waitFor(() => expect(qty).toHaveValue(100000));
  }

  it("a refused scan never says Added, and leaves the cart as it was", async () => {
    await fillLine();
    await scan("COLA");
    expect(screen.queryByTestId("counter-scan-added")).toBeNull();
    expect(screen.getByRole("spinbutton", { name: "Set quantity of Cola" })).toHaveValue(100000);
  });

  it("says why once, and the full line says it is full while a + tap changes nothing", async () => {
    // B1373: the order row's + is not disabled at the cap (the till's step refuses it); the visible hint is the reason
    await fillLine();
    await scan("COLA");
    expect(screen.getAllByText(CAP)).toHaveLength(1);
    expect(screen.getByTestId("counter-line-full")).toHaveTextContent(
      "This line is full. The most is 100,000 pieces.",
    );
    fireEvent.click(screen.getByRole("button", { name: "Add one Cola" }));
    expect(screen.getByRole("spinbutton", { name: "Set quantity of Cola" })).toHaveValue(100000);
  });

  it("a typed quantity over the cap shows its refusal once (no second copy under Amount due)", async () => {
    await fillLine();
    await scan("COLA");
    const qty = screen.getByRole("spinbutton", { name: "Set quantity of Cola" });
    fireEvent.change(qty, { target: { value: "100001" } });
    fireEvent.blur(qty);
    expect(await screen.findAllByText(CAP)).toHaveLength(1);
  });

  it("the quantity field is wide enough for a six-digit count at 390", async () => {
    await fillLine();
    expect(screen.getByRole("spinbutton", { name: "Set quantity of Cola" })).toHaveClass("w-20");
  });
});
