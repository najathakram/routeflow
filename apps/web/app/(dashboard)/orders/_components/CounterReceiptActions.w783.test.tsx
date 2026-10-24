import * as React from "react";
import { fireEvent, renderWithProviders, screen, waitFor } from "@/test-utils/render";
import { buildCounterReceipt } from "@/lib/counter-receipt";
import { CounterReceiptActions } from "./CounterReceiptActions";
import { CounterReceiptView } from "./CounterReceiptView";

/**
 * W-715 / W-716 / F13: the receipt's Change row is a normal row on an exact sale, its actions sit in one row on a phone with
 * the secondary ones behind "More", and "Void sale" opens the existing void dialog for THIS sale. The API is mocked at the
 * apiClient boundary; the role gate is the real staffMay(role, "VOID_SALE").
 */
const post = jest.fn();
jest.mock("next/navigation", () => ({
  ...jest.requireActual("next/navigation"),
  useRouter: () => ({ push: jest.fn() }),
}));
jest.mock("@/lib/api-client", () => ({
  apiClient: { get: jest.fn(), post: (...a: unknown[]) => post(...a) },
}));
let role: string | undefined = "OPERATOR";
jest.mock("@/lib/api/tobacco", () => ({ useHasAddon: () => false }));
jest.mock("@/lib/auth-context", () => ({
  ...jest.requireActual("@/lib/auth-context"),
  useOptionalAuth: () => ({ user: role ? { role, username: "pat" } : null }),
}));
jest.mock("@/lib/api/orders", () => ({
  useOrder: () => ({
    data: {
      id: "o1",
      orderNumber: "ORD-00001",
      customerId: "c1",
      total: 25,
      lineItems: [{ id: "l1", name: "Cola", product: { name: "Cola 12oz" }, qty: 10 }],
    },
  }),
}));

const model = (change: number | null, cashTendered = 25) =>
  buildCounterReceipt({
    receipt: {
      orderId: "o1",
      orderNumber: "ORD-00001",
      invoiceId: "i1",
      invoiceNumber: "INV-00001",
      total: 25,
      paid: 25,
      balanceDue: 0,
      paymentRecorded: true,
      method: "CASH",
      cashTendered,
      ...(change == null ? {} : { change }),
    },
    lines: [{ tempId: "a", name: "Cola", unitPrice: 2.5, qty: 10 }],
    enteredTender: null,
    profile: null,
    now: new Date("2026-10-07T15:15:00.000Z"),
  });

describe("W-715: Change is not a second headline on an exact sale", () => {
  it("a $0.00 change is a normal row, not text-lg", () => {
    renderWithProviders(<CounterReceiptView model={model(0)} />);
    const row = screen.getByTestId("receipt-change");
    expect(row).toHaveTextContent("$0.00");
    expect(row.className).not.toContain("text-lg");
    expect(row.className).not.toContain("font-semibold");
  });
  it("real change keeps its emphasis", () => {
    renderWithProviders(<CounterReceiptView model={model(5, 30)} />);
    const row = screen.getByTestId("receipt-change");
    expect(row).toHaveTextContent("$5.00");
    expect(row.className).toContain("text-lg");
  });
});

const renderActions = (props: Partial<React.ComponentProps<typeof CounterReceiptActions>> = {}) =>
  renderWithProviders(
    <CounterReceiptActions
      orderId="o1"
      customer={null}
      onNewSale={jest.fn()}
      methodsText="Cash"
      {...props}
    />,
  );

describe("W-715: the receipt actions are one row on a phone", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    role = "OPERATOR";
  });
  it("the phone row is Print, More and New sale (DOM order = Tab order); the rest sit behind More and stay reachable", () => {
    renderActions();
    const main = screen.getByTestId("receipt-actions-main");
    const group = screen.getByTestId("receipt-actions-more");
    // closed, only the three phone controls take room in the row; the rest are in the closed group
    const inRow = Array.from(main.querySelectorAll("button"))
      .filter((b) => !group.contains(b))
      .map((b) => b.textContent);
    expect(inRow).toEqual(["Print", "More", "New sale"]);
    const more = screen.getByRole("button", { name: "More" });
    expect(more).toHaveAttribute("aria-expanded", "false");
    expect(group.className).toMatch(/(^|\s)hidden(\s|$)/);
    fireEvent.click(more);
    expect(more).toHaveAttribute("aria-expanded", "true");
    expect(group.className).not.toMatch(/(^|\s)hidden(\s|$)/);
    for (const n of ["Email receipt", "Void sale ORD-00001"]) {
      expect(screen.getByRole("button", { name: n })).toBeInTheDocument();
    }
  });
});

describe("W-716 / F13: Void sale on the receipt", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    role = "OPERATOR";
  });
  it("opens the void dialog with this sale's total, methods and items", () => {
    renderActions();
    fireEvent.click(screen.getByRole("button", { name: "Void sale ORD-00001" }));
    expect(screen.getByText("Void sale ORD-00001 · $25.00")).toBeInTheDocument();
    expect(screen.getByTestId("counter-void-summary")).toHaveTextContent("Cash");
    expect(screen.getByTestId("counter-void-summary")).toHaveTextContent("Cola 12oz");
  });
  it("is absent for a role that may not void", () => {
    role = "DRIVER";
    renderActions();
    expect(screen.queryByRole("button", { name: /Void sale/ })).toBeNull();
  });
  it("after a void the receipt says so and the control reads Voided", async () => {
    post.mockResolvedValueOnce({ data: { handBack: { CASH: 25 }, replayed: false } });
    renderActions();
    fireEvent.click(screen.getByRole("button", { name: "Void sale ORD-00001" }));
    fireEvent.change(screen.getByLabelText(/Reason for voiding/), {
      target: { value: "Rang up twice" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Void sale" }));
    await screen.findByTestId("counter-void-done");
    fireEvent.click(screen.getByRole("button", { name: "Done" }));
    await waitFor(() => expect(screen.getByTestId("receipt-voided")).toHaveTextContent("voided"));
    expect(screen.getByRole("button", { name: "Voided" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "New sale" })).toBeInTheDocument();
  });
});
