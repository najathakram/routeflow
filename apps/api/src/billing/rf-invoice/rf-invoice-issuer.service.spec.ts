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

const WIN = {
  periodStart: new Date("2026-10-12T00:00:00.000Z"),
  periodEnd: new Date("2026-11-12T00:00:00.000Z"),
};

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
      if ("gte" in v || "lte" in v) {
        if (!(actual instanceof Date)) return false;
        return (
          (v.gte === undefined || actual.getTime() >= v.gte.getTime()) &&
          (v.lte === undefined || actual.getTime() <= v.lte.getTime())
        );
      }
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
    currentPeriod?: { periodStart: Date; periodEnd: Date };
    invoices?: any[];
    draft?: any;
    createHook?: (data: any, attempt: number) => void;
  } = {},
) {
  const invoices: any[] = [...(opts.invoices ?? [])];
  const audits: any[] = [];
  let createCalls = 0;
  const prisma: any = {
    tenantSubscription: {
      findMany: jest.fn(async () => opts.subs ?? []),
      // the period re-read under the Tenant share lock (PR4a): absent = unchanged
      findUnique: jest.fn(async () => opts.currentPeriod ?? null),
    },
    rfInvoice: {
      findMany: jest.fn(async ({ where }: any) => invoices.filter((r) => matches(r, where))),
      findFirst: jest.fn(async ({ where, orderBy }: any) => {
        const hits = invoices.filter((r) => matches(r, where));
        if (orderBy?.periodEnd === "desc") {
          hits.sort((a, b) => b.periodEnd.getTime() - a.periodEnd.getTime());
        }
        return hits[0] ?? null;
      }),
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
  // PR3: the mailer sends the issue email (live mode only); a stub here, proved in rf-invoice-mailer.service.spec.ts
  const mailer = { sendAuto: jest.fn(async () => undefined) };
  const svc = new (RfInvoiceIssuerService as any)(
    prisma,
    builder,
    mailer,
  ) as RfInvoiceIssuerService;
  return { svc, prisma, builder, invoices, audits, mailer };
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
    // SA-744r2: the next window follows the calendar (an alignment window to the 1st at 12:00Z), not
    // `end + (end - start)` (master: Nov 11).
    expect(invoices[0].periodEnd).toEqual(new Date("2026-11-01T12:00:00.000Z"));
    expect(invoices[0].dueDate).toEqual(invoices[0].periodStart);
    expect(audits.filter((a) => a.action === "RF_INVOICE_ISSUED")).toHaveLength(1);
    expect(first).toMatchObject({ mode: "live", issued: 1 });
    // SA-744r2 M2: the issued window now COVERS the next one, so a rerun skips it (nothing left to consider).
    expect(again).toMatchObject({ issued: 0, existing: 0 });
    expect(invoices).toHaveLength(1);
  });

  it("PR3: live - the issue email is sent for the invoice just created, once (a rerun finds it existing)", async () => {
    const { svc, mailer, invoices } = make({ subs: [sub()] });
    await svc.runIssueDue(NOW);
    expect(mailer.sendAuto).toHaveBeenCalledTimes(1);
    expect(mailer.sendAuto).toHaveBeenCalledWith(invoices[0].id, "issue", NOW);
    await svc.runIssueDue(NOW);
    expect(mailer.sendAuto).toHaveBeenCalledTimes(1);
  });

  it("PR3: silent - the invoice is issued and NO email is sent", async () => {
    process.env.RF_INVOICING_MODE = "silent";
    const { svc, mailer, invoices } = make({ subs: [sub()] });
    await svc.runIssueDue(NOW);
    expect(invoices).toHaveLength(1);
    expect(mailer.sendAuto).not.toHaveBeenCalled();
  });

  it("PR3: off - nothing is issued and nothing is sent", async () => {
    process.env.RF_INVOICING_MODE = "off";
    const { svc, mailer, invoices } = make({ subs: [sub()] });
    await svc.runIssueDue(NOW);
    expect(invoices).toHaveLength(0);
    expect(mailer.sendAuto).not.toHaveBeenCalled();
  });

  it("PR3: a mailer that throws never fails or undoes the issue", async () => {
    const { svc, mailer, invoices } = make({ subs: [sub()] });
    mailer.sendAuto.mockRejectedValue(new Error("smtp down"));
    const r = await svc.runIssueDue(NOW);
    expect(invoices).toHaveLength(1);
    expect(r).toMatchObject({ issued: 1, failed: 0 });
  });

  it("PR3: no email when the issue is a no-price notice (no invoice was created)", async () => {
    const { svc, mailer } = make({ subs: [sub()], draft: { ok: false, message: "no price" } });
    await svc.runIssueDue(NOW);
    expect(mailer.sendAuto).not.toHaveBeenCalled();
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

  it("issue-now path (actor given): the period WINDOW is handed to build(), so a multi-month period is priced like the cron's", async () => {
    const { svc, builder } = make({ subs: [] });
    const quarter = {
      periodStart: new Date("2026-10-12T00:00:00.000Z"),
      periodEnd: new Date("2027-01-10T00:00:00.000Z"),
    };
    const r = await svc.issuePeriod(sub() as any, quarter, NOW, "sa-1");
    expect(r.status).toBe("issued");
    expect((builder.build as jest.Mock).mock.calls[0]).toEqual(["tenant-acme", "MONTHLY", quarter]);
  });

  it("PR4a: the insert takes the Tenant row FOR SHARE first, so it waits for a manual activation holding it FOR UPDATE", async () => {
    const { svc, prisma } = make({ subs: [] });
    await svc.issuePeriod(sub() as any, WIN, NOW, "sa-1");
    const calls = prisma.$executeRaw.mock.calls.map((c: unknown[]) => (c[0] as string[]).join("?"));
    expect(calls.some((q: string) => /FROM "Tenant" WHERE id = \? FOR SHARE/.test(q))).toBe(true);
  });

  it("PR4a: a subscription period that moved since the sweep read it (an activation committed) issues NOTHING", async () => {
    const { svc, invoices } = make({
      subs: [],
      currentPeriod: {
        periodStart: new Date("2026-10-12T00:00:00.000Z"),
        periodEnd: new Date("2026-11-11T00:00:00.000Z"),
      },
    });
    const r = await svc.issuePeriod(sub() as any, WIN, NOW, "sa-1");
    expect(r.status).toBe("exists");
    expect(invoices).toHaveLength(0);
  });

  it("PR4a: an unchanged period still issues", async () => {
    const s = sub();
    const { svc, invoices } = make({
      subs: [],
      currentPeriod: { periodStart: s.periodStart, periodEnd: s.periodEnd },
    });
    const r = await svc.issuePeriod(s as any, WIN, NOW, "sa-1");
    expect(r.status).toBe("issued");
    expect(invoices).toHaveLength(1);
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
      periodEnd: new Date("2026-11-01T12:00:00.000Z"),
    });
    expect(invoices).toHaveLength(1);
    expect(invoices[0].needsReview).toBe(true);
    expect(audits.filter((a) => a.action === "RF_INVOICE_IRREGULAR_PERIOD")).toHaveLength(1);
  });

  it("A2: a failed create leaves NO irregular-period notice (it says 'was issued')", async () => {
    const { svc, audits, invoices } = make({
      subs: [sub()],
      draft: { ...DRAFT, needsReview: true, irregularPeriod: true },
      createHook: () => {
        throw new Error("boom");
      },
    });
    const summary = await svc.runIssueDue(NOW);
    expect(summary.failed).toBe(1);
    expect(invoices).toHaveLength(0);
    expect(audits.filter((a) => a.action === "RF_INVOICE_IRREGULAR_PERIOD")).toHaveLength(0);
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

// SA-744r2 (row 80): windows follow the owner's calendar. Red rows are the spec's master values.
describe("SA-744r2: calendar windows in the issuer", () => {
  const OLD_MODE = process.env.RF_INVOICING_MODE;
  beforeEach(() => {
    process.env.RF_INVOICING_MODE = "live";
  });
  afterAll(() => {
    if (OLD_MODE === undefined) delete process.env.RF_INVOICING_MODE;
    else process.env.RF_INVOICING_MODE = OLD_MODE;
  });
  const D = (iso: string) => new Date(iso);
  const iso = (d: Date) => d.toISOString();
  const inv = (over: Record<string, unknown>) => ({
    id: `inv-${String(over.periodKey)}`,
    tenantId: "tenant-acme",
    number: "RF-2026-0001",
    status: "PAID",
    ...over,
  });

  it("M1: a legacy 00:00Z Oct invoice, then the issuer, the roll and catch-up -> exactly ONE November key [Nov 1 12:00Z, Dec 1 12:00Z) (master: one key 2026-11-01T00:00:00Z, [Nov 1 00:00Z, Dec 2 00:00Z))", async () => {
    const oct = inv({
      periodKey: "2026-10-01T00:00:00.000Z",
      periodStart: D("2026-10-01T00:00:00.000Z"),
      periodEnd: D("2026-11-01T00:00:00.000Z"),
    });
    const before = sub({
      periodStart: D("2026-10-01T00:00:00.000Z"),
      periodEnd: D("2026-11-01T00:00:00.000Z"),
    });
    const h = make({ subs: [before], invoices: [oct] });
    await h.svc.runIssueDue(D("2026-10-27T00:20:00.000Z"));
    expect(h.invoices.filter((i) => i.id !== oct.id).map((i) => i.periodKey)).toEqual([
      "2026-11-01T12:00:00.000Z",
    ]);
    expect(iso(h.invoices[1].periodEnd)).toBe("2026-12-01T12:00:00.000Z");

    // rollCycles then moves the row onto the same window; the catch-up must find Oct under the snap and the
    // November invoice already there: still ONE November key.
    h.prisma.tenantSubscription.findMany.mockResolvedValue([
      sub({
        periodStart: D("2026-11-01T12:00:00.000Z"),
        periodEnd: D("2026-12-01T12:00:00.000Z"),
      }),
    ]);
    await h.svc.runIssueDue(D("2026-11-02T00:20:00.000Z"));
    expect(h.invoices.filter((i) => i.id !== oct.id).map((i) => i.periodKey)).toEqual([
      "2026-11-01T12:00:00.000Z",
    ]);
  });

  it("M1: the catch-up prior-invoice match is by snap, not exact equality (a 00:00Z invoice end vs a 12:00Z period start)", async () => {
    const prior = inv({
      periodKey: "2026-10-01T00:00:00.000Z",
      periodStart: D("2026-10-01T00:00:00.000Z"),
      periodEnd: D("2026-11-01T00:00:00.000Z"),
    });
    const rolled = sub({
      periodStart: D("2026-11-01T12:00:00.000Z"),
      periodEnd: D("2026-12-01T12:00:00.000Z"),
    });
    const h = make({ subs: [rolled], invoices: [prior] });
    const windows = await h.svc.windowsFor(rolled as any, D("2026-11-02T00:20:00.000Z"));
    expect(windows.map((w) => [iso(w.periodStart), iso(w.periodEnd)])).toEqual([
      ["2026-11-01T12:00:00.000Z", "2026-12-01T12:00:00.000Z"],
    ]);
  });

  it("M2: sub [Nov 4, Dec 1 12:00Z), PAID [Nov 4, Dec 4), now Nov 28 -> exactly [Dec 4, Jan 1 12:00Z), no Dec 1 12:00Z key (master issues key Dec 1 12:00Z: Dec 1-4 billed twice)", async () => {
    const paid = inv({
      periodKey: "2026-11-04T00:00:00.000Z",
      periodStart: D("2026-11-04T00:00:00.000Z"),
      periodEnd: D("2026-12-04T00:00:00.000Z"),
    });
    const s = sub({
      periodStart: D("2026-11-04T00:00:00.000Z"),
      periodEnd: D("2026-12-01T12:00:00.000Z"),
    });
    const h = make({ subs: [s], invoices: [paid] });
    await h.svc.runIssueDue(D("2026-11-28T00:20:00.000Z"));
    const fresh = h.invoices.filter((i) => i.id !== paid.id);
    expect(fresh.map((i) => i.periodKey)).toEqual(["2026-12-04T00:00:00.000Z"]);
    expect(h.builder.build).toHaveBeenCalledWith("tenant-acme", "MONTHLY", {
      periodStart: D("2026-12-04T00:00:00.000Z"),
      periodEnd: D("2027-01-01T12:00:00.000Z"),
    });
    expect(h.invoices.some((i) => i.periodKey === "2026-12-01T12:00:00.000Z")).toBe(false);
  });

  it("M2: a fully covered window is skipped (an old-shape invoice issued ahead covers it), also under issue-now", async () => {
    const ahead = inv({
      status: "OPEN",
      periodKey: "2026-12-04T00:00:00.000Z",
      periodStart: D("2026-12-04T00:00:00.000Z"),
      periodEnd: D("2027-01-04T00:00:00.000Z"),
    });
    const s = sub({
      periodStart: D("2026-11-04T00:00:00.000Z"),
      periodEnd: D("2026-12-01T12:00:00.000Z"),
    });
    const h = make({ subs: [s], invoices: [ahead] });
    expect(await h.svc.windowsFor(s as any, D("2026-11-28T00:20:00.000Z"))).toEqual([]);
    expect(await h.svc.windowsFor(s as any, D("2026-11-28T00:20:00.000Z"), Infinity)).toEqual([]);
  });

  it("issue-now (Infinity lead) advances ONE window and is then idempotent - it never walks ahead without limit", async () => {
    const s = sub({
      periodStart: D("2026-10-01T12:00:00.000Z"),
      periodEnd: D("2026-11-01T12:00:00.000Z"),
    });
    const h = make({ subs: [s] });
    const now = D("2026-10-05T00:00:00.000Z");
    const first = await h.svc.windowsFor(s as any, now, Infinity);
    expect(first.map((w) => iso(w.periodStart))).toEqual(["2026-11-01T12:00:00.000Z"]);
    for (const w of first) await h.svc.issuePeriod(s as any, w, now, "sa-1");
    expect(await h.svc.windowsFor(s as any, now, Infinity)).toEqual([]);
  });

  it("M3 (merge): an end of Nov 29 00:00Z yields ONE invoice [Nov 29, Jan 1 12:00Z), dueDate = Nov 29, key = Nov 29 (master: [Nov 29, +length))", async () => {
    const s = sub({
      periodStart: D("2026-10-30T00:00:00.000Z"),
      periodEnd: D("2026-11-29T00:00:00.000Z"),
    });
    const h = make({ subs: [s] });
    await h.svc.runIssueDue(D("2026-11-25T00:20:00.000Z"));
    expect(h.invoices).toHaveLength(1);
    expect(h.invoices[0]).toMatchObject({ periodKey: "2026-11-29T00:00:00.000Z" });
    expect(iso(h.invoices[0].periodEnd)).toBe("2027-01-01T12:00:00.000Z");
    expect(iso(h.invoices[0].dueDate)).toBe("2026-11-29T00:00:00.000Z");
  });

  it("look-past: an alignment window (>= 3 days) ending within the 7-day lead also issues the next full month in the same run, also under issue-now", async () => {
    const s = sub({
      periodStart: D("2026-10-08T00:00:00.000Z"),
      periodEnd: D("2026-11-22T00:00:00.000Z"),
    });
    const h = make({ subs: [s] });
    const now = D("2026-11-26T00:20:00.000Z"); // Dec 1 12:00Z is 5.5 days away
    const keys = async (lead?: number) =>
      (await h.svc.windowsFor(s as any, now, lead)).map((w) => [
        iso(w.periodStart),
        iso(w.periodEnd),
      ]);
    const expected = [
      ["2026-11-22T00:00:00.000Z", "2026-12-01T12:00:00.000Z"],
      ["2026-12-01T12:00:00.000Z", "2027-01-01T12:00:00.000Z"],
    ];
    expect(await keys()).toEqual(expected);
    expect(await keys(Infinity)).toEqual(expected);
    // outside the lead: the alignment window only (the look-past uses RF_INVOICE_LEAD_DAYS even under issue-now)
    const early = D("2026-11-10T00:20:00.000Z");
    const e = (await h.svc.windowsFor(s as any, early, Infinity)).map((w) => iso(w.periodStart));
    expect(e).toEqual(["2026-11-22T00:00:00.000Z"]);
  });

  it("M4: a 365-day MONTHLY-labelled row is issued as ANNUAL (builder + the invoice cycle column); the label is not written", async () => {
    const s = sub({
      cycle: "MONTHLY",
      periodStart: D("2025-11-01T12:00:00.000Z"),
      periodEnd: D("2026-11-01T12:00:00.000Z"),
    });
    const h = make({ subs: [s] });
    await h.svc.runIssueDue(D("2026-10-27T00:20:00.000Z"));
    expect(h.builder.build).toHaveBeenCalledWith("tenant-acme", "ANNUAL", {
      periodStart: D("2026-11-01T12:00:00.000Z"),
      periodEnd: D("2027-11-01T12:00:00.000Z"),
    });
    expect(h.invoices[0]).toMatchObject({ cycle: "ANNUAL" });
  });

  // Review SHOULD (fail closed): a CLIPPED ANNUAL window (an old-shape invoice issued ahead covers its first
  // days) is not issued at a full annual price for fewer days; the existing review notice is raised instead.
  it("a clipped ANNUAL window is NOT issued or emailed: the review notice is raised once, the builder never runs", async () => {
    const aheadOldShape = inv({
      periodKey: "2025-12-04T00:00:00.000Z",
      periodStart: D("2025-12-04T00:00:00.000Z"),
      periodEnd: D("2026-12-04T00:00:00.000Z"),
    });
    const s = sub({
      cycle: "ANNUAL",
      periodStart: D("2025-12-01T12:00:00.000Z"),
      periodEnd: D("2026-12-01T12:00:00.000Z"),
    });
    const h = make({ subs: [s], invoices: [aheadOldShape] });
    const now = D("2026-11-28T00:20:00.000Z");
    const windows = await h.svc.windowsFor(s as any, now);
    expect(windows).toHaveLength(1);
    expect(windows[0]).toMatchObject({ needsRuling: true });
    expect(iso(windows[0].periodStart)).toBe("2026-12-04T00:00:00.000Z");

    const summary = await h.svc.runIssueDue(now);
    await h.svc.runIssueDue(now); // a rerun adds no second notice
    expect(summary).toMatchObject({ issued: 0, needsRuling: ["tenant-acme"] });
    expect(h.invoices.filter((i) => i.id !== aheadOldShape.id)).toHaveLength(0);
    expect(h.builder.build).not.toHaveBeenCalled();
    expect(h.mailer.sendAuto).not.toHaveBeenCalled();
    const notices = h.audits.filter((a) => a.action === "RF_INVOICE_IRREGULAR_PERIOD");
    expect(notices).toHaveLength(1);
    expect(JSON.stringify(notices[0])).toContain("needs a ruling");
  });

  it("guard: a legacy ANNUAL catch-up (unaligned both ends, no clip) still issues at the annual price", async () => {
    const prior = inv({
      periodKey: "2024-10-12T00:00:00.000Z",
      periodStart: D("2024-10-12T00:00:00.000Z"),
      periodEnd: D("2025-10-12T00:00:00.000Z"),
    });
    const s = sub({
      cycle: "ANNUAL",
      periodStart: D("2025-10-12T00:00:00.000Z"),
      periodEnd: D("2026-10-12T00:00:00.000Z"),
    });
    const h = make({ subs: [s], invoices: [prior] });
    const windows = await h.svc.windowsFor(s as any, D("2025-10-13T00:20:00.000Z"));
    expect(windows).toHaveLength(1);
    expect(windows[0].needsRuling).toBeUndefined();
    const r = await h.svc.issuePeriod(s as any, windows[0], D("2025-10-13T00:20:00.000Z"));
    expect(r.status).toBe("issued");
  });

  it("the IRREGULAR notice shows the inclusive end (end - 1 day)", async () => {
    const h = make({
      subs: [
        sub({
          periodStart: D("2026-10-08T00:00:00.000Z"),
          periodEnd: D("2026-10-30T00:00:00.000Z"),
        }),
      ],
      draft: { ...DRAFT, needsReview: true, irregularPeriod: true },
    });
    await h.svc.runIssueDue(D("2026-10-27T00:20:00.000Z"));
    const notice = h.audits.find((a) => a.action === "RF_INVOICE_IRREGULAR_PERIOD");
    // window [Oct 30, Dec 1 12:00Z): inclusive end Nov 30
    expect(JSON.stringify(notice)).toContain("2026-10-30 to 2026-11-30, inclusive");
  });
});
