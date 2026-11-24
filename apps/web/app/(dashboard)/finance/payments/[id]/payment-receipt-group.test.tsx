import * as React from "react";
import { renderWithProviders, screen, within } from "@/test-utils/render";
import {
  receiptStatusText,
  type ReceiptApplication,
  type ReceiptGroupView,
} from "@routeflow/types";
import { fmtDate } from "@/lib/formatting";
import PaymentDetailPage from "./page";

/**
 * SA-1208 D1 / M1-03 (SA-1211 BF-6): the staff receipt reads what ONE check covered. The server builds the whole view
 * (`receipt` on GET /invoices/payments/:id); the screen prints its figures and never adds or subtracts money.
 *
 * Fixture: a $4,000 check over invoice A ($3,000) and invoice B ($1,000), stored as two rows in one group. The page is
 * opened from B's row, so the row's own `amount` is $1,000. Master prints that slice as the receipt.
 */
jest.mock("next/navigation", () => ({
  useParams: () => ({ id: "pay-b" }),
  useRouter: () => ({ push: jest.fn(), back: jest.fn(), replace: jest.fn() }),
}));

const row = (over: Record<string, unknown> = {}): ReceiptApplication =>
  ({
    paymentId: "pay-a",
    paymentNumber: "PAY-0001",
    invoiceId: "inv-a",
    invoiceNumber: "INV-ACME-A",
    amount: 3000,
    status: "PAID",
    checkStatus: null,
    creditNoteId: null,
    advancePaymentId: null,
    ...over,
  }) as ReceiptApplication;

function receipt(over: Partial<ReceiptGroupView> = {}): ReceiptGroupView {
  return {
    kind: "OFFICE_GROUP",
    header: {
      key: "grp-1",
      number: "PAY-0001",
      reference: "1001",
      method: "CHECK",
      receivedAt: "2026-11-21T12:00:00.000Z",
      customerId: "cust-1",
      orderId: null,
      orderNumber: null,
      total: 4000,
      confirmed: true,
      partlyVoided: false,
    },
    tenders: [
      {
        method: "CHECK",
        reference: "1001",
        amount: 4000,
        voided: false,
        status: "PAID",
        paymentIds: ["pay-a", "pay-b"],
      },
    ],
    applications: [
      row(),
      row({
        paymentId: "pay-b",
        paymentNumber: "PAY-0002",
        invoiceId: "inv-b",
        invoiceNumber: "INV-ACME-B",
        amount: 1000,
      }),
    ],
    unapplied: { amount: null, advancePaymentId: null },
    ...over,
  } as ReceiptGroupView;
}

const payment = (over: Record<string, unknown> = {}) => ({
  id: "pay-b",
  paymentNumber: "PAY-0002",
  amount: 1000,
  method: "CHECK",
  reference: "1001",
  status: "PAID" as const,
  paymentGroupId: "grp-1",
  paidAt: "2026-11-21T12:00:00.000Z",
  createdAt: "2026-11-21T12:00:00.000Z",
  invoice: {
    id: "inv-b",
    invoiceNumber: "INV-ACME-B",
    customerId: "cust-1",
    customer: { id: "cust-1", businessName: "Acme Foods" },
  },
  receipt: receipt(),
  ...over,
});

const usePaymentDetailMock = jest.fn((_id: string) => ({ data: payment(), isLoading: false }));
jest.mock("@/lib/api/invoices", () => ({
  ...jest.requireActual("@/lib/api/invoices"),
  usePaymentDetail: (id: string) => usePaymentDetailMock(id),
  useInvoice: () => ({ data: undefined }),
  useVoidPayment: () => ({ mutateAsync: jest.fn(), isPending: false }),
  useGetPaymentImageUrl: () => ({ mutateAsync: jest.fn() }),
}));
jest.mock("@/lib/api-client", () => ({
  apiClient: { get: jest.fn(), post: jest.fn(), patch: jest.fn(), delete: jest.fn() },
}));

const show = (data: unknown) =>
  usePaymentDetailMock.mockReturnValue({ data, isLoading: false } as never);

describe("receipt page: one check, one receipt", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    show(payment());
  });

  it("shows the $4,000 the check was for, not the $1,000 slice of the row it was opened from", () => {
    renderWithProviders(<PaymentDetailPage />);
    const total = screen.getByText(/Received on this receipt/).parentElement as HTMLElement;
    expect(within(total).getByText("$4,000.00")).toBeInTheDocument();
    expect(within(total).queryByText("$1,000.00")).not.toBeInTheDocument();
    expect(screen.queryByText("Amount received")).not.toBeInTheDocument();
  });

  it("an all-PAID receipt stays bare: no status words, no not-counted note", () => {
    renderWithProviders(<PaymentDetailPage />);
    expect(screen.queryByText(/not in total|not counted|Voided|Pending/)).not.toBeInTheDocument();
  });

  it("opened from the 2nd row, the document card carries the receipt number, method and reference, not the row's", () => {
    renderWithProviders(<PaymentDetailPage />);
    expect(screen.getByText(/^PAY-0001 · /)).toBeInTheDocument(); // the heading number
    expect(screen.queryByText(/PAY-0002/)).not.toBeInTheDocument();
    expect(screen.getByText("Check")).toBeInTheDocument();
  });

  it("never calls it a check amount (the reference rides beside the figure)", () => {
    renderWithProviders(<PaymentDetailPage />);
    expect(screen.queryByText(/check amount/i)).not.toBeInTheDocument();
    expect(screen.getByText("(Check #1001)")).toBeInTheDocument();
  });

  it("lists BOTH invoices it covered, each linked, with the amount the server gave for it", () => {
    renderWithProviders(<PaymentDetailPage />);
    const list = screen.getByRole("list", { name: "Invoices on this receipt" });
    const a = within(list).getByRole("link", { name: "INV-ACME-A" });
    const b = within(list).getByRole("link", { name: "INV-ACME-B" });
    expect(a).toHaveAttribute("href", "/invoices/inv-a");
    expect(b).toHaveAttribute("href", "/invoices/inv-b");
    expect(within(list).getByText("$3,000.00")).toBeInTheDocument();
    expect(within(list).getByText("$1,000.00")).toBeInTheDocument();
  });

  it("has exactly ONE Void button, and it says it voids only this row", () => {
    renderWithProviders(<PaymentDetailPage />);
    expect(screen.getAllByRole("button", { name: /void/i })).toHaveLength(1);
    expect(screen.getByText(/only the \$1,000\.00 on INV-ACME-B/i)).toBeInTheDocument();
  });

  it("keeps one Void button on a plain one-row payment too", () => {
    show(payment({ paymentGroupId: null, receipt: receipt({ kind: "SINGLE" }) }));
    renderWithProviders(<PaymentDetailPage />);
    expect(screen.getAllByRole("button", { name: /void/i })).toHaveLength(1);
    expect(screen.getByText("Amount received")).toBeInTheDocument(); // today's one-row receipt, unchanged
  });
});

describe("receipt page: nothing unconfirmed reads as money received", () => {
  beforeEach(() => jest.clearAllMocks());

  it("labels a tender whose rows are not confirmed, and leaves a confirmed one bare", () => {
    show(
      payment({
        receipt: receipt({
          tenders: [
            {
              method: "CHECK",
              reference: "1001",
              amount: 3000,
              voided: false,
              status: "PAID",
              paymentIds: ["pay-a"],
            },
            {
              method: "CASH",
              reference: null,
              amount: 1000,
              voided: false,
              status: "DRAFT",
              paymentIds: ["pay-b"],
            },
          ],
          applications: [
            row(),
            row({
              paymentId: "pay-b",
              invoiceId: "inv-b",
              invoiceNumber: "INV-ACME-B",
              amount: 1000,
              status: "DRAFT",
            }),
          ],
          header: { ...receipt().header!, total: 3000 },
        }),
      }),
    );
    renderWithProviders(<PaymentDetailPage />);
    const tenders = screen.getByRole("list", { name: "Tenders on this receipt" });
    const [check, cash] = within(tenders).getAllByRole("listitem");
    expect(within(check).queryByText(/not in total/i)).not.toBeInTheDocument();
    expect(within(cash).getByText("Draft, not in total")).toBeInTheDocument();
    expect(within(cash).queryByText("Pending")).not.toBeInTheDocument();
    expect(within(cash).getByText("$1,000.00")).toHaveClass("text-navy/50"); // grey, never struck
    expect(within(cash).getByText("$1,000.00")).not.toHaveClass("line-through");
    // R3: the header says how much is outside the total
    expect(screen.getByText("· 1 draft ($1,000.00) not counted")).toBeInTheDocument();
    // R4: the application row reads the same words
    const invoices = screen.getByRole("list", { name: "Invoices on this receipt" });
    expect(within(invoices).getByText("Draft, not in total")).toBeInTheDocument();
  });

  it("says a PENDING tender is not in the total", () => {
    show(
      payment({
        receipt: receipt({
          tenders: [
            {
              method: "CHECK",
              reference: "1001",
              amount: 1000,
              voided: false,
              status: "PENDING",
              paymentIds: ["pay-b"],
            },
          ],
          applications: [row({ status: "PENDING" })],
          header: { ...receipt().header!, total: 0, confirmed: false },
        }),
      }),
    );
    renderWithProviders(<PaymentDetailPage />);
    const tenders = screen.getByRole("list", { name: "Tenders on this receipt" });
    expect(within(tenders).getByText("Pending, not in total")).toBeInTheDocument();
    expect(screen.getByText("· 1 pending ($1,000.00) not counted")).toBeInTheDocument();
  });

  it("reads 'Not confirmed' instead of a $0.00 total when no row is confirmed", () => {
    show(
      payment({
        status: "DRAFT",
        receipt: receipt({
          tenders: [
            {
              method: "CHECK",
              reference: "1001",
              amount: 4000,
              voided: false,
              status: "DRAFT",
              paymentIds: ["pay-a", "pay-b"],
            },
          ],
          applications: [
            row({ status: "DRAFT" }),
            row({
              paymentId: "pay-b",
              invoiceId: "inv-b",
              invoiceNumber: "INV-ACME-B",
              amount: 1000,
              status: "DRAFT",
            }),
          ],
          header: { ...receipt().header!, total: 0, confirmed: false },
        }),
      }),
    );
    renderWithProviders(<PaymentDetailPage />);
    expect(screen.getByText("Not confirmed")).toBeInTheDocument();
    expect(screen.queryByText("$0.00")).not.toBeInTheDocument();
  });

  it("strikes a voided tender and says so", () => {
    show(
      payment({
        receipt: receipt({
          tenders: [
            {
              method: "CHECK",
              reference: "1001",
              amount: 3000,
              voided: false,
              status: "PAID",
              paymentIds: ["pay-a"],
            },
            {
              method: "CHECK",
              reference: "1001",
              amount: 1000,
              voided: true,
              status: "VOID",
              paymentIds: ["pay-b"],
            },
          ],
          applications: [
            row(),
            row({
              paymentId: "pay-b",
              invoiceId: "inv-b",
              invoiceNumber: "INV-ACME-B",
              amount: 1000,
              status: "VOID",
            }),
          ],
          header: { ...receipt().header!, total: 3000, partlyVoided: true },
        }),
      }),
    );
    renderWithProviders(<PaymentDetailPage />);
    expect(screen.getByText("Check partly voided")).toBeInTheDocument();
    const tenders = screen.getByRole("list", { name: "Tenders on this receipt" });
    const [, voided] = within(tenders).getAllByRole("listitem");
    expect(within(voided).getByText("Voided")).toBeInTheDocument();
  });
});

const tender = (over: Record<string, unknown>) => ({
  method: "CHECK",
  reference: "1001",
  amount: 3000,
  voided: false,
  status: "PAID",
  paymentIds: ["pay-a"],
  ...over,
});
const mixed = (over: Partial<ReceiptGroupView> = {}) =>
  receipt({
    tenders: [
      tender({}),
      tender({ method: "CASH", reference: null, amount: 1000, paymentIds: ["pay-b"] }),
    ] as ReceiptGroupView["tenders"],
    header: { ...receipt().header!, method: null, reference: null },
    ...over,
  });

describe("receipt page: a clicked row's field is never the receipt's", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    show(payment());
  });

  it.each([
    ["CASH", null],
    ["CHECK", "1001"],
  ])(
    "a mixed check + cash receipt opened from the %s row: one line per tender, no single method",
    (method, reference) => {
      show(payment({ method, reference, receipt: mixed() }));
      renderWithProviders(<PaymentDetailPage />);
      expect(screen.queryByText("Payment method")).not.toBeInTheDocument();
      expect(screen.queryByText("Reference")).not.toBeInTheDocument();
      const [check, cash] = within(
        screen.getByRole("list", { name: "Tenders on this receipt" }),
      ).getAllByRole("listitem");
      // the method label and the amount are two spans of one line (no separator in the markup): exact text of each
      expect(check.textContent).toBe("Check #1001$3,000.00");
      expect(within(check).getByText("Check #1001")).toBeInTheDocument();
      expect(within(check).getByText("$3,000.00")).toBeInTheDocument();
      expect(cash.textContent).toBe("Cash$1,000.00");
      expect(within(cash).getByText("Cash")).toBeInTheDocument();
      expect(within(cash).getByText("$1,000.00")).toBeInTheDocument();
    },
  );

  it("a one-method group prints the header's method, and no row reference", () => {
    show(
      payment({
        reference: "1002",
        receipt: receipt({ header: { ...receipt().header!, reference: null } }),
      }),
    );
    renderWithProviders(<PaymentDetailPage />);
    const methodRow = screen.getByText("Payment method").parentElement as HTMLElement;
    expect(within(methodRow).getByText("Check")).toBeInTheDocument();
    expect(screen.queryByText("Reference")).not.toBeInTheDocument();
    expect(screen.queryByText("1002")).not.toBeInTheDocument();
  });

  it("a one-row payment keeps its own method and reference", () => {
    show(payment({ method: "CASH", reference: "r-9", receipt: receipt({ kind: "SINGLE" }) }));
    renderWithProviders(<PaymentDetailPage />);
    expect(screen.getByText("Payment method")).toBeInTheDocument();
    expect(screen.getByText("Cash")).toBeInTheDocument();
    expect(screen.getByText("r-9")).toBeInTheDocument();
    expect(screen.queryByText("This payment")).not.toBeInTheDocument();
  });

  it("the date is the receipt's; the clicked row's bank date and notes sit under 'This payment'", () => {
    show(
      payment({
        paidAt: "2026-11-22T12:00:00.000Z",
        settledAt: "2026-11-23T12:00:00.000Z",
        notes: "row note",
        receipt: receipt({
          header: { ...receipt().header!, receivedAt: "2026-11-20T12:00:00.000Z" },
        }),
      }),
    );
    renderWithProviders(<PaymentDetailPage />);
    expect(screen.getByText("Payment date").nextSibling).toHaveTextContent(
      fmtDate("2026-11-20T12:00:00.000Z"),
    );
    expect(screen.queryByText(fmtDate("2026-11-22T12:00:00.000Z"))).not.toBeInTheDocument();
    const block = screen.getByText("This payment").parentElement as HTMLElement;
    expect(within(block).getByText(fmtDate("2026-11-23T12:00:00.000Z"))).toBeInTheDocument();
    expect(within(block).getByText("row note")).toBeInTheDocument();
  });

  it("a VOID row opened inside a confirmed receipt keeps the receipt's badge and says so for itself", () => {
    show(payment({ status: "VOID" }));
    renderWithProviders(<PaymentDetailPage />);
    expect(screen.getByText("This payment: Voided")).toBeInTheDocument();
    expect(screen.getByText("Paid")).toBeInTheDocument(); // the receipt's badge, not the clicked row's
    expect(screen.queryByText("Void")).not.toBeInTheDocument();
  });

  it("a PAID row adds no 'This payment' status line", () => {
    renderWithProviders(<PaymentDetailPage />);
    expect(screen.queryByText(/^This payment:/)).not.toBeInTheDocument();
  });

  it("a pickup receipt with a voided tender reads 'Payment partly voided'", () => {
    show(
      payment({
        receipt: mixed({
          kind: "PICKUP_TENDERS",
          header: { ...receipt().header!, method: null, reference: null, partlyVoided: true },
        }),
      }),
    );
    renderWithProviders(<PaymentDetailPage />);
    expect(screen.getByText("Payment partly voided")).toBeInTheDocument();
    expect(screen.queryByText("Check partly voided")).not.toBeInTheDocument();
  });
});

describe("receipt page: credit kept from the check", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    show(payment());
  });

  it("shows the server's unused-credit figure and links to the customer's credit", () => {
    show(
      payment({
        receipt: receipt({ unapplied: { amount: 1000, advancePaymentId: "adv-1" } }),
      }),
    );
    renderWithProviders(<PaymentDetailPage />);
    const credit = screen.getByTestId("kept-as-credit");
    expect(within(credit).getByText(/Kept as credit/)).toBeInTheDocument();
    expect(within(credit).getByText("$1,000.00")).toBeInTheDocument();
    const link = screen.getByRole("link", { name: "See credit" });
    expect(link).toHaveAttribute("href", "/customers/cust-1?tab=billing");
    expect(link.textContent).not.toMatch(/adv-1|AP-/); // a record id is never part of the sentence
  });

  it("prints no credit line when the server recorded none (never $0)", () => {
    renderWithProviders(<PaymentDetailPage />);
    expect(screen.queryByText(/Kept as credit/)).not.toBeInTheDocument();
  });
});

describe("receiptStatusText: one word per status, from the server's status", () => {
  it("reads PAID bare and the other three as ruled (SA-1220 item 7)", () => {
    expect(receiptStatusText("PAID")).toBeNull();
    expect(receiptStatusText("DRAFT")).toBe("Draft, not in total");
    expect(receiptStatusText("PENDING")).toBe("Pending, not in total");
    expect(receiptStatusText("VOID")).toBe("Voided");
  });
});
