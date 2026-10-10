/**
 * #2404 (P0, epic #2400, SA-436 PR-3): the order's "Applied credits" panel is built from the
 * credit ACTUALLY on the order's invoices (every non-VOID CREDIT_NOTE payment on a non-VOID
 * invoice, automatic or applied) plus the hand-picked intents not yet applied. Before, it listed
 * the intents only, so a credit auto-applied on send was invisible on the order. One pure rule
 * (packages/types), shared by web and mobile.
 */
import { readFileSync } from "fs";
import { join } from "path";
import {
  AUTO_APPLIED_FLAG_MIGRATION,
  AUTO_APPLIED_FLAG_SINCE,
  orderAppliedCredits,
  requestedLabel,
  type OrderAppliedCreditRow,
  type OrderAppliedCreditsInput,
} from "@routeflow/types";

/** The applied-row label (`source` exists only on kind "applied"). */
const sourceOf = (r: OrderAppliedCreditRow | undefined) =>
  r && r.kind === "applied" ? r.source : undefined;

const CN = (id: string, n: string, reason: string | null = null) => ({
  id,
  creditNoteNumber: n,
  reason,
});

const base: OrderAppliedCreditsInput = {
  invoices: [
    {
      id: "inv-1",
      invoiceNumber: "INV-1",
      status: "SENT",
      payments: [
        {
          id: "p1",
          amount: "12.50",
          creditNoteId: "cn-a",
          autoApplied: true,
          creditNote: CN("cn-a", "CN-A", "old test credit"),
        },
        {
          id: "p2",
          amount: "5.00",
          creditNoteId: "cn-b",
          autoApplied: false,
          creditNote: CN("cn-b", "CN-B"),
        },
      ],
    },
    {
      id: "inv-2",
      invoiceNumber: "INV-2",
      status: "SENT",
      payments: [
        {
          id: "p3",
          amount: "3.25",
          creditNoteId: "cn-b",
          autoApplied: false,
          creditNote: CN("cn-b", "CN-B"),
        },
      ],
    },
  ],
  orderCreditNotes: [
    { id: "oc-b", creditNoteId: "cn-b", amount: "8.25", creditNote: CN("cn-b", "CN-B") },
    {
      id: "oc-c",
      creditNoteId: "cn-c",
      amount: null,
      creditNote: CN("cn-c", "CN-C", "return R-9"),
    },
  ],
};

describe("orderAppliedCredits (#2404)", () => {
  it("lists every applied credit payment, automatic and applied, with its invoice", () => {
    const rows = orderAppliedCredits(base).filter((r) => r.kind === "applied");
    expect(rows).toEqual([
      expect.objectContaining({
        paymentId: "p1",
        creditNoteNumber: "CN-A",
        invoiceId: "inv-1",
        invoiceNumber: "INV-1",
        amount: 12.5,
        source: "automatic",
      }),
      expect.objectContaining({
        paymentId: "p2",
        creditNoteNumber: "CN-B",
        invoiceNumber: "INV-1",
        amount: 5,
        source: "applied",
      }),
      expect.objectContaining({
        paymentId: "p3",
        creditNoteNumber: "CN-B",
        invoiceNumber: "INV-2",
        amount: 3.25,
        source: "applied",
      }),
    ]);
  });

  it("an auto-applied credit with NO intent on the order still shows (the incident)", () => {
    const rows = orderAppliedCredits(base);
    expect(rows.some((r) => r.creditNoteId === "cn-a" && sourceOf(r) === "automatic")).toBe(true);
    expect(base.orderCreditNotes!.some((oc) => oc.creditNoteId === "cn-a")).toBe(false);
  });

  it("a payment with autoApplied=false reads as a neutral 'applied', never 'manual' (SA-436 review)", () => {
    const row = orderAppliedCredits(base).find((r) => r.paymentId === "p3")!;
    expect(sourceOf(row)).toBe("applied");
    expect(
      orderAppliedCredits(base).some((r) => (r as { source?: string }).source === "manual"),
    ).toBe(false);
  });

  it("THE INCIDENT: a pre-#2423 sweep payment (autoApplied=false) of a note the sweep auto-applied, with no order intent, reads 'automatic'", () => {
    const rows = orderAppliedCredits({
      invoices: [
        {
          id: "inv-1",
          invoiceNumber: "INV-1",
          status: "SENT",
          payments: [
            {
              id: "old",
              amount: "9.00",
              creditNoteId: "cn-old",
              autoApplied: false,
              createdAt: "2026-09-20T00:00:00.000Z",
              creditNote: {
                id: "cn-old",
                creditNoteNumber: "CN-OLD",
                reason: "old test credit",
                autoApplied: true,
              },
            },
            {
              id: "picked",
              amount: "4.00",
              creditNoteId: "cn-pick",
              autoApplied: false,
              createdAt: "2026-09-20T00:00:00.000Z",
              creditNote: { id: "cn-pick", creditNoteNumber: "CN-PICK", autoApplied: true },
            },
          ],
        },
      ],
      orderCreditNotes: [{ id: "oc", creditNoteId: "cn-pick", amount: null }],
    });
    expect(sourceOf(rows.find((r) => r.paymentId === "old"))).toBe("automatic");
    // a hand-picked note that was also once auto-applied elsewhere: the pick decides, so neutral
    expect(sourceOf(rows.find((r) => r.paymentId === "picked"))).toBe("applied");
  });

  it("each applied row carries the (note, invoice) pair total the server's unapply reverses", () => {
    const rows = orderAppliedCredits({
      invoices: [
        {
          id: "inv-1",
          invoiceNumber: "INV-1",
          status: "SENT",
          payments: [
            { id: "a", amount: "5.00", creditNoteId: "cn-b", autoApplied: false },
            { id: "b", amount: "2.50", creditNoteId: "cn-b", autoApplied: false },
            { id: "c", amount: "1.00", creditNoteId: "cn-x", autoApplied: false },
          ],
        },
        {
          id: "inv-2",
          invoiceNumber: "INV-2",
          status: "SENT",
          payments: [{ id: "d", amount: "3.25", creditNoteId: "cn-b", autoApplied: false }],
        },
      ],
      orderCreditNotes: [],
    });
    const byId = Object.fromEntries(rows.map((r) => [r.paymentId, r]));
    expect((byId.a as any).pairTotal).toBe(7.5);
    expect((byId.b as any).pairTotal).toBe(7.5);
    expect((byId.c as any).pairTotal).toBe(1);
    expect((byId.d as any).pairTotal).toBe(3.25);
  });

  it("an intent already applied is not listed twice; an unapplied one shows as pending", () => {
    const pending = orderAppliedCredits(base).filter((r) => r.kind === "pending");
    expect(pending).toEqual([
      expect.objectContaining({
        creditNoteId: "cn-c",
        creditNoteNumber: "CN-C",
        requested: null,
        reason: "return R-9",
      }),
    ]);
  });

  it("VOID invoices and VOID / non-credit payments are excluded", () => {
    const rows = orderAppliedCredits({
      invoices: [
        {
          id: "v",
          invoiceNumber: "INV-V",
          status: "VOID",
          payments: [
            {
              id: "x",
              amount: "9",
              creditNoteId: "cn-v",
              autoApplied: false,
              creditNote: CN("cn-v", "CN-V"),
            },
          ],
        },
        {
          id: "i",
          invoiceNumber: "INV-I",
          status: "PAID",
          payments: [
            {
              id: "y",
              amount: "4",
              creditNoteId: "cn-y",
              status: "VOID",
              autoApplied: false,
              creditNote: CN("cn-y", "CN-Y"),
            },
            { id: "z", amount: "7", creditNoteId: null, method: "CASH", autoApplied: false },
            {
              id: "w",
              amount: "2",
              creditNoteId: "cn-w",
              method: "CREDIT_NOTE",
              autoApplied: false,
              creditNote: CN("cn-w", "CN-W"),
            },
          ],
        },
      ],
      orderCreditNotes: [],
    });
    expect(rows.map((r) => r.paymentId)).toEqual(["w"]);
  });

  it("an empty order gives an empty panel", () => {
    expect(orderAppliedCredits({ invoices: [], orderCreditNotes: [] })).toEqual([]);
    expect(orderAppliedCredits({})).toEqual([]);
  });
});

describe("requestedLabel (#2600): say what happens to the rest of a partly-requested credit", () => {
  const fmt = (n: number) => `$${n.toFixed(2)}`;
  const pendingFor = (amount: number | null, total?: number | string | null) =>
    orderAppliedCredits({
      orderCreditNotes: [
        {
          id: "oc",
          creditNoteId: "cn",
          amount,
          creditNote: { id: "cn", creditNoteNumber: "CN-1", amount: total },
        },
      ],
    })[0] as Extract<OrderAppliedCreditRow, { kind: "pending" }>;

  it("intent below the note total names the rest", () => {
    const row = pendingFor(20, 50);
    expect(row.creditNoteTotal).toBe(50);
    expect(requestedLabel(row, fmt)).toBe(
      "Requested $20.00 of $50.00 (the rest stays as store credit)",
    );
  });
  it("intent equal to the total is today's label", () => {
    expect(requestedLabel(pendingFor(50, "50.00"), fmt)).toBe("Requested $50.00");
  });
  it("note total absent is never invented", () => {
    const row = pendingFor(20, undefined);
    expect(row.creditNoteTotal).toBeNull();
    expect(requestedLabel(row, fmt)).toBe("Requested $20.00");
  });
  it("no intent stays 'Up to remaining'", () => {
    expect(requestedLabel(pendingFor(null, 50), fmt)).toBe("Up to remaining");
  });
});

describe("SA-551a: the legacy 'Automatic' fallback is dated", () => {
  const one = (createdAt?: string | Date) =>
    orderAppliedCredits({
      invoices: [
        {
          id: "inv-1",
          invoiceNumber: "INV-1",
          status: "SENT",
          payments: [
            {
              id: "p",
              amount: "1.00",
              creditNoteId: "cn",
              autoApplied: false,
              ...(createdAt === undefined ? {} : { createdAt }),
              creditNote: { id: "cn", creditNoteNumber: "CN", autoApplied: true },
            },
          ],
        },
      ],
    })[0];

  it("(a) a post-cutoff manual payment on a once-swept note reads 'applied'", () => {
    expect(sourceOf(one("2026-09-28T10:00:00.000Z"))).toBe("applied");
    expect(sourceOf(one(new Date(Date.parse(AUTO_APPLIED_FLAG_SINCE) + 1)))).toBe("applied");
  });
  it("(b) a pre-cutoff payment with the note flag and no intent reads 'automatic'", () => {
    expect(sourceOf(one("2026-09-20T00:00:00.000Z"))).toBe("automatic");
  });
  it("(c) an undated payment does not take the fallback", () => {
    expect(sourceOf(one())).toBe("applied");
  });
  it("(d) the cutoff is a valid instant after the migration folder's timestamp and before now", () => {
    const t = Date.parse(AUTO_APPLIED_FLAG_SINCE);
    expect(Number.isNaN(t)).toBe(false);
    expect(new Date(t).toISOString()).toBe(AUTO_APPLIED_FLAG_SINCE);
    const m = /^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})_/.exec(AUTO_APPLIED_FLAG_MIGRATION)!;
    const folder = Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]);
    expect(folder).toBe(Date.parse("2026-09-27T04:30:00Z"));
    expect(t).toBeGreaterThan(folder);
    expect(t).toBeLessThan(Date.now());
  });
  it("(e) the documented migration adds InvoicePayment.autoApplied", () => {
    const sql = readFileSync(
      join(__dirname, "../../prisma/migrations", AUTO_APPLIED_FLAG_MIGRATION, "migration.sql"),
      "utf8",
    );
    expect(sql).toMatch(/ALTER TABLE\s+"InvoicePayment"[\s\S]*ADD COLUMN[\s\S]*"autoApplied"/i);
  });
});
