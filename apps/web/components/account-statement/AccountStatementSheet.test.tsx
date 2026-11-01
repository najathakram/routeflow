import * as React from "react";
import userEvent from "@testing-library/user-event";
import { useQuery } from "@tanstack/react-query";
import type { AccountStatement } from "@routeflow/types";
import { renderWithProviders, screen, waitFor, within } from "@/test-utils/render";
import { OpenBalanceButton } from "./OpenBalanceButton";
import { useCounterBackGuard } from "@/lib/counter-back-guard";
import { guardCounterLeave } from "@/lib/counter-cart-signal";

// the counter's "Discard this sale?" guard, spied: the sheet must never reach it
jest.mock("@/lib/counter-cart-signal", () => ({
  ...jest.requireActual("@/lib/counter-cart-signal"),
  guardCounterLeave: jest.fn(),
}));

/**
 * SA-1078 W-1096 PR-2: the statement sheet and the one button that opens it. Mocked at the api-client boundary.
 */

const mockGet = jest.fn();
jest.mock("@/lib/api-client", () => ({
  apiClient: { get: (...a: unknown[]) => mockGet(...a), post: jest.fn() },
}));

let mockMay = true;
jest.mock("@/lib/api/account-statement", () => ({
  ...jest.requireActual("@/lib/api/account-statement"),
  useMayOpenStatement: () => mockMay,
}));

// a tenant west of UTC: a day sent as "YYYY-MM-DD" must never go through a zone (SA-1078 A-3)
jest.mock("@/lib/tenant-timezone", () => ({
  ...jest.requireActual("@/lib/tenant-timezone"),
  useTenantTimeZone: () => "America/Chicago",
}));

const inv = (n: number, over: Record<string, unknown> = {}) => ({
  id: `inv-${n}`,
  invoiceNumber: `INV-${1000 + n}`,
  issueDate: "2026-10-01",
  dueDate: "2026-10-15",
  total: 100,
  paid: 40,
  credit: 0,
  unpaid: 60,
  daysLate: 0,
  ...over,
});

let statement: AccountStatement;
let failRead = false;

beforeEach(() => {
  mockMay = true;
  failRead = false;
  statement = {
    asOf: "2026-10-31",
    customer: { id: "c1", businessName: "Acme Wholesale" },
    emailOnFile: "ap@acme.test",
    openBalance: 120,
    overdue: 60,
    creditAvailable: 0,
    afterCredit: 0,
    waitingToClear: 0,
    openInvoices: [inv(1, { daysLate: 16 }), inv(2, { daysLate: 1 })],
    recentPayments: [],
    recentPaymentsTruncated: false,
    credits: [],
  };
  mockGet.mockReset();
  mockGet.mockImplementation((url: string) => {
    if (url === "/customers/c1/account-statement") {
      return failRead ? Promise.reject(new Error("boom")) : Promise.resolve({ data: statement });
    }
    return Promise.resolve({ data: {} });
  });
});

const open = async () => {
  const user = userEvent.setup();
  await user.click(screen.getByTestId("open-balance-button"));
  return user;
};

describe("OpenBalanceButton", () => {
  it("U1: tapping the figure opens the sheet for that customer", async () => {
    renderWithProviders(<OpenBalanceButton customerId="c1">$120.00</OpenBalanceButton>);
    await open();
    const sheet = await screen.findByTestId("account-statement-sheet");
    expect(await within(sheet).findByTestId("account-statement-open-balance")).toHaveTextContent(
      "$120.00",
    );
    expect(mockGet).toHaveBeenCalledWith("/customers/c1/account-statement");
  });

  it("U7: without permission it is the plain figure: no button, no read", () => {
    mockMay = false;
    renderWithProviders(<OpenBalanceButton customerId="c1">$120.00</OpenBalanceButton>);
    expect(screen.queryByTestId("open-balance-button")).toBeNull();
    expect(screen.getByText("$120.00")).toBeInTheDocument();
    expect(mockGet).not.toHaveBeenCalled();
  });

  it("U10: when the figure itself is unavailable it is not tappable", () => {
    renderWithProviders(
      <OpenBalanceButton customerId="c1" unavailable>
        {"—"}
      </OpenBalanceButton>,
    );
    expect(screen.queryByTestId("open-balance-button")).toBeNull();
  });

  it("the hint shows only when it is a button", () => {
    renderWithProviders(
      <OpenBalanceButton customerId="c1" hint="View statement">
        $120.00
      </OpenBalanceButton>,
    );
    expect(screen.getByText("View statement")).toBeInTheDocument();
  });

  it("U5/U6: tapping it inside a clickable row does not trigger the row's own action", async () => {
    const rowClick = jest.fn();
    renderWithProviders(
      <div onClick={rowClick}>
        <OpenBalanceButton customerId="c1">$120.00</OpenBalanceButton>
      </div>,
    );
    await open();
    expect(rowClick).not.toHaveBeenCalled();
  });

  it("U17: Esc closes the sheet and focus returns to the tapped figure", async () => {
    renderWithProviders(<OpenBalanceButton customerId="c1">$120.00</OpenBalanceButton>);
    const user = await open();
    await screen.findByTestId("account-statement-sheet");
    await user.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByTestId("account-statement-sheet")).toBeNull());
    expect(screen.getByTestId("open-balance-button")).toHaveFocus();
  });

  it("U18: browser Back closes the sheet and stays on the page", async () => {
    renderWithProviders(<OpenBalanceButton customerId="c1">$120.00</OpenBalanceButton>);
    await open();
    await screen.findByTestId("account-statement-sheet");
    const here = window.location.href;
    window.dispatchEvent(new PopStateEvent("popstate"));
    await waitFor(() => expect(screen.queryByTestId("account-statement-sheet")).toBeNull());
    expect(window.location.href).toBe(here);
  });

  it("the footer actions slot renders what the caller hands it", async () => {
    renderWithProviders(
      <OpenBalanceButton customerId="c1" actions={<button type="button">Print</button>}>
        $120.00
      </OpenBalanceButton>,
    );
    await open();
    const actions = await screen.findByTestId("account-statement-actions");
    expect(within(actions).getByRole("button", { name: "Print" })).toBeInTheDocument();
  });
});

describe("Mac mini proof on #4061 (F1 to F5)", () => {
  it("F1: a tap or a key inside the sheet never reaches the row it sits in", async () => {
    const rowClick = jest.fn();
    const rowKey = jest.fn();
    renderWithProviders(
      <div onClick={rowClick} onKeyDown={rowKey}>
        <OpenBalanceButton customerId="c1">$120.00</OpenBalanceButton>
      </div>,
    );
    const user = await open();
    await screen.findByTestId("account-statement-sheet");
    await screen.findByTestId("account-statement-invoices");
    rowClick.mockClear();
    rowKey.mockClear();
    await user.click(screen.getByText("Open invoices"));
    await user.click(screen.getByRole("link", { name: "INV-1001" }));
    await user.keyboard("{Tab}");
    expect(rowClick).not.toHaveBeenCalled();
    expect(rowKey).not.toHaveBeenCalled();
  });

  describe("F2: the counter's back guard", () => {
    function Counter() {
      useCounterBackGuard(true, jest.fn());
      return <OpenBalanceButton customerId="c1">$120.00</OpenBalanceButton>;
    }
    const settle = () => new Promise((r) => setTimeout(r, 60));
    beforeEach(() => (guardCounterLeave as jest.Mock).mockClear());

    it("closing by the X raises no Discard this sale, and focus returns to the figure", async () => {
      renderWithProviders(<Counter />);
      const user = await open();
      await screen.findByTestId("account-statement-sheet");
      await user.click(screen.getByRole("button", { name: "Close" }));
      await waitFor(() => expect(screen.queryByTestId("account-statement-sheet")).toBeNull());
      await settle();
      expect(guardCounterLeave).not.toHaveBeenCalled();
      expect(screen.getByTestId("open-balance-button")).toHaveFocus();
    });

    it("closing by Esc raises no Discard this sale", async () => {
      renderWithProviders(<Counter />);
      const user = await open();
      await screen.findByTestId("account-statement-sheet");
      await user.keyboard("{Escape}");
      await waitFor(() => expect(screen.queryByTestId("account-statement-sheet")).toBeNull());
      await settle();
      expect(guardCounterLeave).not.toHaveBeenCalled();
      expect(screen.getByTestId("open-balance-button")).toHaveFocus();
    });

    it("browser Back closes the sheet and raises no Discard this sale", async () => {
      renderWithProviders(<Counter />);
      await open();
      await screen.findByTestId("account-statement-sheet");
      window.history.back();
      await waitFor(() => expect(screen.queryByTestId("account-statement-sheet")).toBeNull());
      await settle();
      expect(guardCounterLeave).not.toHaveBeenCalled();
    });

    it("after the sheet is gone, a real Back on the counter still asks", async () => {
      renderWithProviders(<Counter />);
      const user = await open();
      await screen.findByTestId("account-statement-sheet");
      await user.click(screen.getByRole("button", { name: "Close" }));
      await waitFor(() => expect(screen.queryByTestId("account-statement-sheet")).toBeNull());
      await settle();
      window.dispatchEvent(new PopStateEvent("popstate"));
      expect(guardCounterLeave).toHaveBeenCalledTimes(1);
    });
  });

  it("F3: the foot of the table shows the open balance, the same figure as the headline", async () => {
    statement.openBalance = 1234.56;
    renderWithProviders(<OpenBalanceButton customerId="c1">$1,234.56</OpenBalanceButton>);
    await open();
    expect(await screen.findByTestId("account-statement-foot-total")).toHaveTextContent(
      "$1,234.56",
    );
    expect(screen.getByTestId("account-statement-open-balance")).toHaveTextContent("$1,234.56");
  });

  it("F3: with the list cut at 200 the foot still shows the full figure", async () => {
    statement.openInvoices = Array.from({ length: 250 }, (_, i) => inv(i));
    statement.openBalance = 15000;
    renderWithProviders(<OpenBalanceButton customerId="c1">$15,000.00</OpenBalanceButton>);
    await open();
    expect(await screen.findByTestId("account-statement-foot-total")).toHaveTextContent(
      "$15,000.00",
    );
  });

  it("F4: closing a sheet that read a figure refreshes the tile sources behind it", async () => {
    const { queryClient } = renderWithProviders(
      <OpenBalanceButton customerId="c1">$120.00</OpenBalanceButton>,
    );
    const spy = jest.spyOn(queryClient, "invalidateQueries");
    const user = await open();
    await screen.findByTestId("account-statement-body");
    spy.mockClear();
    await user.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByTestId("account-statement-sheet")).toBeNull());
    const keys = spy.mock.calls.map((c) => JSON.stringify(c[0]?.queryKey));
    expect(keys).toEqual(expect.arrayContaining([JSON.stringify(["customers", "c1"])]));
    expect(keys).toEqual(expect.arrayContaining([JSON.stringify(["invoices"])]));
    expect(keys).toEqual(expect.arrayContaining([JSON.stringify(["reports"])]));
  });

  it("F4: a second open reads again instead of showing the last figure", async () => {
    renderWithProviders(<OpenBalanceButton customerId="c1">$120.00</OpenBalanceButton>);
    const user = await open();
    await screen.findByTestId("account-statement-body");
    await user.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByTestId("account-statement-sheet")).toBeNull());
    statement.openBalance = 80;
    await user.click(screen.getByTestId("open-balance-button"));
    expect(await screen.findByTestId("account-statement-open-balance")).toHaveTextContent("$80.00");
  });

  it("F5: at 390 each row is two lines: invoice and due on the left, unpaid and paid on the right", async () => {
    statement.openInvoices = [inv(1, { daysLate: 16, credit: 10, unpaid: 50 })];
    renderWithProviders(<OpenBalanceButton customerId="c1">$50.00</OpenBalanceButton>);
    await open();
    const detail = await screen.findByTestId("statement-row-detail");
    expect(detail).toHaveTextContent("Due Oct 15, 2026 · 16 days late");
    expect(detail.textContent).not.toMatch(/Total|Paid|Credit/);
    expect(screen.getByTestId("statement-row-paid")).toHaveTextContent(
      "Paid $40.00 · Credit $10.00",
    );
  });

  it("F5: the invoice link and the Close X are 44 px targets on a phone", async () => {
    renderWithProviders(<OpenBalanceButton customerId="c1">$120.00</OpenBalanceButton>);
    await open();
    const link = await screen.findByRole("link", { name: "INV-1001" });
    expect(link.className).toContain("max-sm:min-h-[44px]");
    expect(link.className).toContain("max-sm:min-w-[44px]");
    const close = screen.getByRole("button", { name: "Close" });
    expect(close.className).toContain("max-sm:min-h-11");
    expect(close.className).toContain("max-sm:min-w-11");
  });
});

describe("AccountStatementSheet", () => {
  it("shows the title, the customer and date line, the open balance and the lines", async () => {
    renderWithProviders(<OpenBalanceButton customerId="c1">$120.00</OpenBalanceButton>);
    await open();
    expect(await screen.findByRole("dialog", { name: "Statement" })).toBeInTheDocument();
    expect(await screen.findByTestId("account-statement-subtitle")).toHaveTextContent(
      "Acme Wholesale · As of Oct 31, 2026",
    );
    expect(screen.getByText("Overdue")).toBeInTheDocument();
    expect(screen.getByText("Open invoices")).toBeInTheDocument();
  });

  it("U8: the sheet's figure is the read's openBalance to the cent", async () => {
    statement.openBalance = 1234.56;
    renderWithProviders(<OpenBalanceButton customerId="c1">$1,234.56</OpenBalanceButton>);
    await open();
    expect(await screen.findByTestId("account-statement-open-balance")).toHaveTextContent(
      "$1,234.56",
    );
  });

  it("U11: a failed read says so with Try Again, never $0.00", async () => {
    failRead = true;
    renderWithProviders(<OpenBalanceButton customerId="c1">$120.00</OpenBalanceButton>);
    const user = await open();
    expect(await screen.findByText("Couldn't load the statement.")).toBeInTheDocument();
    expect(screen.queryByText("$0.00")).toBeNull();
    failRead = false;
    await user.click(screen.getByRole("button", { name: "Try Again" }));
    expect(await screen.findByTestId("account-statement-open-balance")).toHaveTextContent(
      "$120.00",
    );
  });

  it("U12: $0 owed with credit and recent payments -> No open invoices, the rest still shows", async () => {
    statement = {
      ...statement,
      openBalance: 0,
      overdue: 0,
      creditAvailable: 25,
      afterCredit: 0,
      openInvoices: [],
      recentPayments: [
        {
          date: "2026-10-20T00:00:00.000Z",
          kind: "PAYMENT",
          method: "Check",
          reference: "1042",
          invoiceNumber: "INV-1001",
          amount: 80,
        },
      ],
      credits: [
        {
          kind: "CREDIT_NOTE",
          id: "cn1",
          number: "CN-7",
          date: "2026-10-18T00:00:00.000Z",
          reason: "Damaged",
          remaining: 25,
          expiresAt: null,
        },
      ],
    };
    renderWithProviders(<OpenBalanceButton customerId="c1">$0.00</OpenBalanceButton>);
    await open();
    expect(await screen.findByText("No open invoices")).toBeInTheDocument();
    expect(screen.getByText("Paid in the last 30 days")).toBeInTheDocument();
    expect(screen.getByText("Credits")).toBeInTheDocument();
    expect(screen.getByText("Credit available")).toBeInTheDocument();
  });

  it("recent payments print the method's label, never the raw code", async () => {
    const pay = (method: string, reference: string | null, kind: "PAYMENT" | "CREDIT") => ({
      date: "2026-10-20T00:00:00.000Z",
      kind,
      method,
      reference,
      invoiceNumber: "INV-1001",
      amount: 10,
    });
    statement.recentPayments = [
      pay("CHECK", "1042", "PAYMENT"),
      pay("ACH", null, "PAYMENT"),
      pay("CREDIT_NOTE", null, "CREDIT"),
      pay("ADVANCE", null, "CREDIT"),
    ];
    renderWithProviders(<OpenBalanceButton customerId="c1">$120.00</OpenBalanceButton>);
    await open();
    const list = await screen.findByTestId("account-statement-payments");
    const text = list.textContent ?? "";
    expect(text).toContain("Check 1042");
    expect(text).toContain("ACH / bank transfer");
    expect(text).toContain("Credit note");
    expect(text).toContain("Advance");
    for (const raw of ["CHECK", "CREDIT_NOTE", "ADVANCE"]) {
      expect(text).not.toContain(raw);
    }
  });

  it("A-3: As of prints the day the server sent, even for a tenant west of UTC", async () => {
    renderWithProviders(<OpenBalanceButton customerId="c1">$120.00</OpenBalanceButton>);
    await open();
    expect(await screen.findByTestId("account-statement-subtitle")).toHaveTextContent(
      "As of Oct 31, 2026",
    );
  });

  it("A-3: payment and credit dates print as the day sent", async () => {
    statement.recentPayments = [
      {
        date: "2026-10-30",
        kind: "PAYMENT",
        method: "CHECK",
        reference: null,
        invoiceNumber: "INV-1001",
        amount: 10,
      },
    ];
    statement.credits = [
      {
        kind: "CREDIT_NOTE",
        id: "cn1",
        number: "CN-7",
        date: "2026-10-18",
        reason: "Damaged",
        remaining: 25,
        expiresAt: null,
      },
    ];
    renderWithProviders(<OpenBalanceButton customerId="c1">$120.00</OpenBalanceButton>);
    await open();
    expect((await screen.findByTestId("account-statement-payments")).textContent).toContain(
      "Oct 30, 2026",
    );
    expect(screen.getByTestId("account-statement-credits").textContent).toContain("Oct 18, 2026");
  });

  it("A-3: a credit with an expiry prints it, and one without prints none", async () => {
    const credit = (id: string, expiresAt: string | null) => ({
      kind: "CREDIT_NOTE" as const,
      id,
      number: id,
      date: "2026-10-18",
      reason: null,
      remaining: 25,
      expiresAt,
    });
    statement.credits = [credit("CN-1", "2026-12-05"), credit("CN-2", null)];
    renderWithProviders(<OpenBalanceButton customerId="c1">$120.00</OpenBalanceButton>);
    await open();
    const list = await screen.findByTestId("account-statement-credits");
    const rows = Array.from(list.querySelectorAll("li"));
    expect(rows).toHaveLength(2);
    expect(rows[0].textContent).toContain("Expires Dec 5, 2026");
    expect(rows[1].textContent).not.toContain("Expires");
  });

  it("U13: with no credit available neither credit line shows", async () => {
    renderWithProviders(<OpenBalanceButton customerId="c1">$120.00</OpenBalanceButton>);
    await open();
    await screen.findByTestId("account-statement-body");
    expect(screen.queryByText("Credit available")).toBeNull();
    expect(screen.queryByText("After credit")).toBeNull();
  });

  it("U14: the Credit column is gone when no row has a credit, and back when one does", async () => {
    renderWithProviders(<OpenBalanceButton customerId="c1">$120.00</OpenBalanceButton>);
    await open();
    const table = await screen.findByTestId("account-statement-invoices");
    expect(within(table).queryByRole("columnheader", { name: "Credit" })).toBeNull();
  });

  it("U14b: a row with a credit brings the column", async () => {
    statement.openInvoices = [inv(1, { credit: 10, unpaid: 50 })];
    renderWithProviders(<OpenBalanceButton customerId="c1">$50.00</OpenBalanceButton>);
    await open();
    const table = await screen.findByTestId("account-statement-invoices");
    expect(within(table).getByRole("columnheader", { name: "Credit" })).toBeInTheDocument();
  });

  it("days late reads 1 day late / n days late", async () => {
    renderWithProviders(<OpenBalanceButton customerId="c1">$120.00</OpenBalanceButton>);
    await open();
    await screen.findByTestId("account-statement-invoices");
    expect(screen.getAllByText("16 days late").length).toBeGreaterThan(0);
    expect(screen.getAllByText("1 day late").length).toBeGreaterThan(0);
  });

  it("U16: 250 open invoices -> 200 rows, the cut note, the full total", async () => {
    statement.openInvoices = Array.from({ length: 250 }, (_, i) => inv(i));
    statement.openBalance = 15000;
    renderWithProviders(<OpenBalanceButton customerId="c1">$15,000.00</OpenBalanceButton>);
    await open();
    await screen.findByTestId("account-statement-invoices");
    expect(screen.getAllByTestId("account-statement-invoice-row")).toHaveLength(200);
    expect(screen.getByTestId("account-statement-cut")).toHaveTextContent(
      "Showing 200 of 250. The PDF has them all.",
    );
    expect(screen.getByTestId("account-statement-open-balance")).toHaveTextContent("$15,000.00");
  });

  it("U19: invoice numbers are same-tab links where leaving is safe", async () => {
    renderWithProviders(<OpenBalanceButton customerId="c1">$120.00</OpenBalanceButton>);
    await open();
    const link = await screen.findByRole("link", { name: "INV-1001" });
    expect(link).toHaveAttribute("href", "/invoices/inv-1");
    expect(link).not.toHaveAttribute("target");
  });

  it("U20: on the counter and New order the invoice numbers are plain text", async () => {
    renderWithProviders(
      <OpenBalanceButton customerId="c1" linkInvoices={false}>
        $120.00
      </OpenBalanceButton>,
    );
    await open();
    await screen.findByTestId("account-statement-invoices");
    expect(screen.queryByRole("link")).toBeNull();
    expect(screen.getAllByText("INV-1001").length).toBeGreaterThan(0);
  });
});

describe("L9 (PR-5): closing the sheet refreshes the customers list", () => {
  it("a list query keyed ['customers', params] is read again after a loaded close, and shows the fresh figure", async () => {
    let listed = 0;
    function ListRow() {
      const q = useQuery({
        queryKey: ["customers", { page: 1, limit: 20 }],
        queryFn: async () => {
          listed += 1;
          return { openBalance: listed === 1 ? 120 : 80 };
        },
      });
      return <span data-testid="list-figure">{q.data ? q.data.openBalance : "…"}</span>;
    }
    renderWithProviders(
      <>
        <ListRow />
        <OpenBalanceButton customerId="c1">$120.00</OpenBalanceButton>
      </>,
    );
    expect(await screen.findByText("120")).toBeInTheDocument();
    const user = await open();
    await screen.findByTestId("account-statement-sheet");
    await screen.findByTestId("account-statement-open-balance"); // the sheet's read has landed
    await user.keyboard("{Escape}");
    await waitFor(() => expect(screen.getByTestId("list-figure")).toHaveTextContent("80"));
    expect(listed).toBe(2);
  });

  it("a sheet that never loaded refreshes nothing", async () => {
    failRead = true;
    let listed = 0;
    function ListRow() {
      useQuery({
        queryKey: ["customers", { page: 1 }],
        queryFn: async () => ++listed,
      });
      return null;
    }
    renderWithProviders(
      <>
        <ListRow />
        <OpenBalanceButton customerId="c1">$120.00</OpenBalanceButton>
      </>,
    );
    await waitFor(() => expect(listed).toBe(1));
    const user = await open();
    await screen.findByRole("alert");
    await user.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByTestId("account-statement-sheet")).toBeNull());
    expect(listed).toBe(1);
  });
});
