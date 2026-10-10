import type { DayCloseSnapshot } from "@routeflow/pricing";
import { buildZReportEmail, zMoney, zTime } from "./z-report-email";

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
  },
  notes: null,
  reopenedAt: null,
  reopenedById: null,
  reportSent: null,
  ...over,
});

describe("zMoney / zTime", () => {
  it("formats whole cents with the sign in front", () => {
    expect(zMoney(0)).toBe("$0.00");
    expect(zMoney(12.3)).toBe("$12.30");
    expect(zMoney(-1.5)).toBe("-$1.50");
    expect(zMoney(18_941_000)).toBe("$18,941,000.00");
  });
  it("shows the close in the tenant zone, UTC when the zone is unusable", () => {
    expect(zTime("2026-10-08T03:59:00.000Z", "America/New_York")).toContain("11:59 PM");
    expect(zTime("2026-10-08T03:59:00.000Z", "Mars/Olympus")).toContain("UTC");
  });
});

describe("buildZReportEmail", () => {
  const mail = buildZReportEmail({ businessName: "Acme Wholesale", snapshot: snap() });

  it("carries the date, the business and who closed it in the tenant zone", () => {
    expect(mail.subject).toBe("Z report for 2026-10-07 - Acme Wholesale");
    for (const body of [mail.html, mail.text]) {
      expect(body).toContain("2026-10-07");
      expect(body).toContain("op-acme");
      expect(body).toContain("11:59 PM");
    }
  });

  it("carries sales, money in by method, refunds by tender, store credit, on account, net, the drawer and not-at-till", () => {
    for (const needle of [
      "$480.75", // sales total
      "$112.50", // cash in
      "$300.00", // card in
      "$452.50", // total in
      "$20.00", // card refunds
      "$15.00", // tender not recorded
      "$12.25", // credit used
      "$18.00 (2)", // credit issued
      "$30.50", // on account
      "$417.50", // net collected
      "$100.00", // float
      "$212.50", // expected
      "$210.00", // counted
      "Short $2.50", // variance
      "$64.00", // not at the till
    ]) {
      expect(mail.text).toContain(needle);
      expect(mail.html).toContain(needle);
    }
  });

  it("warns when a refund had no recorded tender, and not otherwise", () => {
    expect(mail.text).toContain("Warning: 1 refund has no recorded tender");
    expect(mail.html).toContain("Warning: 1 refund has no recorded tender");
    const clean = buildZReportEmail({
      businessName: "Acme",
      snapshot: snap({
        totals: {
          ...snap().totals,
          refunds: { ...snap().totals.refunds, tenderKnown: true, unknownTenderCount: 0, other: 0 },
        },
      }),
    });
    expect(clean.text).not.toContain("Warning");
  });

  it("variance reads Over, Short or Even", () => {
    const t = (variance: number) =>
      buildZReportEmail({ businessName: "A", snapshot: snap({ variance }) }).text;
    expect(t(4)).toContain("Variance: Over $4.00");
    expect(t(-4)).toContain("Variance: Short $4.00");
    expect(t(0)).toContain("Variance: Even");
  });

  it("has no customer, no line and no row", () => {
    expect(mail.html + mail.text).not.toMatch(/customer|walk-in|sku|line item/i);
  });

  it("escapes every interpolated value: the business name, the closer, the zone-formatted text and the notes", () => {
    const evil = `<img src=x onerror="alert(1)">`;
    const m = buildZReportEmail({
      businessName: evil,
      snapshot: snap({ closedByName: evil, notes: evil, day: `2026-10-07${evil}` }),
    });
    expect(m.html).not.toContain("<img");
    expect(m.html).toContain("&lt;img src=x onerror=&quot;alert(1)&quot;&gt;");
    expect(m.subject).toContain(evil); // the subject is plain text, not HTML
  });

  it("an unknown closer reads 'an unknown user'", () => {
    const m = buildZReportEmail({ businessName: "A", snapshot: snap({ closedByName: null }) });
    expect(m.text).toContain("by an unknown user");
  });
});
