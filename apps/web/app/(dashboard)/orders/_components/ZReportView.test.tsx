import * as React from "react";
import { fireEvent, renderWithProviders, screen, waitFor, within } from "@/test-utils/render";
import type { DayCloseSnapshot, DayCloseTotals } from "@routeflow/types";
import { Modal } from "@routeflow/ui/web";
import { ZReportBody, ZReportView } from "./ZReportView";

const post = jest.fn();
jest.mock("@/lib/api-client", () => ({
  apiClient: { get: jest.fn(), post: (...a: unknown[]) => post(...a) },
}));

/**
 * SA-750r3 §4: the Z view prints the groups of `dayCloseZSections` in the plan's order. Every figure below is the fixture's own;
 * the component derives nothing (Expected cash is the stored expectedCash, Net collected the stored netCollected).
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

beforeEach(() => {
  jest.clearAllMocks();
});

describe("ZReportView", () => {
  it("prints the title, the closer line, the window and the bold headline, then the four groups in order", () => {
    renderWithProviders(<ZReportView snapshot={snap()} open onClose={() => {}} />);
    expect(screen.getByRole("dialog", { name: "Z report · Fri, Oct 9" })).toBeInTheDocument();
    expect(screen.getByTestId("z-closed-line")).toHaveTextContent("Closed 9:42 PM by Sam");
    expect(screen.getByTestId("z-window-line")).toHaveTextContent("8:05 AM – 9:42 PM");
    const headline = screen.getByTestId("z-headline");
    // owner ruling 10-12: the variance verdict is the hero, "Counted" sits beneath it
    expect(headline).toHaveTextContent("Short $2.50");
    expect(headline.className).toMatch(/text-2xl font-semibold/);
    expect(screen.getByTestId("z-counted")).toHaveTextContent("Counted $282.50");

    const body = screen.getByTestId("z-report");
    const headings = within(body)
      .getAllByRole("heading", { level: 3 })
      .map((h) => h.textContent);
    expect(headings).toEqual(["Drawer", "Money in", "Credit & account", "Refunds & net"]);
    // meta, headline, counted, the Drawer right under it, the other groups, then the note: in the plan's order
    const order = [
      "z-closed-line",
      "z-headline",
      "z-counted",
      "z-group-Drawer",
      "z-group-Money in",
      "z-group-Credit & account",
      "z-group-Refunds & net",
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
    // one vocabulary with the email: the amount first, a space on both sides of every middle dot
    expect(row("Pickup hand-overs (in till cash)").querySelector("dd")?.textContent).toBe(
      "$60.00 · 2 hand-overs",
    );
    expect(row("On account")).toHaveTextContent("$12.50");
    expect(row("Cash refunds")).toHaveTextContent("$15.00");
    expect(row("Net collected")).toHaveTextContent("$285.00");
    expect(row("Opening float")).toHaveTextContent("$100.00");
    // 285 - 100 + 15
    expect(row("Cash from sales")).toHaveTextContent("$200.00");
    expect(row("Expected cash")).toHaveTextContent("$285.00");
    expect(row("Counted")).toHaveTextContent("$282.50");
    expect(row("Variance")).toHaveTextContent("-$2.50");
    // the unpaid pickups are a Drawer row, never an orphan line under the report
    expect(row("Unpaid pickups")).toHaveTextContent("$40.00");
    expect(within(screen.getByTestId("z-group-Drawer")).getByTestId("z-row-Unpaid pickups")).toBe(
      row("Unpaid pickups"),
    );
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

  it("bolds exactly Expected cash and Net collected", () => {
    renderWithProviders(<ZReportBody snapshot={snap()} />);
    const bold = screen
      .getByTestId("z-report")
      .querySelectorAll('[data-testid^="z-row-"].font-bold');
    expect([...bold].map((b) => b.getAttribute("data-testid"))).toEqual([
      "z-row-Expected cash",
      "z-row-Net collected",
    ]);
  });

  it("prints 'Not recorded' for hand-overs on a close made before the field existed", () => {
    const { handOver: _drop, ...older } = TOTALS;
    void _drop;
    renderWithProviders(<ZReportBody snapshot={snap({ totals: older })} />);
    expect(row("Pickup hand-overs (in till cash)")).toHaveTextContent("Not recorded");
    expect(row("Pickup hand-overs (in till cash)").querySelector("dd")?.textContent).toBe(
      "Not recorded",
    );
  });

  it.each([
    [-2.5, "Short $2.50", "Counted $282.50", "-$2.50"],
    [0, "Balanced", "Counted $285.00", "$0.00"],
    [1, "Over $1.00", "Counted $286.00", "+$1.00"],
  ])("variance %s reads %s", (variance, headline, counted, over) => {
    renderWithProviders(<ZReportBody snapshot={snap({ variance, countedCash: 285 + variance })} />);
    expect(screen.getByTestId("z-headline").textContent).toBe(headline);
    expect(screen.getByTestId("z-counted")).toHaveTextContent(counted);
    expect(row("Variance")).toHaveTextContent(over);
    for (const gone of ["Even", "Under", "Over/short"])
      expect(screen.getByTestId("z-report").textContent).not.toContain(gone);
  });

  it("shows Unpaid pickups in the Drawer and warns only when a refund has no method", () => {
    const { unmount } = renderWithProviders(<ZReportBody snapshot={snap()} />);
    expect(screen.queryByTestId("z-not-at-till")).toBeNull();
    expect(row("Unpaid pickups")).toHaveTextContent("$40.00");
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
      "Some refunds have no method. Expected cash may be high.",
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
    for (const b of within(dialog).getAllByRole("button", { name: "Close" }))
      expect(b.className).toMatch(/min-h-11/);
    expect(within(dialog).queryAllByRole("listitem")).toHaveLength(0);
  });

  it("never prints a middle dot glued to a word or a figure", () => {
    renderWithProviders(<ZReportView snapshot={snap()} open onClose={() => {}} />);
    const dialog = screen.getByRole("dialog");
    expect(dialog.textContent).not.toMatch(/\S·|·\S/);
  });
});

describe("ZReportView: actions (Print, Email, Close)", () => {
  const actions = () => screen.getByTestId("z-actions");

  it("puts Print first and primary, then Email, then Close, in a footer pinned below the report", () => {
    renderWithProviders(<ZReportView snapshot={snap()} open onClose={() => {}} />);
    const buttons = within(actions()).getAllByRole("button");
    expect(buttons.map((b) => b.textContent)).toEqual(["Print", "Email", "Close"]);
    // Print is the primary action: the filled variant, Email and Close the quiet one
    expect(buttons[0].className).toMatch(/bg-accent-strong/);
    expect(buttons[1].className).not.toMatch(/bg-accent-strong/);
    expect(buttons[2].className).not.toMatch(/bg-accent-strong/);
    // pinned footer: the Modal's own footer region, outside the scrolling body, after the report
    expect(
      screen.getByTestId("z-report").compareDocumentPosition(actions()) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBe(Node.DOCUMENT_POSITION_FOLLOWING);
    expect(actions().closest("[class*='shrink-0']")).not.toBeNull();
  });

  it("every action is a 44px target, and the modal's own X stays", () => {
    renderWithProviders(<ZReportView snapshot={snap()} open onClose={() => {}} />);
    for (const b of within(actions()).getAllByRole("button"))
      expect(b.className).toMatch(/min-h-11/);
    const dialog = screen.getByRole("dialog");
    expect(within(dialog).getAllByRole("button", { name: "Close" })).toHaveLength(2); // the X and the footer
  });
  it("focus opens on the title, not on the X", () => {
    renderWithProviders(<ZReportView snapshot={snap()} open onClose={() => {}} />);
    expect(document.activeElement).toBe(
      screen.getByRole("heading", { name: "Z report · Fri, Oct 9" }),
    );
  });

  it("the action row is hidden when printing, and the report prints alone", () => {
    renderWithProviders(<ZReportView snapshot={snap()} open onClose={() => {}} />);
    expect(actions().parentElement?.className).toMatch(/print:hidden/);
    const dialog = screen.getByRole("dialog");
    expect(dialog.className).toMatch(/z-report-print-root/);
    expect(dialog.className).toMatch(/print:static/);
    expect(dialog.className).toMatch(/print:h-auto/);
    expect(dialog.className).toMatch(/print:overflow-visible/);
    expect(screen.getByTestId("z-report").className).toMatch(/print:text-black/);
  });

  it("Print calls window.print", () => {
    const print = jest.spyOn(window, "print").mockImplementation(() => {});
    renderWithProviders(<ZReportView snapshot={snap()} open onClose={() => {}} />);
    fireEvent.click(within(actions()).getByRole("button", { name: "Print" }));
    expect(print).toHaveBeenCalledTimes(1);
    print.mockRestore();
  });

  it("marks the body while the Z view is open so the page prints only the report", () => {
    const { rerender } = renderWithProviders(
      <ZReportView snapshot={snap()} open onClose={() => {}} />,
    );
    expect(document.body.classList.contains("z-report-open")).toBe(true);
    rerender(<ZReportView snapshot={snap()} open={false} onClose={() => {}} />);
    expect(document.body.classList.contains("z-report-open")).toBe(false);
  });

  it("Close closes the Z view", () => {
    const onClose = jest.fn();
    renderWithProviders(<ZReportView snapshot={snap()} open onClose={onClose} />);
    fireEvent.click(within(actions()).getByRole("button", { name: "Close" }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("Email posts the report route for this close, even when the report was already sent", async () => {
    post.mockResolvedValue({ data: { reportSent: true } });
    renderWithProviders(
      <ZReportView snapshot={snap({ reportSent: true })} open onClose={() => {}} />,
    );
    fireEvent.click(within(actions()).getByRole("button", { name: "Email" }));
    await waitFor(() =>
      expect(post).toHaveBeenCalledWith("/orders/counter-sale/day-close/dc1/report"),
    );
    expect(await screen.findByTestId("z-resend-status")).toHaveTextContent(
      "Z report emailed to admins",
    );
  });

  it("an Email the server could not deliver shows the fixed failure copy", async () => {
    post.mockResolvedValue({ data: { reportSent: false } });
    renderWithProviders(<ZReportView snapshot={snap()} open onClose={() => {}} />);
    fireEvent.click(within(actions()).getByRole("button", { name: "Email" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Could not send the report. Try again.",
    );
  });

  it("a failed Email shows fixed copy, never the server text", async () => {
    post.mockRejectedValue({ response: { status: 500, data: { message: "smtp password wrong" } } });
    renderWithProviders(<ZReportView snapshot={snap()} open onClose={() => {}} />);
    fireEvent.click(within(actions()).getByRole("button", { name: "Email" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Could not send the report. Try again.",
    );
    expect(document.body.textContent).not.toMatch(/smtp password/);
  });
});

describe("ZReportView: Escape closes only the innermost layer", () => {
  function Sheet() {
    const [sheet, setSheet] = React.useState(true);
    const [z, setZ] = React.useState(true);
    return (
      <>
        <Modal open={sheet} onClose={() => setSheet(false)} title="Today's sales">
          <ZReportView snapshot={snap()} open={z} onClose={() => setZ(false)} />
        </Modal>
      </>
    );
  }
  it("the first Escape leaves the Z view, the second leaves the sheet", async () => {
    renderWithProviders(<Sheet />);
    expect(screen.getByRole("dialog", { name: "Z report · Fri, Oct 9" })).toBeInTheDocument();
    fireEvent.keyDown(document.activeElement ?? document.body, { key: "Escape", code: "Escape" });
    await waitFor(() =>
      expect(screen.queryByRole("dialog", { name: "Z report · Fri, Oct 9" })).toBeNull(),
    );
    expect(screen.getByRole("dialog", { name: "Today's sales" })).toBeInTheDocument();
    fireEvent.keyDown(document.activeElement ?? document.body, { key: "Escape", code: "Escape" });
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  });
});
