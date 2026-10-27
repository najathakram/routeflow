import * as React from "react";
import { render } from "@testing-library/react";
import { renderInvoiceStatus } from "./invoice-status-badge";

/**
 * Row 325 (BT-5): the badge counts days on the TENANT's calendar day and takes "overdue" from the server's flag, never
 * from the browser's clock. The fake clock is the browser's day (the 24th, local time) while the tenant is already on
 * the 26th. The clock is an explicit UTC instant and every day is passed in as a string, so the result does not depend on
 * the machine's TZ: green under TZ=UTC and TZ=America/Chicago (both runs in the PR body).
 */
const text = (node: React.ReactNode) => render(<>{node}</>).container.textContent;
const DUE_25 = "2026-10-25T00:00:00.000Z";

describe("renderInvoiceStatus: the tenant's day, not the browser's (row 325)", () => {
  beforeEach(() => jest.useFakeTimers({ now: new Date("2026-10-24T12:00:00Z") }));
  afterEach(() => jest.useRealTimers());

  it("counts days past due on the tenant's calendar day (due the 25th, tenant on the 26th: 1d)", () => {
    expect(
      text(renderInvoiceStatus("SENT", DUE_25, { isOverdue: true, tenantDay: "2026-10-26" })),
    ).toBe("Overdue by 1d");
  });

  it("the server's flag decides overdue: a SENT invoice not flagged is not red even if the browser clock says it is late", () => {
    // browser says the 24th, tenant day is the 25th = due today, not overdue
    expect(
      text(renderInvoiceStatus("SENT", DUE_25, { isOverdue: false, tenantDay: "2026-10-25" })),
    ).toBe("Due today");
  });

  it("a PARTIAL due on the tenant's today is 'Due today' (the browser's day would say due in 1d)", () => {
    expect(
      text(renderInvoiceStatus("PARTIAL", DUE_25, { isOverdue: false, tenantDay: "2026-10-25" })),
    ).toBe("Partial · Due today");
  });

  it("a PARTIAL due tomorrow on the tenant's calendar: 'Due in 1d'", () => {
    expect(
      text(renderInvoiceStatus("PARTIAL", DUE_25, { isOverdue: false, tenantDay: "2026-10-24" })),
    ).toBe("Partial · Due in 1d");
  });

  it("a past-due PARTIAL the server flags is orange 'Partial · Overdue by Nd'", () => {
    expect(
      text(renderInvoiceStatus("PARTIAL", DUE_25, { isOverdue: true, tenantDay: "2026-10-28" })),
    ).toBe("Partial · Overdue by 3d");
  });

  it("while the zone is unknown it claims no day count: a flagged invoice is plain 'Overdue', others their plain status", () => {
    expect(text(renderInvoiceStatus("SENT", DUE_25, { isOverdue: true }))).toBe("Overdue");
    expect(text(renderInvoiceStatus("SENT", DUE_25, { isOverdue: false }))).toBe("Sent");
    expect(text(renderInvoiceStatus("PARTIAL", DUE_25, {}))).toBe("Partial");
  });

  it("paid, void, written off and draft are unchanged", () => {
    expect(text(renderInvoiceStatus("PAID", DUE_25))).toBe("Paid");
    expect(text(renderInvoiceStatus("VOID", DUE_25))).toBe("Void");
    expect(text(renderInvoiceStatus("WRITTEN_OFF", DUE_25))).toBe("Written off");
    expect(text(renderInvoiceStatus("DRAFT", DUE_25))).toBe("Draft");
  });
});
