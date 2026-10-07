// PR1 CRON-1..5, BLD-4 (issuer half), SA722-1: the dark issuer. `@LeaderCron` wraps the tick in a
// Postgres advisory lock and the number mint takes a billing-family lock; neither has a database
// here, so both are PASS-THROUGHS that still call the body.
jest.mock("../../common/db-locks", () => ({
  withAdvisoryLock: async (_opts: unknown, fn: () => Promise<unknown>) => ({
    acquired: true,
    value: await fn(),
  }),
  LockTimeoutError: class extends Error {},
  LockUnavailableError: class extends Error {},
}));

import { RfInvoiceBuilder } from "./rf-invoice-builder";
import { RF_INVOICE_CANDIDATE_WHERE, RfInvoiceIssuerService } from "./rf-invoice-issuer.service";
import { RF_INVOICE_NUMBER_INDEX, RF_INVOICE_PERIOD_INDEX } from "./rf-invoice.constants";

const NOW = new Date("2026-10-07T00:20:00.000Z");
const DAY = 24 * 60 * 60 * 1000;
const PERIOD_KEY = "2026-10-12T00:00:00.000Z";

const p2002 = (index: string) => ({
  code: "P2002",
  meta: { driverAdapterError: { cause: { constraint: { index } } } },
});

function sub(over: Record<string, unknown> = {}, tenantOver: Record<string, unknown> = {}) {
  return {
    tenantId: "tenant-acme",
    cycle: "MONTHLY",
    planKey: "STARTER",
    periodStart: new Date("2026-09-12T00:00:00.000Z"),
    periodEnd: new Date("2026-10-12T00:00:00.000Z"),
    externalPayment: true,
    stripeSubId: null,
    cancelAtPeriodEnd: false,
    tenant: { status: "ACTIVE", class: "PRODUCTION", deletedAt: null, ...tenantOver },
    ...over,
  };
}

function matches(row: any, where: any): boolean {
  return Object.entries(where ?? {}).every(([k, v]: [string, any]) => {
    const actual = row[k];
    if (v && typeof v === "object" && !(v instanceof Date)) {
      if ("not" in v) return actual !== v.not;
      if ("startsWith" in v) return String(actual).startsWith(v.startsWith);
      return true;
    }
    if (v instanceof Date) return actual instanceof Date && actual.getTime() === v.getTime();
    return actual === v;
  });
}

const DRAFT = {
  ok: true,
  lines: [
    {
      kind: "PLAN",
      code: "STARTER",
      label: "Starter plan",
      quantity: 1,
      unitAmount: 149,
      amount: 149,
    },
  ],
  total: 149,
  needsReview: false,
  irregularPeriod: false,
  currency: "USD",
};

function make(
  opts: {
    subs?: any[];
    invoices?: any[];
    draft?: any;
    createHook?: (data: any, attempt: number) => void;
  } = {},
) {
  const invoices: any[] = [...(opts.invoices ?? [])];
  const audits: any[] = [];
  let createCalls = 0;
  const prisma: any = {
    tenantSubscription: { findMany: jest.fn(async () => opts.subs ?? []) },
    rfInvoice: {
      findMany: jest.fn(async ({ where }: any) => invoices.filter((r) => matches(r, where))),
      findFirst: jest.fn(async ({ where }: any) => invoices.find((r) => matches(r, where)) ?? null),
      create: jest.fn(async ({ data }: any) => {
        opts.createHook?.(data, createCalls++);
        const row = { id: `inv-${invoices.length + 1}`, ...data };
        invoices.push(row);
        return row;
      }),
    },
    auditLog: {
      create: jest.fn(async ({ data }: any) => {
        audits.push(data);
        return data;
      }),
      findFirst: jest.fn(
        async ({ where }: any) =>
          audits.find(
            (a) => a.action === where.action && a.meta?.dedupeKey === where.meta?.equals,
          ) ?? null,
      ),
    },
    $executeRaw: jest.fn(async () => 1),
    $transaction: jest.fn(async (fn: any) => fn(prisma)),
  };
  const builder = {
    build: jest.fn(async () => opts.draft ?? DRAFT),
  } as unknown as RfInvoiceBuilder;
  const svc = new RfInvoiceIssuerService(prisma, builder);
  return { svc, prisma, builder, invoices, audits };
}

const writes = (prisma: any) =>
  prisma.rfInvoice.create.mock.calls.length +
  prisma.auditLog.create.mock.calls.length +
  prisma.$transaction.mock.calls.length;

describe("RfInvoiceIssuerService", () => {
  const OLD_MODE = process.env.RF_INVOICING_MODE;
  beforeEach(() => {
    process.env.RF_INVOICING_MODE = "live";
  });
  afterAll(() => {
    if (OLD_MODE === undefined) delete process.env.RF_INVOICING_MODE;
    else process.env.RF_INVOICING_MODE = OLD_MODE;
  });

  it("CRON-1: issues the NEXT period once (OPEN, dueDate = periodStart, net 0) and is idempotent", async () => {
    const { svc, invoices, audits } = make({ subs: [sub()] });
    const first = await svc.runIssueDue(NOW);
    const again = await svc.runIssueDue(NOW);

    expect(invoices).toHaveLength(1);
    expect(invoices[0]).toMatchObject({
      tenantId: "tenant-acme",
      number: "RF-2026-0001",
      amount: 149,
      status: "OPEN",
      cycle: "MONTHLY",
      currency: "USD",
      periodKey: PERIOD_KEY,
      issuedById: null,
      lines: DRAFT.lines,
    });
    expect(invoices[0].periodStart).toEqual(new Date("2026-10-12T00:00:00.000Z"));
    expect(invoices[0].periodEnd).toEqual(new Date("2026-11-11T00:00:00.000Z"));
    expect(invoices[0].dueDate).toEqual(invoices[0].periodStart);
    expect(audits.filter((a) => a.action === "RF_INVOICE_ISSUED")).toHaveLength(1);
    expect(first).toMatchObject({ mode: "live", issued: 1 });
    expect(again).toMatchObject({ issued: 0, existing: 1 });
  });

  it("CRON-1: nothing is issued while the period end is more than 7 days away", async () => {
    const { svc, invoices } = make({
      subs: [sub({ periodEnd: new Date(NOW.getTime() + 8 * DAY) })],
    });
    await svc.runIssueDue(NOW);
    expect(invoices).toHaveLength(0);
  });

  it("CRON-2: a Stripe subscription, cancelAtPeriodEnd, or a non-ACTIVE tenant yields nothing (query AND re-check)", async () => {
    const rows = [
      sub({ tenantId: "t-stripe", stripeSubId: "sub_123" }),
      sub({ tenantId: "t-cancel", cancelAtPeriodEnd: true }),
      sub({ tenantId: "t-susp" }, { status: "SUSPENDED" }),
      sub({ tenantId: "t-card", externalPayment: false }),
      sub({ tenantId: "t-noplan", planKey: null }),
    ];
    const { svc, prisma, invoices } = make({ subs: rows });
    await svc.runIssueDue(NOW);
    expect(invoices).toHaveLength(0);
    expect(prisma.tenantSubscription.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          externalPayment: true,
          stripeSubId: null,
          cancelAtPeriodEnd: false,
          planKey: { not: null },
          periodStart: { not: null },
          periodEnd: { not: null },
          tenant: { class: "PRODUCTION", deletedAt: null, status: "ACTIVE" },
        }),
      }),
    );
  });

  it("CRON-3: a TEST / DEMO / INTERNAL / deleted tenant yields nothing", async () => {
    const rows = [
      sub({ tenantId: "t-test" }, { class: "TEST" }),
      sub({ tenantId: "t-demo" }, { class: "DEMO" }),
      sub({ tenantId: "t-int" }, { class: "INTERNAL" }),
      sub({ tenantId: "t-del" }, { deletedAt: new Date("2026-01-01") }),
    ];
    const { svc, invoices } = make({ subs: rows });
    await svc.runIssueDue(NOW);
    expect(invoices).toHaveLength(0);
  });

  it("CRON-3: an allowlisted test tenant (RF_INVOICE_TEST_TENANT_SLUGS) is NEVER cron-issued; the query stays PRODUCTION-only", async () => {
    const OLD = process.env.RF_INVOICE_TEST_TENANT_SLUGS;
    process.env.RF_INVOICE_TEST_TENANT_SLUGS = "e2e-rfinv";
    try {
      const { svc, invoices, prisma } = make({
        subs: [sub({ tenantId: "t-e2e" }, { class: "TEST", slug: "e2e-rfinv" })],
      });
      await svc.runIssueDue(NOW);
      expect(invoices).toHaveLength(0);
      expect(prisma.tenantSubscription.findMany.mock.calls[0][0].where).toBe(
        RF_INVOICE_CANDIDATE_WHERE,
      );
      expect(RF_INVOICE_CANDIDATE_WHERE.tenant).toMatchObject({ class: "PRODUCTION" });
    } finally {
      if (OLD === undefined) delete process.env.RF_INVOICE_TEST_TENANT_SLUGS;
      else process.env.RF_INVOICE_TEST_TENANT_SLUGS = OLD;
    }
  });

  it("windowsFor: the cron lead is 7 days; an infinite lead (issue-now) reaches the next period at once", async () => {
    const far = sub({ periodEnd: new Date(NOW.getTime() + 20 * DAY) });
    const { svc } = make({ subs: [far] });
    expect(await svc.windowsFor(far as any, NOW)).toEqual([]);
    const now = await svc.windowsFor(far as any, NOW, Infinity);
    expect(now).toHaveLength(1);
    expect(now[0].periodStart).toEqual(far.periodEnd);
  });

  it("CRON-4: RF_INVOICING_MODE unset (or junk) makes ZERO reads and writes", async () => {
    for (const v of [undefined, "", "off", "banana"]) {
      if (v === undefined) delete process.env.RF_INVOICING_MODE;
      else process.env.RF_INVOICING_MODE = v;
      const { svc, prisma } = make({ subs: [sub()] });
      const summary = await svc.issueDue();
      expect(summary).toMatchObject({ mode: "off", issued: 0 });
      expect(writes(prisma)).toBe(0);
      expect(prisma.tenantSubscription.findMany).not.toHaveBeenCalled();
    }
  });

  it("CRON-4: silent and live both write rows", async () => {
    for (const v of ["silent", "live"]) {
      process.env.RF_INVOICING_MODE = v;
      const { svc, invoices } = make({ subs: [sub()] });
      await svc.runIssueDue(NOW);
      expect(invoices).toHaveLength(1);
    }
  });

  it("CRON-5: catch-up issues the CURRENT period when a live invoice ends exactly at its start", async () => {
    const rolled = sub({
      periodStart: new Date("2026-10-12T00:00:00.000Z"),
      periodEnd: new Date("2026-11-11T00:00:00.000Z"),
    });
    const prior = {
      id: "inv-prior",
      tenantId: "tenant-acme",
      number: "RF-2026-0007",
      status: "PAID",
      periodKey: "2026-09-12T00:00:00.000Z",
      periodStart: new Date("2026-09-12T00:00:00.000Z"),
      periodEnd: new Date("2026-10-12T00:00:00.000Z"),
    };
    const { svc, invoices } = make({ subs: [rolled], invoices: [prior] });
    await svc.runIssueDue(new Date("2026-10-13T00:20:00.000Z"));
    const fresh = invoices.filter((i) => i.id !== "inv-prior");
    expect(fresh).toHaveLength(1);
    expect(fresh[0]).toMatchObject({ periodKey: PERIOD_KEY, number: "RF-2026-0008" });
    expect(fresh[0].dueDate).toEqual(new Date("2026-10-12T00:00:00.000Z"));
  });

  it("CRON-5: an activation period (no prior invoice) and a VOIDED prior invoice are never caught up", async () => {
    const rolled = sub({
      periodStart: new Date("2026-10-12T00:00:00.000Z"),
      periodEnd: new Date("2026-11-11T00:00:00.000Z"),
    });
    const voided = {
      id: "inv-void",
      tenantId: "tenant-acme",
      number: "RF-2026-0007",
      status: "VOID",
      periodKey: "2026-09-12T00:00:00.000Z:void:inv-void",
      periodEnd: new Date("2026-10-12T00:00:00.000Z"),
    };
    for (const invoices of [[], [voided]]) {
      const h = make({ subs: [rolled], invoices });
      await h.svc.runIssueDue(new Date("2026-10-13T00:20:00.000Z"));
      expect(h.invoices.filter((i) => i.status !== "VOID")).toHaveLength(0);
    }
  });

  it("BLD-4: no resolvable price -> no row, ONE RF_INVOICE_NEEDS_PRICE notice per period, tenant reported unpriced", async () => {
    const { svc, invoices, audits } = make({
      subs: [sub()],
      draft: { ok: false, reason: "NO_PRICE", message: "No price is resolvable" },
    });
    const first = await svc.runIssueDue(NOW);
    const second = await svc.runIssueDue(NOW);
    expect(invoices).toHaveLength(0);
    expect(audits.filter((a) => a.action === "RF_INVOICE_NEEDS_PRICE")).toHaveLength(1);
    expect(first.unpriced).toEqual(["tenant-acme"]);
    expect(second.unpriced).toEqual(["tenant-acme"]);
  });

  it("CRON-6: a period that ended 10 days ago (rollCycles lagging) -> no invoice, ONE stale notice per period", async () => {
    const stale = sub({
      periodStart: new Date(NOW.getTime() - 40 * DAY),
      periodEnd: new Date(NOW.getTime() - 10 * DAY),
    });
    const { svc, invoices, audits } = make({ subs: [stale] });
    const first = await svc.runIssueDue(NOW);
    const second = await svc.runIssueDue(NOW);
    expect(invoices).toHaveLength(0);
    expect(audits.filter((a) => a.action === "RF_INVOICE_STALE_PERIOD")).toHaveLength(1);
    expect(first.stale).toEqual(["tenant-acme"]);
    expect(second.stale).toEqual(["tenant-acme"]);
    expect(first.issued).toBe(0);
  });

  it("CRON-6: a period that ended less than a day ago is not stale", async () => {
    const fresh = sub({
      periodStart: new Date(NOW.getTime() - 30.5 * DAY),
      periodEnd: new Date(NOW.getTime() - 0.5 * DAY),
    });
    const { svc, invoices } = make({ subs: [fresh] });
    const r = await svc.runIssueDue(NOW);
    expect(r.stale).toEqual([]);
    expect(invoices).toHaveLength(1);
  });

  it("an add-on line priced at null is persisted as needsReview on the row (and false otherwise)", async () => {
    const yes = make({ subs: [sub()], draft: { ...DRAFT, needsReview: true } });
    await yes.svc.runIssueDue(NOW);
    expect(yes.invoices[0].needsReview).toBe(true);
    const no = make({ subs: [sub()] });
    await no.svc.runIssueDue(NOW);
    expect(no.invoices[0].needsReview).toBe(false);
  });

  it("MUST-2: the period window is passed to the builder, and an irregular period raises ONE notice per period", async () => {
    const { svc, builder, invoices, audits } = make({
      subs: [sub()],
      draft: { ...DRAFT, needsReview: true, irregularPeriod: true },
    });
    await svc.runIssueDue(NOW);
    await svc.runIssueDue(NOW);
    expect(builder.build).toHaveBeenCalledWith("tenant-acme", "MONTHLY", {
      periodStart: new Date("2026-10-12T00:00:00.000Z"),
      periodEnd: new Date("2026-11-11T00:00:00.000Z"),
    });
    expect(invoices).toHaveLength(1);
    expect(invoices[0].needsReview).toBe(true);
    expect(audits.filter((a) => a.action === "RF_INVOICE_IRREGULAR_PERIOD")).toHaveLength(1);
  });

  it("SA722-1: two concurrent issues of one period -> ONE row; the loser's period-index P2002 is absorbed", async () => {
    let attempts = 0;
    const { svc, invoices, audits } = make({
      subs: [sub()],
      createHook: () => {
        // The race loser: its pre-check saw nothing, but the row landed first.
        if (attempts++ === 1) throw p2002(RF_INVOICE_PERIOD_INDEX);
      },
    });
    const win = {
      periodStart: new Date("2026-10-12T00:00:00.000Z"),
      periodEnd: new Date("2026-11-11T00:00:00.000Z"),
    };
    const [a, b] = await Promise.all([
      svc.issuePeriod(sub() as any, win, NOW),
      svc.issuePeriod(sub() as any, win, NOW),
    ]);
    expect([a.status, b.status].sort()).toEqual(["exists", "issued"]);
    expect(invoices).toHaveLength(1);
    expect(audits.filter((x) => x.action === "RF_INVOICE_ISSUED")).toHaveLength(1);
  });

  it("SA722-1: a P2002 on an UNRELATED index is rethrown, not swallowed", async () => {
    const { svc, invoices } = make({
      subs: [sub()],
      createHook: () => {
        throw p2002("RfInvoice_pkey");
      },
    });
    const win = {
      periodStart: new Date("2026-10-12T00:00:00.000Z"),
      periodEnd: new Date("2026-11-11T00:00:00.000Z"),
    };
    await expect(svc.issuePeriod(sub() as any, win, NOW)).rejects.toMatchObject({ code: "P2002" });
    expect(invoices).toHaveLength(0);
  });

  it("NUM-1 (issuer): a number-index collision re-mints and the row still lands once", async () => {
    const { svc, invoices } = make({
      subs: [sub()],
      createHook: (_d, n) => {
        if (n === 0) throw p2002(RF_INVOICE_NUMBER_INDEX);
      },
    });
    const summary = await svc.runIssueDue(NOW);
    expect(invoices).toHaveLength(1);
    expect(summary.issued).toBe(1);
  });

  it("one tenant's failure does not stop the sweep (counted as failed)", async () => {
    const { svc, invoices } = make({
      subs: [sub({ tenantId: "t-bad" }), sub({ tenantId: "t-good" })],
      createHook: (d) => {
        if (d.tenantId === "t-bad") throw new Error("boom");
      },
    });
    const summary = await svc.runIssueDue(NOW);
    expect(invoices.map((i) => i.tenantId)).toEqual(["t-good"]);
    expect(summary).toMatchObject({ issued: 1, failed: 1 });
  });

  it("an unexpected pricing error (not a missing price) is a failure, not an unpriced tenant", async () => {
    const { svc, builder } = make({ subs: [sub()] });
    (builder.build as jest.Mock).mockRejectedValue(new Error("db down"));
    const summary = await svc.runIssueDue(NOW);
    expect(summary).toMatchObject({ failed: 1, unpriced: [] });
  });
});
