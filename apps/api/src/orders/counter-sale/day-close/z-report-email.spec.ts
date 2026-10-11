import type { DayCloseSnapshot } from "@routeflow/types";
import { buildZReportEmail, zMoney } from "./z-report-email";

/** The Z report body: the figures a manager reads, the warning, no customers, and every interpolated value escaped. Placeholders only (acme). */
const snap = (over: Partial<DayCloseSnapshot> = {}): DayCloseSnapshot => ({
  id: "c-1",
  registerKey: "main",
  day: "2026-10-07",
  zone: "America/New_York",
  windowStart: "2026-10-07T04:00:00.000Z",
  windowEnd: "2026-10-08T03:59:00.000Z",
  closedAt: "2026-10-08T03:59:00.000Z",
  closedById: "u-1",
  closedByName: "op-acme",
  openingFloat: 100,
  expectedCash: 212.5,
  countedCash: 210,
  variance: -2.5,
  denominations: [],
  totals: {
    salesCount: 12,
    salesTotal: 480.75,
    moneyIn: { cash: 112.5, card: 300, check: 40, other: 0, total: 452.5 },
    refunds: {
      count: 3,
      cash: 0,
      card: 20,
      check: 0,
      other: 15,
      total: 35,
      tenderKnown: false,
      unknownTenderCount: 1,
    },
    storeCreditUsed: 12.25,
    storeCreditIssued: { count: 2, amount: 18 },
    onAccount: 30.5,
    netCollected: 417.5,
    notAtTill: 64,
    handOver: { count: 3, cash: 45.25 },
  },
  notes: null,
  reopenedAt: null,
  reopenedById: null,
  reportSent: null,
  ...over,
});

describe("zMoney", () => {
  it("formats whole cents with the sign in front", () => {
    expect(zMoney(0)).toBe("$0.00");
    expect(zMoney(12.3)).toBe("$12.30");
    expect(zMoney(-1.5)).toBe("-$1.50");
    expect(zMoney(18_941_000)).toBe("$18,941,000.00");
  });
});

const ZERO_TOTALS = {
  salesCount: 0,
  salesTotal: 0,
  moneyIn: { cash: 0, card: 0, check: 0, other: 0, total: 0 },
  refunds: {
    count: 0,
    cash: 0,
    card: 0,
    check: 0,
    other: 0,
    total: 0,
    tenderKnown: true,
    unknownTenderCount: 0,
  },
  storeCreditUsed: 0,
  storeCreditIssued: { count: 0, amount: 0 },
  onAccount: 0,
  netCollected: 0,
  notAtTill: 0,
  handOver: { count: 0, cash: 0 },
};
const MINUS = "−";
const HEADINGS = ["Money in", "Credit & account", "Refunds & net", "Drawer"];
const LABELS = [
  "Cash",
  "Card",
  "Check",
  "Other",
  "Total",
  "Pickup hand-overs (in till cash)",
  "Store credit used",
  "Store credit issued",
  "On account",
  "Cash refunds",
  "Card refunds",
  "Check refunds",
  "Other refunds",
  "Net collected",
  "Opening float",
  "Cash from sales",
  "Cash in drawer",
  "Counted",
  "Over/short",
];

/** every needle appears, in this order, in the body */
function inOrder(body: string, needles: string[]) {
  let at = -1;
  for (const n of needles) {
    const next = body.indexOf(n, at + 1);
    expect({ needle: n, found: next > at }).toEqual({ needle: n, found: true });
    at = next;
  }
}

describe("buildZReportEmail", () => {
  const mail = buildZReportEmail({ businessName: "Acme Wholesale", snapshot: snap() });

  it("keeps the subject", () => {
    expect(mail.subject).toBe("Z report for 2026-10-07 - Acme Wholesale");
  });

  it("opens with the title, the closer and the window in the tenant zone", () => {
    for (const body of [mail.html, mail.text]) {
      inOrder(body, ["Z report · Wed, Oct 7", "Closed 11:59 PM by op-acme", "12:00 AM"]);
    }
    expect(mail.text.split("\n").slice(0, 3)).toEqual([
      "Z report · Wed, Oct 7",
      "Closed 11:59 PM by op-acme",
      "Tue 12:00 AM – Tue 11:59 PM".replace(/Tue /g, ""),
    ]);
  });

  it("prints sections in the flow-plan order in both bodies", () => {
    const order = [
      "Z report",
      "Closed ",
      "Counted $210.00 · Short $2.50",
      ...HEADINGS,
      "Not taken at the till: $64.00",
      "Some refunds have no method. Cash in drawer may be high.",
    ];
    inOrder(mail.text, order);
    inOrder(
      mail.html,
      order.map((n) => n.replace("&", "&amp;")),
    );
    inOrder(mail.text, LABELS);
    inOrder(mail.html, LABELS);
  });

  it("each group lists its own rows under its own heading", () => {
    const text = mail.text;
    const slice = (from: string, to: string) =>
      text.slice(text.indexOf(from), to ? text.indexOf(to) : undefined);
    expect(slice("Money in", "Credit & account")).toContain("Pickup hand-overs");
    expect(slice("Credit & account", "Refunds & net")).toContain("On account: $30.50");
    expect(slice("Refunds & net", "Drawer")).toContain("Net collected: $417.50");
    expect(slice("Drawer", "Not taken")).toContain("Over/short: " + MINUS + "$2.50");
  });

  it("prints the figures", () => {
    for (const needle of [
      "Cash: $112.50",
      "Card: $300.00",
      "Check: $40.00",
      "Other: $0.00",
      "Total: $452.50",
      "Store credit used: $12.25",
      "Store credit issued: $18.00",
      "On account: $30.50",
      "Card refunds: $20.00",
      "Other refunds: $15.00",
      "Opening float: $100.00",
      "Cash from sales: $112.50",
      "Cash in drawer: $212.50",
      "Counted: $210.00",
    ]) {
      expect(mail.text).toContain(needle);
    }
  });

  it("an all-zero close prints every row at $0.00, never a dash", () => {
    const z = buildZReportEmail({
      businessName: "A",
      snapshot: snap({
        openingFloat: 0,
        expectedCash: 0,
        countedCash: 0,
        variance: 0,
        totals: ZERO_TOTALS,
      }),
    });
    for (const label of LABELS) {
      const line = z.text.split("\n").find((l) => l.startsWith(`  ${label}:`));
      expect(line).toBeDefined();
      expect(line).toMatch(/\$0\.00$|0 · \$0\.00$/);
      expect(z.html).toContain(label);
    }
    expect(z.text).toContain("Counted $0.00 · Even $0.00");
    expect(z.text).toContain("Not taken at the till: $0.00");
    expect(z.text).not.toContain("Some refunds have no method");
    expect(z.text).not.toMatch(/: -$|: —|: –/m);
  });

  it("bolds Net collected and Cash in drawer in the html, and the headline", () => {
    expect(mail.html).toContain("<strong>Net collected</strong>");
    expect(mail.html).toContain("<strong>$417.50</strong>");
    expect(mail.html).toContain("<strong>Cash in drawer</strong>");
    expect(mail.html).toContain("<strong>$212.50</strong>");
    expect(mail.html).toContain("<strong>Counted $210.00 · Short $2.50</strong>");
    expect(mail.html).not.toContain("<strong>Cash</strong>");
  });

  it("the headline reads Short, Over or Even, and over/short is signed", () => {
    const t = (variance: number) =>
      buildZReportEmail({ businessName: "A", snapshot: snap({ countedCash: 100, variance }) });
    expect(t(-4).text).toContain("Counted $100.00 · Short $4.00");
    expect(t(-4).text).toContain("Over/short: " + MINUS + "$4.00");
    expect(t(1).text).toContain("Counted $100.00 · Over $1.00");
    expect(t(1).text).toContain("Over/short: +$1.00");
    expect(t(0).text).toContain("Counted $100.00 · Even $0.00");
    expect(t(0).text).toContain("Over/short: $0.00");
    expect(t(1).html).toContain("<strong>Counted $100.00 · Over $1.00</strong>");
  });

  it("prints the pickup hand-over row as 'N · $X' in both bodies", () => {
    expect(mail.text).toContain("  Pickup hand-overs (in till cash): 3 · $45.25");
    expect(mail.html).toContain("Pickup hand-overs (in till cash)");
    expect(mail.html).toContain("3 · $45.25");
  });

  it("a stored close WITHOUT handOver prints 'Not recorded' (never a dash, never $0.00)", () => {
    const { handOver: _omit, ...legacyTotals } = snap().totals;
    const legacy = buildZReportEmail({
      businessName: "Acme",
      snapshot: snap({ totals: legacyTotals }),
    });
    expect(legacy.text).toContain("  Pickup hand-overs (in till cash): Not recorded");
    expect(legacy.html).toContain("Not recorded");
    expect(legacy.text).not.toMatch(/Pickup hand-overs[^\n]*: (-|\$0\.00)/);
  });

  it("a recorded zero prints 0 · $0.00, which is different from not recorded", () => {
    const m = buildZReportEmail({
      businessName: "Acme",
      snapshot: snap({ totals: { ...snap().totals, handOver: { count: 0, cash: 0 } } }),
    });
    expect(m.text).toContain("Pickup hand-overs (in till cash): 0 · $0.00");
  });

  it("the not-taken line always prints; the tender warning only when a refund has no method", () => {
    expect(mail.text).toContain("Not taken at the till: $64.00");
    expect(mail.html).toContain("Not taken at the till: $64.00");
    expect(mail.html).toContain(
      "<strong>Some refunds have no method. Cash in drawer may be high.</strong>",
    );
    const clean = buildZReportEmail({
      businessName: "Acme",
      snapshot: snap({
        totals: {
          ...snap().totals,
          refunds: { ...snap().totals.refunds, tenderKnown: true, unknownTenderCount: 0, other: 0 },
        },
      }),
    });
    expect(clean.text).not.toContain("Some refunds have no method");
    expect(clean.html).not.toContain("Some refunds have no method");
    expect(clean.text).toContain("Not taken at the till: $64.00");
  });

  it("a window across midnight carries the weekday on both ends", () => {
    const m = buildZReportEmail({
      businessName: "A",
      snapshot: snap({
        windowStart: "2026-10-08T01:00:00.000Z", // Wed 9:00 PM New York
        windowEnd: "2026-10-09T01:42:00.000Z", // Thu 9:42 PM
        closedAt: "2026-10-09T01:42:00.000Z",
      }),
    });
    for (const body of [m.text, m.html]) {
      expect(body).toContain("Wed 9:00 PM – Thu 9:42 PM");
      expect(body).toContain("Z report · Thu, Oct 8");
    }
    // same-day windows carry no weekday
    expect(mail.text).toContain("12:00 AM – 11:59 PM");
  });

  it("an unknown closer prints 'Closed 11:59 PM' with no 'by'", () => {
    const m = buildZReportEmail({ businessName: "A", snapshot: snap({ closedByName: null }) });
    expect(m.text.split("\n")[1]).toBe("Closed 11:59 PM");
    expect(m.html).not.toContain(" by ");
  });

  it("falls back to UTC when the zone is unusable", () => {
    const m = buildZReportEmail({ businessName: "A", snapshot: snap({ zone: "Mars/Olympus" }) });
    expect(m.text).toContain("UTC");
  });

  it("prints the note, escaped and labelled, and nothing when there is none", () => {
    const noted = buildZReportEmail({
      businessName: "A",
      snapshot: snap({ notes: "Drawer <b>short</b> & late" }),
    });
    expect(noted.text).toContain("Note: Drawer <b>short</b> & late");
    expect(noted.html).toContain(
      "<strong>Note</strong>: Drawer &lt;b&gt;short&lt;/b&gt; &amp; late",
    );
    expect(mail.text).not.toContain("Note");
    expect(mail.html).not.toContain("Note");
  });

  it("has no customer, no line and no row, and none of the old sections", () => {
    expect(mail.html + mail.text).not.toMatch(/customer|walk-in|sku|line item/i);
    for (const gone of ["Sales total", "Variance", "Warning:", "Notes", "Window "]) {
      expect(mail.text).not.toContain(gone);
    }
  });

  it("escapes every interpolated value: the closer, the notes and the day", () => {
    const evil = `<img src=x onerror="alert(1)">`;
    const m = buildZReportEmail({
      businessName: evil,
      snapshot: snap({ closedByName: evil, notes: evil, day: `2026-10-07${evil}` }),
    });
    expect(m.html).not.toContain("<img");
    expect(m.html).toContain("&lt;img src=x onerror=&quot;alert(1)&quot;&gt;");
    expect(m.subject).toContain(evil); // the subject is plain text, not HTML
  });
});
