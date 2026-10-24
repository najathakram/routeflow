import * as React from "react";
import userEvent from "@testing-library/user-event";
import { renderWithProviders, screen, waitFor, within } from "@/test-utils/render";
import { CustomerAccountStrip } from "./CustomerAccountStrip";
import { calendarDayInZone } from "@/lib/calendar-date";
import { OPEN_INVOICE_STATUS_LIST } from "@/lib/open-invoice-status";

/**
 * Row 661 (Ask 1): the Account strip under the picked customer on New order. Mocked at the api-client
 * boundary; the strip must show the statement's own figures (L-119) and never a made-up $0.
 */

const ZONE = "America/Chicago";
const TODAY = calendarDayInZone(ZONE);
const dayOffset = (days: number): string => {
  const [y, m, d] = TODAY.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d + days)).toISOString();
};

let mockUser: { role: string } | null = { role: "OPERATOR" };
jest.mock("@/lib/auth-context", () => ({
  ...jest.requireActual("@/lib/auth-context"),
  useAuth: () => ({ user: mockUser }),
}));

const mockGet = jest.fn();
jest.mock("@/lib/api-client", () => ({
  apiClient: { get: (...a: unknown[]) => mockGet(...a), post: jest.fn() },
}));

// The real modal has its own spec; here we only need what the strip hands it.
let modalProps: { customerId: string; focusInvoiceId?: string; onSuccess?: () => void } | null =
  null;
jest.mock("@/components/CustomerRecordPaymentModal", () => ({
  CustomerRecordPaymentModal: (p: {
    customerId: string;
    focusInvoiceId?: string;
    onSuccess?: () => void;
    onClose: () => void;
  }) => {
    modalProps = p;
    return (
      <div role="dialog" aria-label="Record payment stub">
        <button
          onClick={() => {
            p.onSuccess?.();
            p.onClose();
          }}
        >
          stub-pay
        </button>
      </div>
    );
  },
}));

interface Inv {
  id: string;
  invoiceNumber: string;
  status: string;
  issueDate: string;
  dueDate: string;
  balanceDue: number;
}
const inv = (n: number, issuedAgo: number, dueIn: number, balanceDue: number): Inv => ({
  id: `inv-${n}`,
  invoiceNumber: `INV-${1000 + n}`,
  status: dueIn < 0 ? "OVERDUE" : "SENT",
  issueDate: dayOffset(-issuedAgo),
  dueDate: dayOffset(dueIn),
  balanceDue,
});

let statement: Record<string, unknown>;
let customer: Record<string, unknown>;
let invoices: Inv[];
let failStatement = false;
let listTotal: number | null = null;
let overdueTotal: number | null = null;
let failZone = false;

beforeEach(() => {
  mockUser = { role: "OPERATOR" };
  modalProps = null;
  failStatement = false;
  listTotal = null;
  overdueTotal = null;
  failZone = false;
  statement = { outstandingAmount: 1240, overdueAmount: 420 };
  customer = { id: "c1", businessName: "Acme Foods", creditLimit: 930 };
  invoices = [
    inv(3, 5, 25, 300), // newest, not due yet
    inv(1, 64, -34, 420), // oldest, 34 days overdue
    inv(2, 40, -10, 520),
  ];
  mockGet.mockReset();
  mockGet.mockImplementation((url: string, opts?: { params?: Record<string, any> }) => {
    if (url === "/customers/c1") return Promise.resolve({ data: customer });
    if (url === "/customers/c1/statement") {
      return failStatement
        ? Promise.reject(new Error("boom"))
        : Promise.resolve({ data: statement });
    }
    if (url === "/settings/invoice") return Promise.resolve({ data: { defaultTerms: "Net 30" } });
    if (url === "/settings")
      return failZone
        ? Promise.reject(new Error("zone"))
        : Promise.resolve({ data: { timezone: ZONE } });
    if (url === "/invoices" && opts?.params?.isOverdue) {
      // the server's overdue set: past due, a balance left, oldest due date first (sortBy dueDate asc)
      const overdue = invoices
        .filter((i) => i.dueDate < dayOffset(0) && i.balanceDue > 0)
        .sort((a, b) => a.dueDate.localeCompare(b.dueDate));
      return Promise.resolve({
        data: {
          data: overdue.slice(0, opts.params.limit ?? 20),
          meta: { total: overdueTotal ?? overdue.length, page: 1, limit: 1, totalPages: 1 },
        },
      });
    }
    if (url === "/invoices") {
      return Promise.resolve({
        data: {
          data: invoices,
          meta: { total: listTotal ?? invoices.length, page: 1, limit: 100, totalPages: 1 },
        },
      });
    }
    return Promise.reject(new Error(`unmocked ${url}`));
  });
});

const line = () => screen.findByTestId("account-strip-line");

describe("CustomerAccountStrip", () => {
  // Opus review: the list is one page (limit 100). The open count is the server's total, never the page's length, and
  // past one page the full list is on the customer page, not a "Show all" that would show only the first 100.
  // #3724 review (a): past one page, the overdue figures are the server's too (an isOverdue read), never the page's.
  it("more than one page: the overdue count is the server's total and the oldest is the server's oldest", async () => {
    listTotal = 140;
    overdueTotal = 61;
    renderWithProviders(<CustomerAccountStrip customerId="c1" />);
    expect(await line()).toHaveTextContent("140 open · 61 overdue, oldest 34 days");
    const call = mockGet.mock.calls.find((c) => c[0] === "/invoices" && c[1]?.params?.isOverdue);
    expect(call?.[1]?.params).toEqual(
      expect.objectContaining({
        customerId: "c1",
        isOverdue: true,
        sortBy: "dueDate",
        sortOrder: "asc",
        limit: 1,
      }),
    );
  });

  // (b) like with like: a zero-balance open invoice on the page is not a "more than one page" signal.
  it("a zero-balance open invoice never produces a false 'See all'", async () => {
    invoices = [...invoices, inv(9, 2, 30, 0)];
    renderWithProviders(<CustomerAccountStrip customerId="c1" />);
    await line();
    await userEvent.click(screen.getByRole("button", { name: /view/i }));
    expect(screen.queryByRole("link", { name: /see all/i })).toBeNull();
  });

  // (c) an opening balance with no open invoices: the amount, never "0 open" and a View of an empty list.
  it("owes with no open invoices: shows the amount alone, with nothing to expand", async () => {
    invoices = [];
    renderWithProviders(<CustomerAccountStrip customerId="c1" />);
    expect(await line()).toHaveTextContent(/^Owes \$1,240\.00( · \$310\.00 over limit)?$/);
    expect(screen.queryByRole("button", { name: /view/i })).toBeNull();
  });

  // (d) a failed time-zone read drops only the day counts; the money and the list still show.
  it("a failed time-zone read keeps the strip, without day counts", async () => {
    failZone = true;
    renderWithProviders(<CustomerAccountStrip customerId="c1" />);
    expect(await line()).toHaveTextContent("Owes $1,240.00 · 3 open · 2 overdue");
    expect(screen.getByTestId("account-strip-line")).not.toHaveTextContent(/oldest/);
    expect(screen.queryByText("Couldn't load account info")).toBeNull();
  });

  it("more open invoices than one page: the count is the server's total, and the list points to the customer", async () => {
    listTotal = 140;
    renderWithProviders(<CustomerAccountStrip customerId="c1" />);
    expect(await line()).toHaveTextContent("Owes $1,240.00 · 140 open");
    await userEvent.click(screen.getByRole("button", { name: /view/i }));
    expect(screen.getByRole("link", { name: "See all 140 on the customer page" })).toHaveAttribute(
      "href",
      "/customers/c1",
    );
    expect(screen.queryByRole("button", { name: /show all/i })).toBeNull();
  });

  it("shows the statement's figures exactly, with the over-limit note (L-119: no figure of its own)", async () => {
    renderWithProviders(<CustomerAccountStrip customerId="c1" />);
    expect(await line()).toHaveTextContent(
      "Owes $1,240.00 · 3 open · 2 overdue, oldest 34 days · $310.00 over limit",
    );
  });

  it("reads the open list through the shared open-status list, for this customer", async () => {
    renderWithProviders(<CustomerAccountStrip customerId="c1" />);
    await line();
    const call = mockGet.mock.calls.find((c) => c[0] === "/invoices");
    expect(call?.[1]?.params).toEqual(
      expect.objectContaining({
        customerId: "c1",
        statuses: [...OPEN_INVOICE_STATUS_LIST],
      }),
    );
  });

  it("is amber when something is overdue and neutral (never red) when nothing is", async () => {
    const { unmount } = renderWithProviders(<CustomerAccountStrip customerId="c1" />);
    await line();
    const el = screen.getByTestId("account-strip-bar");
    expect(el).toHaveAttribute("data-tone", "warn");
    expect(el.className).toMatch(/amber/);
    expect(el.className).not.toMatch(/red|danger/);
    unmount();

    statement = { outstandingAmount: 300, overdueAmount: 0 };
    customer = { id: "c1", creditLimit: 5000 };
    invoices = [inv(3, 5, 25, 300)];
    renderWithProviders(<CustomerAccountStrip customerId="c1" />);
    expect(await line()).toHaveTextContent("Owes $300.00 · 1 open");
    const ok = screen.getByTestId("account-strip-bar");
    expect(ok).toHaveAttribute("data-tone", "neutral");
    expect(ok.className).not.toMatch(/amber|red|danger/);
  });

  it("says 'No open invoices' in quiet text when nothing is owed", async () => {
    statement = { outstandingAmount: 0, overdueAmount: 0 };
    customer = { id: "c1", creditLimit: null };
    invoices = [];
    renderWithProviders(<CustomerAccountStrip customerId="c1" />);
    expect(await line()).toHaveTextContent("No open invoices");
  });

  it("renders nothing with no customer picked (walk-in or before a pick)", () => {
    renderWithProviders(<CustomerAccountStrip customerId={null} />);
    expect(screen.queryByTestId("account-strip")).not.toBeInTheDocument();
    expect(screen.queryByText(/Checking account|No open invoices|Owes/)).not.toBeInTheDocument();
    expect(mockGet).not.toHaveBeenCalled();
  });

  it("shows 'Checking account…' while the reads are in flight", () => {
    mockGet.mockImplementation(() => new Promise(() => {}));
    renderWithProviders(<CustomerAccountStrip customerId="c1" />);
    expect(screen.getByText("Checking account…")).toBeInTheDocument();
  });

  it("a failed read shows the load-failed copy and Retry, never $0, and Retry reads again", async () => {
    failStatement = true;
    const user = userEvent.setup();
    renderWithProviders(<CustomerAccountStrip customerId="c1" />);
    expect(await screen.findByText("Couldn't load account info")).toBeInTheDocument();
    expect(screen.queryByText(/\$0\.00/)).not.toBeInTheDocument();
    expect(screen.queryByText(/Owes/)).not.toBeInTheDocument();
    expect(screen.queryByText("No open invoices")).not.toBeInTheDocument();

    failStatement = false;
    await user.click(screen.getByRole("button", { name: "Retry" }));
    expect(await line()).toHaveTextContent("Owes $1,240.00");
  });

  describe("expanded list", () => {
    it("lists the oldest invoice first, with issued date, days overdue (tenant day) and amount due", async () => {
      const user = userEvent.setup();
      renderWithProviders(<CustomerAccountStrip customerId="c1" />);
      await line();
      await user.click(screen.getByRole("button", { name: /view/i }));
      const rows = await screen.findAllByTestId("account-strip-row");
      expect(rows.map((r) => within(r).getByTestId("account-strip-number").textContent)).toEqual([
        "INV-1001",
        "INV-1002",
        "INV-1003",
      ]);
      expect(rows[0]).toHaveTextContent("34 days overdue");
      expect(rows[0]).toHaveTextContent("$420.00 due");
      expect(rows[1]).toHaveTextContent("10 days overdue");
      expect(rows[2]).not.toHaveTextContent(/overdue/);
    });

    it("shows at most 5 rows, then 'Show all N'", async () => {
      invoices = Array.from({ length: 9 }, (_, i) => inv(i + 1, 90 - i, 30 - i, 100));
      statement = { outstandingAmount: 900, overdueAmount: 0 };
      const user = userEvent.setup();
      renderWithProviders(<CustomerAccountStrip customerId="c1" />);
      await line();
      await user.click(screen.getByRole("button", { name: /view/i }));
      expect(await screen.findAllByTestId("account-strip-row")).toHaveLength(5);
      await user.click(screen.getByRole("button", { name: "Show all 9" }));
      expect(screen.getAllByTestId("account-strip-row")).toHaveLength(9);
    });

    it("Open opens the invoice in a new tab, so the draft is kept", async () => {
      const user = userEvent.setup();
      renderWithProviders(<CustomerAccountStrip customerId="c1" />);
      await line();
      await user.click(screen.getByRole("button", { name: /view/i }));
      const [first] = await screen.findAllByTestId("account-strip-row");
      const open = within(first).getByRole("link", { name: /open/i });
      expect(open).toHaveAttribute("href", "/invoices/inv-1");
      expect(open).toHaveAttribute("target", "_blank");
      expect(open.getAttribute("rel")).toMatch(/noopener/);
    });

    it("Mark paid opens the payment modal focused on THAT invoice", async () => {
      const user = userEvent.setup();
      renderWithProviders(<CustomerAccountStrip customerId="c1" />);
      await line();
      await user.click(screen.getByRole("button", { name: /view/i }));
      const rows = await screen.findAllByTestId("account-strip-row");
      await user.click(within(rows[1]).getByRole("button", { name: "Mark paid" }));
      expect(modalProps).toEqual(
        expect.objectContaining({ customerId: "c1", focusInvoiceId: "inv-2" }),
      );
    });

    it("the footer Record payment opens the modal with no focused invoice", async () => {
      const user = userEvent.setup();
      renderWithProviders(<CustomerAccountStrip customerId="c1" />);
      await line();
      await user.click(screen.getByRole("button", { name: /view/i }));
      await user.click(await screen.findByRole("button", { name: "Record payment" }));
      expect(modalProps?.customerId).toBe("c1");
      expect(modalProps?.focusInvoiceId).toBeUndefined();
    });

    it("after a payment the statement and open list are read again and the strip updates in place", async () => {
      const user = userEvent.setup();
      renderWithProviders(<CustomerAccountStrip customerId="c1" />);
      await line();
      await user.click(screen.getByRole("button", { name: /view/i }));
      const rows = await screen.findAllByTestId("account-strip-row");
      await user.click(within(rows[0]).getByRole("button", { name: "Mark paid" }));

      statement = { outstandingAmount: 820, overdueAmount: 0 };
      invoices = invoices.filter((i) => i.id !== "inv-1");
      await user.click(screen.getByRole("button", { name: "stub-pay" }));
      await waitFor(() =>
        expect(screen.getByTestId("account-strip-line")).toHaveTextContent("Owes $820.00 · 2 open"),
      );
      expect(screen.queryByText("INV-1001")).not.toBeInTheDocument();
    });
  });

  it("a role without payment rights sees the list but no payment actions", async () => {
    mockUser = { role: "DRIVER" };
    const user = userEvent.setup();
    renderWithProviders(<CustomerAccountStrip customerId="c1" />);
    await line();
    await user.click(screen.getByRole("button", { name: /view/i }));
    await screen.findAllByTestId("account-strip-row");
    expect(screen.queryByRole("button", { name: "Mark paid" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Record payment" })).not.toBeInTheDocument();
  });
});
