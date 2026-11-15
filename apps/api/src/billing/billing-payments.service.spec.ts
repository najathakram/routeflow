import { Test } from "@nestjs/testing";
import { PrismaService } from "../prisma/prisma.service";
import { StripeService } from "./stripe.service";
import { BillingPaymentsService, PAYMENTS_PAGE_SIZE } from "./billing-payments.service";

// SA-1146 B-4: the Billing payments list. Mocked at the module boundary: Prisma and StripeService.

type RfRow = {
  id: string;
  tenantId: string;
  number: string;
  amount: number;
  currency: string;
  status: string;
  issuedAt: Date;
};
type StripeInv = {
  id: string;
  customer: string;
  created: number;
  amount_paid: number;
  currency: string;
  number: string | null;
  hosted_invoice_url: string | null;
};

const sec = (iso: string) => Math.floor(new Date(iso).getTime() / 1000);

function build(opts: {
  subs: Record<string, string | null>;
  rf: RfRow[];
  stripe: StripeInv[];
  stripeFails?: boolean;
}) {
  const listPaid = jest.fn(
    async (customerId: string, o: { limit: number; startingAfter?: string }) => {
      if (opts.stripeFails) throw new Error("stripe down");
      const all = opts.stripe
        .filter((i) => i.customer === customerId)
        .sort((a, b) => b.created - a.created);
      const start = o.startingAfter ? all.findIndex((i) => i.id === o.startingAfter) + 1 : 0;
      const rows = all.slice(start, start + o.limit);
      return { rows, hasMore: start + o.limit < all.length };
    },
  );
  const rfFindMany = jest.fn(async (args: any) => {
    let rows = opts.rf.filter(
      (r) => r.tenantId === args.where.tenantId && r.status === args.where.status,
    );
    if (args.where.OR) {
      rows = rows.filter((r) =>
        args.where.OR.some(
          (c: any) =>
            (c.issuedAt?.lt && r.issuedAt < c.issuedAt.lt) ||
            (c.issuedAt instanceof Date && +r.issuedAt === +c.issuedAt && r.id < c.id.lt),
        ),
      );
    }
    rows = [...rows].sort((a, b) => +b.issuedAt - +a.issuedAt || (a.id < b.id ? 1 : -1));
    return rows.slice(0, args.take);
  });
  const prisma = {
    tenantSubscription: {
      findUnique: jest.fn(async (args: any) => {
        const id = opts.subs[args.where.tenantId];
        return id === undefined ? null : { stripeCustomerId: id };
      }),
    },
    rfInvoice: { findMany: rfFindMany },
  };
  const stripe = { isConfigured: true, listPaidCustomerInvoices: listPaid };
  return { prisma, stripe, listPaid, rfFindMany };
}

async function make(h: ReturnType<typeof build>) {
  const mod = await Test.createTestingModule({
    providers: [
      BillingPaymentsService,
      { provide: PrismaService, useValue: h.prisma },
      { provide: StripeService, useValue: h.stripe },
    ],
  }).compile();
  return mod.get(BillingPaymentsService);
}

const inv = (n: number, iso: string, customer = "cus_a"): StripeInv => ({
  id: `in_${n}`,
  customer,
  created: sec(iso),
  amount_paid: 12_345,
  currency: "usd",
  number: `ACME-${n}`,
  hosted_invoice_url: `https://invoice.example/${n}`,
});
const rf = (n: number, iso: string, tenantId = "t1"): RfRow => ({
  id: `rf_${String(n).padStart(3, "0")}`,
  tenantId,
  number: `RF-2026-${String(n).padStart(4, "0")}`,
  amount: 99.5,
  currency: "USD",
  status: "PAID",
  issuedAt: new Date(iso),
});

describe("BillingPaymentsService (SA-1146 B-4)", () => {
  it("is 12 rows a page", () => expect(PAYMENTS_PAGE_SIZE).toBe(12));

  it("returns 2 rows for a tenant with 2 paid Stripe invoices, receipt link live", async () => {
    const h = build({
      subs: { t1: "cus_a" },
      rf: [],
      stripe: [inv(1, "2026-10-01T00:00:00Z"), inv(2, "2026-11-01T00:00:00Z")],
    });
    const page = await (await make(h)).list("t1", null);
    expect(page.rows.map((r) => r.id)).toEqual(["in_2", "in_1"]);
    expect(page.rows[0]).toMatchObject({
      source: "stripe",
      amount: 123.45,
      currency: "USD",
      receiptUrl: "https://invoice.example/2",
      number: "ACME-2",
    });
    expect(page.nextCursor).toBeNull();
    expect(page.stripeUnavailable).toBe(false);
  });

  it("merges both sources newest first; RouteFlow rows have no receipt link", async () => {
    const h = build({
      subs: { t1: "cus_a" },
      rf: [rf(1, "2026-10-15T00:00:00Z"), rf(2, "2026-11-10T00:00:00Z")],
      stripe: [inv(1, "2026-10-01T00:00:00Z"), inv(2, "2026-11-01T00:00:00Z")],
    });
    const page = await (await make(h)).list("t1", null);
    expect(page.rows.map((r) => r.id)).toEqual(["rf_002", "in_2", "rf_001", "in_1"]);
    expect(page.rows[0]).toMatchObject({ source: "routeflow", receiptUrl: null, amount: 99.5 });
  });

  it("pages 12 at a time and the cursor round trip never repeats or skips a row", async () => {
    const stripe: StripeInv[] = [];
    const rfRows: RfRow[] = [];
    // 17 Stripe + 14 RouteFlow, interleaved days; 31 in all.
    for (let i = 0; i < 17; i++) {
      stripe.push(inv(i, new Date(Date.UTC(2026, 0, 1 + i * 2)).toISOString()));
    }
    for (let i = 0; i < 14; i++) {
      rfRows.push(rf(i, new Date(Date.UTC(2026, 0, 2 + i * 2, 5)).toISOString()));
    }
    const h = build({ subs: { t1: "cus_a" }, rf: rfRows, stripe });
    const svc = await make(h);
    const seen: string[] = [];
    let cursor: string | null = null;
    let pages = 0;
    do {
      const page = await svc.list("t1", cursor);
      expect(page.rows.length).toBeLessThanOrEqual(12);
      if (page.nextCursor) expect(page.rows).toHaveLength(12);
      seen.push(...page.rows.map((r) => r.id));
      cursor = page.nextCursor;
      pages++;
    } while (cursor && pages < 10);
    expect(pages).toBe(3);
    expect(seen).toHaveLength(31);
    expect(new Set(seen).size).toBe(31);
    const expected = [
      ...stripe.map((s) => ({ id: s.id, t: s.created * 1000 })),
      ...rfRows.map((r) => ({ id: r.id, t: +r.issuedAt })),
    ]
      .sort((a, b) => b.t - a.t)
      .map((x) => x.id);
    expect(seen).toEqual(expected);
  });

  it("never returns another tenant's rows and reads the customer id from the tenant row", async () => {
    const h = build({
      subs: { t1: "cus_a", t2: "cus_b" },
      rf: [rf(1, "2026-10-01T00:00:00Z", "t1"), rf(2, "2026-10-02T00:00:00Z", "t2")],
      stripe: [inv(1, "2026-10-01T00:00:00Z", "cus_a"), inv(9, "2026-10-05T00:00:00Z", "cus_b")],
    });
    const page = await (await make(h)).list("t1", null);
    expect(page.rows.map((r) => r.id).sort()).toEqual(["in_1", "rf_001"]);
    expect(h.listPaid).toHaveBeenCalledWith("cus_a", expect.any(Object), expect.anything());
    expect(h.prisma.tenantSubscription.findUnique).toHaveBeenCalledWith(
      expect.objectContaining({ where: { tenantId: "t1" } }),
    );
    expect(h.rfFindMany.mock.calls[0][0].where.tenantId).toBe("t1");
  });

  it("a forged cursor cannot change the customer", async () => {
    const h = build({
      subs: { t1: "cus_a" },
      rf: [],
      stripe: [inv(1, "2026-10-01T00:00:00Z", "cus_a")],
    });
    const forged = Buffer.from(
      JSON.stringify({ stripeAfter: null, rfBefore: null, customer: "cus_b" }),
    ).toString("base64url");
    await (await make(h)).list("t1", forged);
    expect(h.listPaid.mock.calls[0][0]).toBe("cus_a");
  });

  it("a garbage cursor starts from the first page instead of throwing", async () => {
    const h = build({ subs: { t1: null }, rf: [rf(1, "2026-10-01T00:00:00Z")], stripe: [] });
    const page = await (await make(h)).list("t1", "not-a-cursor");
    expect(page.rows).toHaveLength(1);
  });

  it("a Stripe failure still returns the RouteFlow rows with stripeUnavailable true", async () => {
    const h = build({
      subs: { t1: "cus_a" },
      rf: [rf(1, "2026-10-01T00:00:00Z")],
      stripe: [],
      stripeFails: true,
    });
    const page = await (await make(h)).list("t1", null);
    expect(page.stripeUnavailable).toBe(true);
    expect(page.rows.map((r) => r.id)).toEqual(["rf_001"]);
  });

  it("a tenant with no Stripe customer gets RouteFlow rows only and stripeUnavailable false", async () => {
    const h = build({ subs: { t1: null }, rf: [rf(1, "2026-10-01T00:00:00Z")], stripe: [] });
    const page = await (await make(h)).list("t1", null);
    expect(page.stripeUnavailable).toBe(false);
    expect(page.rows).toHaveLength(1);
    expect(h.listPaid).not.toHaveBeenCalled();
  });
});
