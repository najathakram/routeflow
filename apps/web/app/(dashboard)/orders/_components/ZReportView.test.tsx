import * as React from "react";
import { renderWithProviders, screen, within } from "@/test-utils/render";
import type { DayCloseSnapshot, DayCloseTotals } from "@routeflow/types";
import { ZReportBody, ZReportView } from "./ZReportView";

/**
 * SA-750r3 §4: the Z view prints the groups of `dayCloseZSections` in the plan's order. Every figure below is the fixture's own;
 * the component derives nothing (Cash in drawer is the stored expectedCash, Net collected the stored netCollected).
 */
const TOTALS: DayCloseTotals = {
  salesCount: 9,
  salesTotal: 300,
  moneyIn: { cash: 200, card: 90, check: 10, other: 0, total: 300 },
  refunds: {
    count: 1,
    cash: 15,
    card: 0,
    check: 0,
    other: 0,
    total: 15,
    tenderKnown: true,
    unknownTenderCount: 0,
  },
  storeCreditUsed: 0,
  storeCreditIssued: { count: 0, amount: 0 },
  onAccount: 12.5,
  netCollected: 285,
  notAtTill: 40,
  handOver: { count: 2, cash: 60 },
};
// 8:05 AM -> 9:42 PM on Fri Oct 9 2026, New York (EDT = UTC-4)
const snap = (over: Partial<DayCloseSnapshot> = {}): DayCloseSnapshot => ({
  id: "dc1",
  registerKey: "main",
  day: "2026-10-09",
  zone: "America/New_York",
  windowStart: "2026-10-09T12:05:00.000Z",
  windowEnd: "2026-10-10T01:42:00.000Z",
  closedAt: "2026-10-10T01:42:00.000Z",
  closedById: "u1",
  closedByName: "Sam",
  openingFloat: 100,
  expectedCash: 285,
  countedCash: 282.5,
  variance: -2.5,
  denominations: [],
  totals: TOTALS,
  notes: "Counted twice",
  reopenedAt: null,
  reopenedById: null,
  reportSent: true,
  ...over,
});

const row = (label: string) => screen.getByTestId(`z-row-${label}`);

describe("ZReportView", () => {
  it("prints the title, the closer line, the window and the bold headline, then the four groups in order", () => {
    renderWithProviders(<ZReportView snapshot={snap()} open onClose={() => {}} />);
    expect(screen.getByRole("dialog", { name: "Z report · Fri, Oct 9" })).toBeInTheDocument();
    expect(screen.getByTestId("z-closed-line")).toHaveTextContent("Closed 9:42 PM by Sam");
    expect(screen.getByTestId("z-window-line")).toHaveTextContent("8:05 AM – 9:42 PM");
    const headline = screen.getByTestId("z-headline");
    expect(headline).toHaveTextContent("Counted $282.50 · Short $2.50");
    expect(headline.className).toMatch(/font-bold/);

    const body = screen.getByTestId("z-report");
    const headings = within(body)
      .getAllByRole("heading", { level: 3 })
      .map((h) => h.textContent);
    expect(headings).toEqual(["Money in", "Credit & account", "Refunds & net", "Drawer"]);
    // meta, headline, groups, then Not taken at the till, then the note: in the plan's order
    const order = [
      "z-closed-line",
      "z-headline",
      "z-group-Money in",
      "z-group-Credit & account",
      "z-group-Refunds & net",
      "z-group-Drawer",
      "z-not-at-till",
      "z-note",
    ].map((id) => screen.getByTestId(id));
    for (let i = 1; i < order.length; i++) {
      expect(
        order[i - 1].compareDocumentPosition(order[i]) & Node.DOCUMENT_POSITION_FOLLOWING,
      ).toBe(Node.DOCUMENT_POSITION_FOLLOWING);
    }
  });

  it("prints every row of every group with its stored figure", () => {
    renderWithProviders(<ZReportBody snapshot={snap()} />);
    expect(row("Cash")).toHaveTextContent("$200.00");
    expect(row("Card")).toHaveTextContent("$90.00");
    expect(row("Check")).toHaveTextContent("$10.00");
    expect(row("Total")).toHaveTextContent("$300.00");
    expect(row("Pickup hand-overs (in till cash)")).toHaveTextContent("$60.00");
    expect(row("Pickup hand-overs (in till cash)")).toHaveTextContent("2 hand-overs");
    expect(row("On account")).toHaveTextContent("$12.50");
    expect(row("Cash refunds")).toHaveTextContent("$15.00");
    expect(row("Net collected")).toHaveTextContent("$285.00");
    expect(row("Opening float")).toHaveTextContent("$100.00");
    // 285 - 100 + 15
    expect(row("Cash from sales")).toHaveTextContent("$200.00");
    expect(row("Cash in drawer")).toHaveTextContent("$285.00");
    expect(row("Counted")).toHaveTextContent("$282.50");
    expect(row("Over/short")).toHaveTextContent("-$2.50");
  });

  it("prints zero rows as $0.00, never a dash or a blank", () => {
    renderWithProviders(<ZReportBody snapshot={snap()} />);
    for (const label of [
      "Other",
      "Store credit used",
      "Store credit issued",
      "Card refunds",
      "Check refunds",
      "Other refunds",
    ]) {
      expect(row(label)).toHaveTextContent("$0.00");
    }
    expect(screen.getByTestId("z-report").textContent).not.toMatch(/[—–]\s*\$|NaN|undefined/);
  });

  it("bolds exactly Net collected and Cash in drawer", () => {
    renderWithProviders(<ZReportBody snapshot={snap()} />);
    const bold = screen
      .getByTestId("z-report")
      .querySelectorAll('[data-testid^="z-row-"].font-bold');
    expect([...bold].map((b) => b.getAttribute("data-testid"))).toEqual([
      "z-row-Net collected",
      "z-row-Cash in drawer",
    ]);
  });

  it("prints 'Not recorded' for hand-overs on a close made before the field existed", () => {
    const { handOver: _drop, ...older } = TOTALS;
    void _drop;
    renderWithProviders(<ZReportBody snapshot={snap({ totals: older })} />);
    expect(row("Pickup hand-overs (in till cash)")).toHaveTextContent("Not recorded");
    expect(row("Pickup hand-overs (in till cash)")).not.toHaveTextContent("hand-overs ·");
  });

  it.each([
    [-2.5, "Counted $282.50 · Short $2.50", "-$2.50"],
    [0, "Counted $285.00 · Even $0.00", "$0.00"],
    [1, "Counted $286.00 · Over $1.00", "+$1.00"],
  ])("variance %s reads %s", (variance, headline, over) => {
    renderWithProviders(<ZReportBody snapshot={snap({ variance, countedCash: 285 + variance })} />);
    expect(screen.getByTestId("z-headline")).toHaveTextContent(headline);
    expect(row("Over/short")).toHaveTextContent(over);
  });

  it("shows Not taken at the till and warns only when a refund has no method", () => {
    const { unmount } = renderWithProviders(<ZReportBody snapshot={snap()} />);
    expect(screen.getByTestId("z-not-at-till")).toHaveTextContent("Not taken at the till: $40.00");
    expect(screen.queryByTestId("z-tender-warning")).toBeNull();
    unmount();
    renderWithProviders(
      <ZReportBody
        snapshot={snap({
          totals: { ...TOTALS, refunds: { ...TOTALS.refunds, tenderKnown: false } },
        })}
      />,
    );
    expect(screen.getByTestId("z-tender-warning")).toHaveTextContent(
      "Some refunds have no method. Cash in drawer may be high.",
    );
  });

  it("shows the note, and no note block when there is none", () => {
    const { unmount } = renderWithProviders(<ZReportBody snapshot={snap()} />);
    expect(screen.getByTestId("z-note")).toHaveTextContent("Counted twice");
    unmount();
    renderWithProviders(<ZReportBody snapshot={snap({ notes: null })} />);
    expect(screen.queryByTestId("z-note")).toBeNull();
  });

  it("leaves out 'by ...' when the closer is unknown", () => {
    renderWithProviders(<ZReportBody snapshot={snap({ closedByName: null })} />);
    expect(screen.getByTestId("z-closed-line").textContent).toMatch(/^Closed 9:42\s?PM$/);
  });

  it("shows the weekday on both ends of a window that crosses midnight", () => {
    renderWithProviders(
      <ZReportBody
        snapshot={snap({
          windowStart: "2026-10-09T01:00:00.000Z", // Thu 9:00 PM
          windowEnd: "2026-10-09T06:15:00.000Z", // Fri 2:15 AM
          closedAt: "2026-10-09T06:15:00.000Z",
        })}
      />,
    );
    expect(screen.getByTestId("z-window-line")).toHaveTextContent("Thu 9:00 PM – Fri 2:15 AM");
  });

  it("is full-screen on a phone with a 44px close and no customer names or sale lines", () => {
    renderWithProviders(<ZReportView snapshot={snap()} open onClose={() => {}} />);
    const dialog = screen.getByRole("dialog");
    expect(dialog.className).toMatch(/h-\[100dvh\]/);
    expect(dialog.className).toMatch(/w-screen/);
    expect(within(dialog).getByRole("button", { name: "Close" }).className).toMatch(/min-h-11/);
    expect(within(dialog).queryAllByRole("listitem")).toHaveLength(0);
  });
});
