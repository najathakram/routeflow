// SA-744r2 (row 80) against REAL Postgres: the issuer's calendar windows with the real RfInvoice table and its
// (tenantId, periodKey) unique index - the legacy-key twin, the max-end clip and the contiguity of what lands.
// The tenant is a throwaway TEST-class `e2e-*` slug; `windowsFor`/`issuePeriod` are public and never read the
// tenant class, so no other tenant's row can be issued here. Run via `npm run local:test:db`.
import { PrismaClient } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import { Pool } from "pg";
import { describeDb, requireLocalDatabaseUrl } from "../../common/testing/db-spec";
import { RfInvoiceIssuerService } from "./rf-invoice-issuer.service";

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { assertTestTenant } = require("../../../../../scripts/lib/test-tenants.cjs");

const D = (iso: string) => new Date(iso);
let pool: Pool;
let prisma: PrismaClient;
let svc: RfInvoiceIssuerService;
let tenantId: string;
const SLUG = `e2e-rfcal-${Date.now()}`;

const DRAFT = {
  ok: true,
  lines: [
    { kind: "PLAN", code: "STARTER", label: "Starter", quantity: 1, unitAmount: 149, amount: 149 },
  ],
  total: 149,
  needsReview: false,
  irregularPeriod: false,
  currency: "USD",
};
const sub = (start: string, end: string) => ({
  tenantId,
  cycle: "MONTHLY" as const,
  planKey: "STARTER",
  periodStart: D(start),
  periodEnd: D(end),
});
const seed = (start: string, end: string, status = "PAID", key = start) =>
  prisma.rfInvoice.create({
    data: {
      tenantId,
      number: `RF-2099-${String(Math.floor(Math.random() * 90000) + 10000)}`,
      amount: 149,
      status,
      periodStart: D(start),
      periodEnd: D(end),
      periodKey: key,
      dueDate: D(start),
    } as any,
  });
const keys = async () =>
  (await prisma.rfInvoice.findMany({ where: { tenantId }, orderBy: { periodStart: "asc" } })).map(
    (r) => r.periodKey,
  );

describeDb("RfInvoice calendar windows (DB)", () => {
  beforeAll(async () => {
    pool = new Pool({ connectionString: requireLocalDatabaseUrl() });
    prisma = new PrismaClient({ adapter: new PrismaPg(pool) } as any);
    assertTestTenant(SLUG);
    tenantId = (
      await prisma.tenant.create({
        data: { name: "Acme Wholesale (test)", slug: SLUG, class: "TEST" },
      })
    ).id;
    svc = new (RfInvoiceIssuerService as any)(
      prisma,
      { build: async () => DRAFT },
      {
        sendAuto: async () => undefined,
      },
    ) as RfInvoiceIssuerService;
  });
  afterEach(async () => {
    await prisma.auditLog.deleteMany({ where: { tenantId } });
    await prisma.rfInvoice.deleteMany({ where: { tenantId } });
  });
  afterAll(async () => {
    try {
      if (tenantId) {
        await prisma.auditLog.deleteMany({ where: { tenantId } });
        await prisma.rfInvoice.deleteMany({ where: { tenantId } });
        await prisma.tenant.deleteMany({ where: { id: tenantId } });
      }
    } finally {
      await prisma?.$disconnect();
      await pool?.end();
    }
  });

  it("M1: a legacy 00:00Z October invoice, then the issuer, the roll and the catch-up -> exactly ONE November key (Nov 1 12:00Z)", async () => {
    await seed("2026-10-01T00:00:00.000Z", "2026-11-01T00:00:00.000Z");
    const before = sub("2026-10-01T00:00:00.000Z", "2026-11-01T00:00:00.000Z");
    const now1 = D("2026-10-27T00:20:00.000Z");
    for (const w of await svc.windowsFor(before as any, now1))
      await svc.issuePeriod(before as any, w, now1);
    expect(await keys()).toEqual(["2026-10-01T00:00:00.000Z", "2026-11-01T12:00:00.000Z"]);

    const rolled = sub("2026-11-01T12:00:00.000Z", "2026-12-01T12:00:00.000Z");
    const now2 = D("2026-11-02T00:20:00.000Z");
    const results = [];
    for (const w of await svc.windowsFor(rolled as any, now2)) {
      results.push(await svc.issuePeriod(rolled as any, w, now2));
    }
    expect(results.every((r) => r.status === "exists")).toBe(true);
    expect(await keys()).toEqual(["2026-10-01T00:00:00.000Z", "2026-11-01T12:00:00.000Z"]);
  });

  it("a legacy 00:00Z key and its 12:00Z twin are one period: issuing the twin finds the live row (no second invoice)", async () => {
    await seed("2026-11-01T00:00:00.000Z", "2026-12-01T00:00:00.000Z", "OPEN");
    const s = sub("2026-10-01T00:00:00.000Z", "2026-11-01T00:00:00.000Z");
    const r = await svc.issuePeriod(
      s as any,
      { periodStart: D("2026-11-01T12:00:00.000Z"), periodEnd: D("2026-12-01T12:00:00.000Z") },
      D("2026-10-27T00:20:00.000Z"),
    );
    expect(r.status).toBe("exists");
    expect(await keys()).toEqual(["2026-11-01T00:00:00.000Z"]);
  });

  it("M2: sub [Nov 4, Dec 1 12:00Z), PAID [Nov 4, Dec 4), now Nov 28 -> exactly [Dec 4, Jan 1 12:00Z); a second pass finds it covered", async () => {
    await seed("2026-11-04T00:00:00.000Z", "2026-12-04T00:00:00.000Z");
    const s = sub("2026-11-04T00:00:00.000Z", "2026-12-01T12:00:00.000Z");
    const now = D("2026-11-28T00:20:00.000Z");
    const windows = await svc.windowsFor(s as any, now);
    expect(windows.map((w) => [w.periodStart.toISOString(), w.periodEnd.toISOString()])).toEqual([
      ["2026-12-04T00:00:00.000Z", "2027-01-01T12:00:00.000Z"],
    ]);
    for (const w of windows) await svc.issuePeriod(s as any, w, now);
    expect(await keys()).toEqual(["2026-11-04T00:00:00.000Z", "2026-12-04T00:00:00.000Z"]);
    expect(await svc.windowsFor(s as any, now)).toEqual([]);
    expect(await svc.windowsFor(s as any, now, Infinity)).toEqual([]);
  });

  it("a VOID invoice never covers or blocks: voiding the clipping invoice brings the full window back", async () => {
    const paid = await seed("2026-11-04T00:00:00.000Z", "2026-12-04T00:00:00.000Z", "OPEN");
    const s = sub("2026-11-04T00:00:00.000Z", "2026-12-01T12:00:00.000Z");
    const now = D("2026-11-28T00:20:00.000Z");
    await prisma.rfInvoice.update({
      where: { id: paid.id },
      data: { status: "VOID", voidedAt: now, periodKey: `${paid.periodKey}:void:${paid.id}` },
    });
    const w = await svc.windowsFor(s as any, now);
    expect(w.map((x) => x.periodStart.toISOString())).toEqual(["2026-12-01T12:00:00.000Z"]);
  });
});
