import * as React from "react";
import { render } from "@testing-library/react";
import { INVOICE_STATUS_VALUES, INVOICE_STATUS_TONE, type InvoiceStatus } from "@routeflow/types";
import {
  INVOICE_STATUS_BADGE_VARIANT,
  INVOICE_STATUS_PILL_CLASS,
  INVOICE_STATUS_TEXT_CLASS,
  InvoiceStatusLegend,
  InvoiceStatusPill,
  InvoiceStatusText,
  invoiceStatusBuyerVariant,
  invoiceStatusView,
} from "./invoice-status-display";

/**
 * W-1470: the one web reading of an invoice status. Overdue is the stored OVERDUE or the server's `isOverdue`; day counts
 * are whole days against the TENANT's day; with the tenant day unknown no count is claimed. The browser clock is set to a
 * different day than the tenant's, and every day is a string, so the result does not depend on the machine's zone.
 */
const DUE_16 = "2026-11-16T00:00:00.000Z";
const DUE_25 = "2026-11-25T00:00:00.000Z";
const DUE_26 = "2026-11-26T00:00:00.000Z";
const DUE_28 = "2026-11-28T00:00:00.000Z";

describe("invoiceStatusView", () => {
  beforeEach(() => jest.useFakeTimers({ now: new Date("2026-11-27T12:00:00Z") }));
  afterEach(() => jest.useRealTimers());

  it("a stored OVERDUE reads Overdue by N days in the danger tone", () => {
    expect(invoiceStatusView("OVERDUE", DUE_16, { tenantDay: "2026-11-26" })).toEqual({
      label: "Overdue by 10 days",
      tone: "danger",
    });
  });

  it("a SENT or VIEWED invoice the server calls overdue is overdue (S-1)", () => {
    for (const s of ["SENT", "VIEWED"]) {
      expect(invoiceStatusView(s, DUE_16, { isOverdue: true, tenantDay: "2026-11-26" })).toEqual({
        label: "Overdue by 10 days",
        tone: "danger",
      });
    }
  });

  it("one day is singular", () => {
    expect(
      invoiceStatusView("SENT", DUE_25, { isOverdue: true, tenantDay: "2026-11-26" }).label,
    ).toBe("Overdue by 1 day");
  });

  it("a partly paid overdue invoice reads Partial · Overdue by N days, red", () => {
    expect(
      invoiceStatusView("PARTIAL", DUE_16, { isOverdue: true, tenantDay: "2026-11-26" }),
    ).toEqual({ label: "Partial · Overdue by 10 days", tone: "danger" });
  });

  it("due today is on the tenant's day, not the browser's (S-2)", () => {
    expect(
      invoiceStatusView("PARTIAL", DUE_26, { isOverdue: false, tenantDay: "2026-11-26" }),
    ).toEqual({ label: "Partial · Due today", tone: "warning" });
    expect(
      invoiceStatusView("SENT", DUE_26, { isOverdue: false, tenantDay: "2026-11-26" }),
    ).toEqual({ label: "Due today", tone: "warning" });
  });

  it("a partly paid invoice due in N days reads Partial · Due in N days", () => {
    expect(
      invoiceStatusView("PARTIAL", DUE_28, { isOverdue: false, tenantDay: "2026-11-26" }),
    ).toEqual({ label: "Partial · Due in 2 days", tone: "warning" });
    expect(invoiceStatusView("PARTIAL", DUE_28, { tenantDay: "2026-11-27" }).label).toBe(
      "Partial · Due in 1 day",
    );
  });

  it("a sent invoice not yet due reads Sent in the blue (info) tone", () => {
    expect(
      invoiceStatusView("SENT", DUE_28, { isOverdue: false, tenantDay: "2026-11-26" }),
    ).toEqual({ label: "Sent", tone: "info" });
  });

  it("with the tenant day unknown it claims no count (S-3)", () => {
    expect(invoiceStatusView("SENT", DUE_16, { isOverdue: true })).toEqual({
      label: "Overdue",
      tone: "danger",
    });
    expect(invoiceStatusView("OVERDUE", DUE_16, {}).label).toBe("Overdue");
    expect(invoiceStatusView("PARTIAL", DUE_16, {}).label).toBe("Partial");
    expect(invoiceStatusView("PARTIAL", DUE_16, { isOverdue: true }).label).toBe(
      "Partial · Overdue",
    );
    expect(invoiceStatusView("SENT", DUE_16, { isOverdue: false }).label).toBe("Sent");
  });

  it("paid, void, written off and draft ignore the due date and the overdue flag", () => {
    for (const [s, label] of [
      ["PAID", "Paid"],
      ["VOID", "Void"],
      ["WRITTEN_OFF", "Written off"],
      ["DRAFT", "Draft"],
    ] as const) {
      expect(invoiceStatusView(s, DUE_16, { isOverdue: true, tenantDay: "2026-11-26" })).toEqual({
        label,
        tone: INVOICE_STATUS_TONE[s],
      });
    }
  });

  it("no due date: the plain word and tone", () => {
    expect(invoiceStatusView("OVERDUE", null, { tenantDay: "2026-11-26" })).toEqual({
      label: "Overdue",
      tone: "danger",
    });
    expect(invoiceStatusView("VIEWED", undefined)).toEqual({ label: "Viewed", tone: "info" });
  });

  it("a status this build does not know shows as given, neutral", () => {
    expect(invoiceStatusView("SOMETHING_NEW", null)).toEqual({
      label: "SOMETHING_NEW",
      tone: "neutral",
    });
  });
});

describe("tone to class tables", () => {
  const tones = new Set(INVOICE_STATUS_VALUES.map((s) => INVOICE_STATUS_TONE[s]));
  it("every tone in use has a text class, a pill class and a Badge variant", () => {
    for (const t of tones) {
      expect(INVOICE_STATUS_TEXT_CLASS[t]).toBeTruthy();
      expect(INVOICE_STATUS_PILL_CLASS[t]).toBeTruthy();
      expect(INVOICE_STATUS_BADGE_VARIANT[t]).toBeTruthy();
    }
  });
});

describe("InvoiceStatusText and InvoiceStatusPill", () => {
  it("the text carries the word, the tone and its class", () => {
    const { container } = render(
      <InvoiceStatusText status="SENT" dueDate={DUE_16} isOverdue tenantDay="2026-11-26" />,
    );
    const el = container.firstElementChild as HTMLElement;
    expect(el.textContent).toBe("Overdue by 10 days");
    expect(el.getAttribute("data-tone")).toBe("danger");
    expect(el.className).toContain(INVOICE_STATUS_TEXT_CLASS.danger);
  });

  it.each(INVOICE_STATUS_VALUES)("the pill for %s uses the table's tone", (status) => {
    const { container } = render(<InvoiceStatusPill status={status} />);
    const el = container.firstElementChild as HTMLElement;
    expect(el.getAttribute("data-tone")).toBe(INVOICE_STATUS_TONE[status]);
    expect(el.className).toContain(INVOICE_STATUS_PILL_CLASS[INVOICE_STATUS_TONE[status]]);
  });
});

describe("invoiceStatusBuyerVariant: the buyer screens' tones do not change (B1122)", () => {
  const EXPECTED: Record<InvoiceStatus, string> = {
    DRAFT: "neutral",
    SENT: "warning",
    VIEWED: "info",
    PARTIAL: "warning",
    PAID: "success",
    OVERDUE: "danger",
    VOID: "danger",
    WRITTEN_OFF: "danger",
  };
  it.each(INVOICE_STATUS_VALUES)("%s", (status) => {
    expect(invoiceStatusBuyerVariant(status)).toBe(EXPECTED[status]);
  });
  it("an unknown status is neutral", () => {
    expect(invoiceStatusBuyerVariant("SOMETHING_NEW" as InvoiceStatus)).toBe("neutral");
  });
});

describe("InvoiceStatusLegend", () => {
  it("shows each status once, in enum order, with the same tone", () => {
    const { container } = render(<InvoiceStatusLegend />);
    const items = Array.from(container.querySelectorAll("[data-legend-status]"));
    expect(items.map((i) => i.getAttribute("data-legend-status"))).toEqual([
      ...INVOICE_STATUS_VALUES,
    ]);
    expect(items.map((i) => i.textContent)).toEqual([
      "Draft",
      "Sent",
      "Viewed",
      "Partial",
      "Paid",
      "Overdue",
      "Void",
      "Written off",
    ]);
    items.forEach((i, idx) => {
      expect(i.getAttribute("data-tone")).toBe(INVOICE_STATUS_TONE[INVOICE_STATUS_VALUES[idx]]);
    });
  });
});
