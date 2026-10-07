// PR2 API-1..5, API-8, API-9, SEC-5 and the owner rulings: the super-admin queue over RouteFlow's own
// invoices to manual-pay tenants. In-memory fake Prisma (rows + audit log, with snapshot rollback on a
// throw inside $transaction); the DB-backed concurrency pin (DB-2) is rf-invoices.db.spec.ts.
import * as fs from "fs";
import * as path from "path";
import { BadRequestException, ConflictException, NotFoundException } from "@nestjs/common";
import { RfInvoicesAdminService } from "./rf-invoices.service";
import { AdminAuditAction } from "./audit-actions.constant";
import { API_ERROR_CODES } from "../common/api-error-codes";

const NOW = new Date("2026-10-07T12:00:00.000Z");
const DAY = 24 * 60 * 60 * 1000;
const TODAY = new Date("2026-10-07T00:00:00.000Z");
const iso = (d: number) => new Date(TODAY.getTime() + d * DAY).toISOString();
const ADMIN = "sa-1";

const TENANT = {
  name: "Acme Wholesale",
  slug: "acme",
  status: "ACTIVE",
  subscription: { stripeSubId: null as string | null },
};

function inv(over: Record<string, unknown> = {}) {
  return {
    id: "inv-1",
    tenantId: "tenant-acme",
    number: "RF-2026-0001",
    amount: 149,
    currency: "USD",
    cycle: "MONTHLY",
    status: "OPEN",
    periodStart: new Date(iso(5)),
    periodEnd: new Date(iso(35)),
    periodKey: iso(5),
    issuedAt: new Date(iso(-2)),
    dueDate: new Date(iso(5)),
    lastSentAt: null,
    sendCount: 0,
    paidAt: null,
    paidMethod: null,
    paidRef: null,
    paidNote: null,
    paidById: null,
    voidedAt: null,
    voidReason: null,
    issuedById: null,
    lines: [],
    needsReview: false,
    tenant: { ...TENANT },
    ...over,
  };
}

const matches = (row: any, where: any) =>
  Object.entries(where ?? {}).every(([k, v]) =>
    k === "id" || k === "status" ? row[k] === v : true,
  );

function make(
  opts: {
    invoices?: any[];
    auditFails?: boolean;
    /** The CAS loses: another admin flipped the row between our read and our write. */
    racer?: (row: any) => void;
    subs?: any[];
    draft?: (tenantId: string) => any;
    tenant?: any;
    sub?: any;
  } = {},
) {
  let invoices: any[] = (opts.invoices ?? []).map((r) => ({ ...r }));
  let audits: any[] = [];
  const forbidden = {
    tenantUpdate: jest.fn(),
    subUpdate: jest.fn(),
    eventCreate: jest.fn(),
  };
  const rfInvoice: any = {
    findFirst: jest.fn(async ({ where }: any) => invoices.find((r) => matches(r, where)) ?? null),
    findMany: jest.fn(async () => invoices),
    count: jest.fn(async () => invoices.length),
    groupBy: jest.fn(async () => {
      const by: Record<string, number> = {};
      for (const r of invoices) by[r.status] = (by[r.status] ?? 0) + 1;
      return Object.entries(by).map(([status, n]) => ({ status, _count: { _all: n } }));
    }),
    aggregate: jest.fn(async () => ({ _count: { _all: 0 }, _sum: { amount: null } })),
    updateMany: jest.fn(async ({ where, data }: any) => {
      const row = invoices.find((r) => matches(r, { id: where.id }));
      if (opts.racer && row && row.status === "OPEN") opts.racer(row);
      const hit = invoices.filter((r) => matches(r, where));
      for (const r of hit) Object.assign(r, data);
      return { count: hit.length };
    }),
  };
  const auditLog = {
    create: jest.fn(async ({ data }: any) => {
      if (opts.auditFails) throw new Error("audit down");
      audits.push(data);
      return data;
    }),
  };
  const prisma: any = {
    rfInvoice,
    auditLog,
    tenant: { findFirst: jest.fn(async () => opts.tenant ?? null), update: forbidden.tenantUpdate },
    tenantSubscription: {
      findMany: jest.fn(async () => opts.subs ?? []),
      findUnique: jest.fn(async () => opts.sub ?? null),
      update: forbidden.subUpdate,
      updateMany: forbidden.subUpdate,
    },
    billingEvent: { create: forbidden.eventCreate },
    $transaction: jest.fn(async (fn: any) => {
      const snapshot = invoices.map((r) => ({ ...r }));
      const auditCount = audits.length;
      try {
        return await fn(prisma);
      } catch (e) {
        invoices = snapshot; // a throw inside the transaction undoes the CAS
        audits.length = auditCount;
        throw e;
      }
    }),
  };
  const builder = {
    build: jest.fn(async (tenantId: string) =>
      opts.draft ? opts.draft(tenantId) : { ok: true, total: 149, lines: [], needsReview: false },
    ),
  };
  const issuer = { windowsFor: jest.fn(), issuePeriod: jest.fn() };
  const svc = new RfInvoicesAdminService(prisma, builder as any, issuer as any);
  return {
    svc,
    prisma,
    rfInvoice,
    builder,
    issuer,
    forbidden,
    get invoices() {
      return invoices;
    },
    get audits() {
      return audits;
    },
  };
}

async function thrown(p: Promise<unknown>): Promise<any> {
  try {
    await p;
  } catch (e) {
    return e;
  }
  throw new Error("expected a throw");
}

const body = (e: any) => e.getResponse();

describe("API-1 list: scope, row shape, derived due state", () => {
  it("reads PRODUCTION, undeleted tenants only, and never selects admin-only columns", async () => {
    const t = make({ invoices: [inv()] });
    await t.svc.list({}, NOW);
    const args = t.rfInvoice.findMany.mock.calls[0][0];
    expect(args.where.tenant).toMatchObject({ class: "PRODUCTION", deletedAt: null });
    const selected = Object.keys(args.select ?? {});
    for (const k of ["paidNote", "voidReason", "issuedById", "paidById", "periodKey"]) {
      expect(selected).not.toContain(k);
    }
  });

  it("row has exactly the spec fields, even if the store hands back more", async () => {
    const t = make({ invoices: [inv({ paidNote: "secret", voidReason: "x", paidById: "u" })] });
    const { rows } = await t.svc.list({}, NOW);
    expect(Object.keys(rows[0]).sort()).toEqual(
      [
        "id",
        "number",
        "tenantId",
        "tenantName",
        "tenantSlug",
        "tenantStatus",
        "tenantPaysByCard",
        "amount",
        "currency",
        "cycle",
        "periodStart",
        "periodEnd",
        "issuedAt",
        "dueDate",
        "status",
        "dueState",
        "daysOverdue",
        "lastSentAt",
        "sendCount",
        "paidAt",
        "paidMethod",
        "paidRef",
        "lines",
        "needsReview",
      ].sort(),
    );
    expect(rows[0]).toMatchObject({
      tenantName: "Acme Wholesale",
      tenantSlug: "acme",
      tenantStatus: "ACTIVE",
      tenantPaysByCard: false,
      amount: 149,
      periodStart: iso(5),
    });
  });

  it("tenantPaysByCard is true once the tenant has a Stripe subscription", async () => {
    const t = make({
      invoices: [inv({ tenant: { ...TENANT, subscription: { stripeSubId: "sub_1" } } })],
    });
    expect((await t.svc.list({}, NOW)).rows[0].tenantPaysByCard).toBe(true);
  });

  it("needsReview is read from the column, never re-derived", async () => {
    const t = make({ invoices: [inv({ needsReview: true, lines: [] })] });
    expect((await t.svc.list({}, NOW)).rows[0].needsReview).toBe(true);
  });

  it.each([
    ["5 days late", -5, "overdue", 5],
    ["due today", 0, "due_soon", 0],
    ["in 7 days", 7, "due_soon", 0],
    ["in 8 days", 8, "upcoming", 0],
    ["yesterday", -1, "overdue", 1],
  ])("dueState/daysOverdue (UTC days): %s", async (_n, offset, state, late) => {
    const t = make({ invoices: [inv({ dueDate: new Date(iso(offset)) })] });
    const [row] = (await t.svc.list({}, NOW)).rows;
    expect(row.dueState).toBe(state);
    expect(row.daysOverdue).toBe(late);
  });

  it("a PAID or VOID row is never overdue, however old its due date", async () => {
    const t = make({
      invoices: [
        inv({ id: "a", status: "PAID", dueDate: new Date(iso(-40)) }),
        inv({ id: "b", status: "VOID", dueDate: new Date(iso(-40)) }),
      ],
    });
    const { rows } = await t.svc.list({ view: "all" }, NOW);
    expect(rows.map((r) => [r.dueState, r.daysOverdue])).toEqual([
      ["upcoming", 0],
      ["upcoming", 0],
    ]);
  });
});

describe("API-2 list: views, sort, paging, search", () => {
  const where = async (q: any) => {
    const t = make({ invoices: [inv()] });
    await t.svc.list(q, NOW);
    return t.rfInvoice.findMany.mock.calls[0][0];
  };

  it("default view is open; sort is due asc, then amount desc", async () => {
    const a = await where({});
    expect(a.where.status).toBe("OPEN");
    expect(a.orderBy).toEqual([{ dueDate: "asc" }, { amount: "desc" }, { id: "asc" }]);
    expect(a.skip).toBe(0);
    expect(a.take).toBe(50);
  });

  it("overdue = OPEN and due before today (UTC)", async () => {
    const a = await where({ view: "overdue" });
    expect(a.where.status).toBe("OPEN");
    expect(a.where.dueDate).toEqual({ lt: TODAY });
  });

  it("due_soon = OPEN and due from today through +7 days", async () => {
    const a = await where({ view: "due_soon" });
    expect(a.where.status).toBe("OPEN");
    expect(a.where.dueDate).toEqual({ gte: TODAY, lt: new Date(iso(8)) });
  });

  it.each([
    ["paid", "PAID"],
    ["void", "VOID"],
    ["open", "OPEN"],
  ])("view %s filters status %s", async (view, status) => {
    expect((await where({ view })).where.status).toBe(status);
  });

  it("view all has no status filter", async () => {
    expect((await where({ view: "all" })).where.status).toBeUndefined();
  });

  it("sort amount / tenant, dir, page and limit", async () => {
    const a = await where({ sort: "amount", dir: "desc", page: 3, limit: 20 });
    expect(a.orderBy[0]).toEqual({ amount: "desc" });
    expect(a.skip).toBe(40);
    expect(a.take).toBe(20);
    const b = await where({ sort: "tenant", dir: "asc" });
    expect(b.orderBy[0]).toEqual({ tenant: { name: "asc" } });
  });

  it("q searches number and tenant name/slug; tenantId narrows to one tenant", async () => {
    const a = await where({ q: "acme", tenantId: "tenant-acme" });
    expect(a.where.tenantId).toBe("tenant-acme");
    expect(JSON.stringify(a.where.OR)).toContain("acme");
    expect(a.where.OR).toHaveLength(3);
  });

  it("meta carries total, page and limit", async () => {
    const t = make({ invoices: [inv(), inv({ id: "inv-2" })] });
    const r = await t.svc.list({ page: 2, limit: 1 }, NOW);
    expect(r.meta).toEqual({ total: 2, page: 2, limit: 1 });
  });
});

describe("API-3 summary", () => {
  const ENV = process.env.RF_INVOICING_MODE;
  afterEach(() => {
    if (ENV === undefined) delete process.env.RF_INVOICING_MODE;
    else process.env.RF_INVOICING_MODE = ENV;
  });

  it("buckets overdue and due-soon money from OPEN rows, and reports the mode", async () => {
    process.env.RF_INVOICING_MODE = "silent";
    const t = make({
      invoices: [
        inv({ id: "a", amount: 100, dueDate: new Date(iso(-3)) }),
        inv({ id: "b", amount: 49.995, dueDate: new Date(iso(-1)) }),
        inv({ id: "c", amount: 200, dueDate: new Date(iso(2)) }),
        inv({ id: "d", amount: 10, dueDate: new Date(iso(30)) }),
      ],
    });
    t.rfInvoice.aggregate.mockResolvedValue({ _count: { _all: 2 }, _sum: { amount: 300 } });
    const s = await t.svc.summary(NOW);
    expect(s.overdue).toEqual({ count: 2, amount: 150 });
    expect(s.dueSoon).toEqual({ count: 1, amount: 200 });
    expect(s.paid30d).toEqual({ count: 2, amount: 300 });
    expect(s.mode).toBe("silent");
    expect(s.viewCounts).toMatchObject({ overdue: 2, due_soon: 1, open: 4, all: 4 });
    const paid = t.rfInvoice.aggregate.mock.calls[0][0].where;
    expect(paid.status).toBe("PAID");
    expect(paid.paidAt).toEqual({ gte: new Date(NOW.getTime() - 30 * DAY) });
    expect(paid.tenant).toMatchObject({ class: "PRODUCTION", deletedAt: null });
  });

  it("mode defaults to off", async () => {
    delete process.env.RF_INVOICING_MODE;
    expect((await make().svc.summary(NOW)).mode).toBe("off");
  });

  it("lists tenants whose price cannot be resolved", async () => {
    const sub = (id: string) => ({
      tenantId: id,
      cycle: "MONTHLY",
      periodStart: new Date(iso(-20)),
      periodEnd: new Date(iso(10)),
      tenant: { name: `T ${id}`, slug: id },
    });
    const t = make({
      subs: [sub("a"), sub("b")],
      draft: (id) =>
        id === "b" ? { ok: false, reason: "NO_PRICE", message: "x" } : { ok: true, total: 1 },
    });
    expect((await t.svc.summary(NOW)).unpricedTenants).toEqual([
      { tenantId: "b", name: "T b", slug: "b" },
    ]);
  });

  it("lists stale-period tenants (period ended more than a day ago), from the issuer's candidate set", async () => {
    const sub = (id: string, endOffset: number) => ({
      tenantId: id,
      cycle: "MONTHLY",
      periodStart: new Date(iso(endOffset - 30)),
      periodEnd: new Date(iso(endOffset)),
      tenant: { name: `T ${id}`, slug: id },
    });
    const t = make({ subs: [sub("fresh", 10), sub("late", -3), sub("justended", -0.5)] });
    const s = await t.svc.summary(NOW);
    expect(s.staleTenants).toEqual([{ tenantId: "late", name: "T late", slug: "late" }]);
    const where = t.prisma.tenantSubscription.findMany.mock.calls[0][0].where;
    expect(where).toMatchObject({ externalPayment: true, stripeSubId: null });
    expect(where.tenant).toMatchObject({ class: "PRODUCTION", deletedAt: null });
  });
});

describe("API-4 mark-paid", () => {
  const open = () => make({ invoices: [inv({ id: "inv-1", status: "OPEN" })] });

  it("CAS-flips OPEN to PAID, stamps the payment and audits it in the same transaction", async () => {
    const t = open();
    const row = await t.svc.markPaid(
      "inv-1",
      { method: "ZELLE", reference: "ZEL-7788", note: "paid on call", paidAt: iso(-2) },
      ADMIN,
      NOW,
    );
    expect(t.rfInvoice.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: "inv-1", status: "OPEN" } }),
    );
    expect(t.invoices[0]).toMatchObject({
      status: "PAID",
      paidMethod: "ZELLE",
      paidRef: "ZEL-7788",
      paidNote: "paid on call",
      paidById: ADMIN,
    });
    expect((t.invoices[0].paidAt as Date).toISOString()).toBe(iso(-2));
    expect(row).toMatchObject({ status: "PAID", paidMethod: "ZELLE", paidRef: "ZEL-7788" });
    expect(Object.keys(row)).not.toContain("paidNote");
    expect(t.audits).toHaveLength(1);
    expect(t.audits[0]).toMatchObject({
      tenantId: "tenant-acme",
      userId: ADMIN,
      action: AdminAuditAction.RF_INVOICE_MARKED_PAID,
    });
    expect(t.audits[0].meta).toMatchObject({
      number: "RF-2026-0001",
      amount: 149,
      method: "ZELLE",
      reference: "ZEL-7788",
    });
    expect(t.prisma.$transaction).toHaveBeenCalledTimes(1);
  });

  it("paidAt defaults to now; cash and check need no reference", async () => {
    const t = open();
    await t.svc.markPaid("inv-1", { method: "CASH" }, ADMIN, NOW);
    expect((t.invoices[0].paidAt as Date).getTime()).toBe(NOW.getTime());
    expect(t.invoices[0].paidRef).toBeNull();
    const c = open();
    await c.svc.markPaid("inv-1", { method: "CHECK" }, ADMIN, NOW);
    expect(c.invoices[0].status).toBe("PAID");
  });

  it("an audit failure rolls the payment back (one transaction)", async () => {
    const t = make({ invoices: [inv()], auditFails: true });
    await expect(t.svc.markPaid("inv-1", { method: "CASH" }, ADMIN, NOW)).rejects.toThrow(
      "audit down",
    );
    expect(t.invoices[0].status).toBe("OPEN");
  });

  it("an unknown invoice is a 404", async () => {
    const t = make();
    await expect(t.svc.markPaid("nope", { method: "CASH" }, ADMIN, NOW)).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });

  it("works on an invoice of any tenant class by id (a test tenant's fixture)", async () => {
    const t = make({ invoices: [inv({ tenant: { ...TENANT, class: "TEST" } })] });
    await expect(t.svc.markPaid("inv-1", { method: "CASH" }, ADMIN, NOW)).resolves.toBeTruthy();
  });
});

describe("OWNER RULINGS on mark-paid", () => {
  const attempt = (dto: any) => {
    const t = make({ invoices: [inv()] });
    return { t, p: t.svc.markPaid("inv-1", dto, ADMIN, NOW) };
  };

  it.each(["ZELLE", "BANK_TRANSFER", "WIRE"])(
    "%s without a reference is a coded 400",
    async (m) => {
      const { t, p } = attempt({ method: m });
      const e = await thrown(p);
      expect(e).toBeInstanceOf(BadRequestException);
      expect(body(e).code).toBe(API_ERROR_CODES.RF_INVOICE_REFERENCE_REQUIRED);
      expect(t.prisma.$transaction).not.toHaveBeenCalled();
    },
  );

  it("a blank reference counts as none", async () => {
    const { p } = attempt({ method: "ZELLE", reference: "   " });
    expect(body(await thrown(p)).code).toBe(API_ERROR_CODES.RF_INVOICE_REFERENCE_REQUIRED);
  });

  it.each(["ZELLE", "BANK_TRANSFER", "WIRE", "CASH", "CHECK", "OTHER"])(
    "%s with a reference is accepted",
    async (m) => {
      const { p } = attempt({ method: m, reference: "CONF-123" });
      await expect(p).resolves.toBeTruthy();
    },
  );

  it.each(["CASH", "CHECK", "OTHER"])("%s needs no reference", async (m) => {
    const { p } = attempt({ method: m });
    await expect(p).resolves.toBeTruthy();
  });

  it("paidAt 61 days back is a coded 400; 60 days back is allowed", async () => {
    const old = attempt({ method: "CASH", paidAt: iso(-61) });
    const e = await thrown(old.p);
    expect(e).toBeInstanceOf(BadRequestException);
    expect(body(e).code).toBe(API_ERROR_CODES.RF_INVOICE_PAID_AT_TOO_OLD);
    expect(old.t.prisma.$transaction).not.toHaveBeenCalled();
    await expect(attempt({ method: "CASH", paidAt: iso(-60) }).p).resolves.toBeTruthy();
  });

  it("paidAt in the future is a coded 400; today is allowed", async () => {
    const e = await thrown(attempt({ method: "CASH", paidAt: iso(1) }).p);
    expect(body(e).code).toBe(API_ERROR_CODES.RF_INVOICE_PAID_AT_IN_FUTURE);
    await expect(attempt({ method: "CASH", paidAt: iso(0) }).p).resolves.toBeTruthy();
  });

  it("an unparseable paidAt is a 400", async () => {
    await expect(attempt({ method: "CASH", paidAt: "not-a-date" }).p).rejects.toBeInstanceOf(
      BadRequestException,
    );
  });

  it.each([
    ["13 digits", "4111111111111"],
    ["16 digits", "4111111111111111"],
    ["19 digits", "4111111111111111111"],
    ["embedded in text", "ZEL-4111111111111-OK"],
    ["20 digits (contains a 19-run)", "41111111111111111111"],
  ])("a reference with %s is refused", async (_n, ref) => {
    const { t, p } = attempt({ method: "ZELLE", reference: ref });
    const e = await thrown(p);
    expect(e).toBeInstanceOf(BadRequestException);
    expect(body(e).message).toBe("Don't enter card or full account numbers.");
    expect(body(e).code).toBe(API_ERROR_CODES.RF_INVOICE_REFERENCE_LOOKS_LIKE_CARD);
    expect(t.prisma.$transaction).not.toHaveBeenCalled();
  });

  it("is refused for cash too (the rule is on the reference, not the method)", async () => {
    const e = await thrown(attempt({ method: "CASH", reference: "4111111111111111" }).p);
    expect(body(e).code).toBe(API_ERROR_CODES.RF_INVOICE_REFERENCE_LOOKS_LIKE_CARD);
  });

  it("12 digits and separated groups are fine", async () => {
    await expect(attempt({ method: "ZELLE", reference: "411111111111" }).p).resolves.toBeTruthy();
    await expect(
      attempt({ method: "WIRE", reference: "1234-5678-9012-3456" }).p,
    ).resolves.toBeTruthy();
  });

  it("a method outside the external-payment list is a 400", async () => {
    await expect(attempt({ method: "BITCOIN", reference: "x" }).p).rejects.toBeInstanceOf(
      BadRequestException,
    );
  });
});

describe("API-5 mark-paid conflicts (CAS)", () => {
  it("already PAID -> 409 ALREADY_PAID with the row, nothing written", async () => {
    const t = make({ invoices: [inv({ status: "PAID", paidMethod: "CASH" })] });
    const e = await thrown(t.svc.markPaid("inv-1", { method: "CASH" }, ADMIN, NOW));
    expect(e).toBeInstanceOf(ConflictException);
    expect(body(e).code).toBe(API_ERROR_CODES.RF_INVOICE_ALREADY_PAID);
    expect(body(e).row).toMatchObject({ id: "inv-1", status: "PAID" });
    expect(t.audits).toHaveLength(0);
  });

  it("VOID -> 409 VOIDED", async () => {
    const t = make({ invoices: [inv({ status: "VOID" })] });
    const e = await thrown(t.svc.markPaid("inv-1", { method: "CASH" }, ADMIN, NOW));
    expect(body(e).code).toBe(API_ERROR_CODES.RF_INVOICE_VOIDED);
    expect(body(e).row.status).toBe("VOID");
  });

  it("losing the CAS race (updateMany count 0) -> 409 with the winner's row, no audit row", async () => {
    const t = make({
      invoices: [inv()],
      racer: (row) => Object.assign(row, { status: "PAID", paidMethod: "WIRE" }),
    });
    const e = await thrown(t.svc.markPaid("inv-1", { method: "CASH" }, ADMIN, NOW));
    expect(body(e).code).toBe(API_ERROR_CODES.RF_INVOICE_ALREADY_PAID);
    expect(body(e).row).toMatchObject({ status: "PAID", paidMethod: "WIRE" });
    expect(t.audits).toHaveLength(0);
  });

  it("a race lost to a void reports VOIDED", async () => {
    const t = make({ invoices: [inv()], racer: (row) => Object.assign(row, { status: "VOID" }) });
    const e = await thrown(t.svc.markPaid("inv-1", { method: "CASH" }, ADMIN, NOW));
    expect(body(e).code).toBe(API_ERROR_CODES.RF_INVOICE_VOIDED);
  });
});

describe("API-8 reopen and void", () => {
  it("reopen: PAID -> OPEN, clears the payment fields, audits with the reason", async () => {
    const t = make({
      invoices: [
        inv({
          status: "PAID",
          paidAt: new Date(iso(-1)),
          paidMethod: "ZELLE",
          paidRef: "Z1",
          paidNote: "n",
          paidById: "u1",
        }),
      ],
    });
    const row = await t.svc.reopen("inv-1", { reason: "bounced" }, ADMIN, NOW);
    expect(t.rfInvoice.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: "inv-1", status: "PAID" } }),
    );
    expect(t.invoices[0]).toMatchObject({
      status: "OPEN",
      paidAt: null,
      paidMethod: null,
      paidRef: null,
      paidNote: null,
      paidById: null,
    });
    expect(row.status).toBe("OPEN");
    expect(t.audits[0]).toMatchObject({
      action: AdminAuditAction.RF_INVOICE_REOPENED,
      userId: ADMIN,
    });
    expect(t.audits[0].meta).toMatchObject({ reason: "bounced", number: "RF-2026-0001" });
  });

  it("reopen of an OPEN invoice is a 409 NOT_PAID; of a VOID one, VOIDED", async () => {
    const a = make({ invoices: [inv()] });
    const e = await thrown(a.svc.reopen("inv-1", { reason: "again" }, ADMIN, NOW));
    expect(body(e).code).toBe(API_ERROR_CODES.RF_INVOICE_NOT_PAID);
    const b = make({ invoices: [inv({ status: "VOID" })] });
    const f = await thrown(b.svc.reopen("inv-1", { reason: "again" }, ADMIN, NOW));
    expect(body(f).code).toBe(API_ERROR_CODES.RF_INVOICE_VOIDED);
  });

  it("void: OPEN -> VOID, frees the period key, audits", async () => {
    const t = make({ invoices: [inv()] });
    const row = await t.svc.voidInvoice("inv-1", { reason: "wrong plan" }, ADMIN, NOW);
    expect(t.rfInvoice.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: "inv-1", status: "OPEN" } }),
    );
    expect(t.invoices[0]).toMatchObject({
      status: "VOID",
      voidReason: "wrong plan",
      periodKey: `${iso(5)}:void:inv-1`,
    });
    expect((t.invoices[0].voidedAt as Date).getTime()).toBe(NOW.getTime());
    expect(row.status).toBe("VOID");
    expect(Object.keys(row)).not.toContain("voidReason");
    expect(t.audits[0]).toMatchObject({ action: AdminAuditAction.RF_INVOICE_VOIDED });
    expect(t.audits[0].meta).toMatchObject({ reason: "wrong plan" });
  });

  it("void of a PAID invoice is a 409 ALREADY_PAID (reopen it first); of a VOID one, VOIDED", async () => {
    const a = make({ invoices: [inv({ status: "PAID" })] });
    expect(
      body(await thrown(a.svc.voidInvoice("inv-1", { reason: "oops" }, ADMIN, NOW))).code,
    ).toBe(API_ERROR_CODES.RF_INVOICE_ALREADY_PAID);
    const b = make({ invoices: [inv({ status: "VOID" })] });
    expect(
      body(await thrown(b.svc.voidInvoice("inv-1", { reason: "oops" }, ADMIN, NOW))).code,
    ).toBe(API_ERROR_CODES.RF_INVOICE_VOIDED);
  });

  it("a legacy row with no period key voids without inventing one", async () => {
    const t = make({ invoices: [inv({ periodKey: null })] });
    await t.svc.voidInvoice("inv-1", { reason: "legacy row" }, ADMIN, NOW);
    expect(t.invoices[0].periodKey).toBeNull();
  });

  it("void and reopen lose a race cleanly (409, no audit)", async () => {
    const v = make({ invoices: [inv()], racer: (r) => Object.assign(r, { status: "PAID" }) });
    const e = await thrown(v.svc.voidInvoice("inv-1", { reason: "racing" }, ADMIN, NOW));
    expect(body(e).code).toBe(API_ERROR_CODES.RF_INVOICE_ALREADY_PAID);
    expect(v.audits).toHaveLength(0);
    const r = make({
      invoices: [inv({ status: "PAID" })],
      racer: (row) => Object.assign(row, { status: "OPEN" }),
    });
    const f = await thrown(r.svc.reopen("inv-1", { reason: "racing" }, ADMIN, NOW));
    expect(body(f).code).toBe(API_ERROR_CODES.RF_INVOICE_NOT_PAID);
    expect(r.audits).toHaveLength(0);
  });

  it.each(["", "ab", "x".repeat(501)])("a reason of %j length is a 400", async (reason) => {
    const t = make({ invoices: [inv({ status: "PAID" })] });
    await expect(t.svc.reopen("inv-1", { reason }, ADMIN, NOW)).rejects.toBeInstanceOf(
      BadRequestException,
    );
    await expect(t.svc.voidInvoice("inv-1", { reason }, ADMIN, NOW)).rejects.toBeInstanceOf(
      BadRequestException,
    );
  });

  it("neither action touches the tenant, its subscription or a BillingEvent", async () => {
    const t = make({ invoices: [inv()] });
    await t.svc.voidInvoice("inv-1", { reason: "no consequence" }, ADMIN, NOW);
    expect(t.forbidden.tenantUpdate).not.toHaveBeenCalled();
    expect(t.forbidden.subUpdate).not.toHaveBeenCalled();
    expect(t.forbidden.eventCreate).not.toHaveBeenCalled();
  });
});

describe("API-9 issue now", () => {
  const ENV = process.env.RF_INVOICING_MODE;
  afterEach(() => {
    if (ENV === undefined) delete process.env.RF_INVOICING_MODE;
    else process.env.RF_INVOICING_MODE = ENV;
  });
  const goodSub = (
    over: Record<string, unknown> = {},
    tenantOver: Record<string, unknown> = {},
  ) => ({
    tenantId: "tenant-acme",
    cycle: "MONTHLY",
    planKey: "STARTER",
    periodStart: new Date(iso(-25)),
    periodEnd: new Date(iso(5)),
    externalPayment: true,
    stripeSubId: null,
    cancelAtPeriodEnd: false,
    tenant: { status: "ACTIVE", class: "PRODUCTION", deletedAt: null, ...tenantOver },
    ...over,
  });
  const WINDOW = { periodStart: new Date(iso(5)), periodEnd: new Date(iso(35)) };
  const setup = (sub: any, mode = "live") => {
    process.env.RF_INVOICING_MODE = mode;
    return make({
      tenant: { id: "tenant-acme" },
      sub,
      invoices: [inv({ id: "new-1" })],
    });
  };

  it("unknown tenant is a 404", async () => {
    process.env.RF_INVOICING_MODE = "live";
    await expect(make().svc.issueForTenant("nope", ADMIN, NOW)).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });

  it("mode off -> 409 INVOICING_OFF", async () => {
    delete process.env.RF_INVOICING_MODE;
    const t = setup(goodSub(), "off");
    const e = await thrown(t.svc.issueForTenant("tenant-acme", ADMIN, NOW));
    expect(e).toBeInstanceOf(ConflictException);
    expect(body(e).code).toBe(API_ERROR_CODES.RF_INVOICING_OFF);
    expect(t.issuer.issuePeriod).not.toHaveBeenCalled();
  });

  it.each([
    ["a card subscription", { stripeSubId: "sub_1" }, {}],
    ["not externalPayment", { externalPayment: false }, {}],
    ["a test-class tenant", {}, { class: "TEST" }],
  ])("%s -> 409 NOT_MANUAL", async (_n, subOver, tenantOver) => {
    const t = setup(goodSub(subOver as any, tenantOver as any));
    const e = await thrown(t.svc.issueForTenant("tenant-acme", ADMIN, NOW));
    expect(body(e).code).toBe(API_ERROR_CODES.RF_INVOICE_NOT_MANUAL);
    expect(t.issuer.issuePeriod).not.toHaveBeenCalled();
  });

  it("no subscription at all -> 409 NOT_MANUAL", async () => {
    const t = setup(null);
    expect(body(await thrown(t.svc.issueForTenant("tenant-acme", ADMIN, NOW))).code).toBe(
      API_ERROR_CODES.RF_INVOICE_NOT_MANUAL,
    );
  });

  it("no window due (or a stale subscription) -> 409 NOTHING_TO_ISSUE", async () => {
    const t = setup(goodSub());
    t.issuer.windowsFor.mockResolvedValue([]);
    expect(body(await thrown(t.svc.issueForTenant("tenant-acme", ADMIN, NOW))).code).toBe(
      API_ERROR_CODES.RF_INVOICE_NOTHING_TO_ISSUE,
    );
    const stale = setup(goodSub({ periodEnd: new Date(iso(-4)) }));
    stale.issuer.windowsFor.mockResolvedValue([WINDOW]);
    expect(body(await thrown(stale.svc.issueForTenant("tenant-acme", ADMIN, NOW))).code).toBe(
      API_ERROR_CODES.RF_INVOICE_NOTHING_TO_ISSUE,
    );
    expect(stale.issuer.issuePeriod).not.toHaveBeenCalled();
  });

  it("the period already exists -> 409 NOTHING_TO_ISSUE", async () => {
    const t = setup(goodSub());
    t.issuer.windowsFor.mockResolvedValue([WINDOW]);
    t.issuer.issuePeriod.mockResolvedValue({ status: "exists" });
    expect(body(await thrown(t.svc.issueForTenant("tenant-acme", ADMIN, NOW))).code).toBe(
      API_ERROR_CODES.RF_INVOICE_NOTHING_TO_ISSUE,
    );
  });

  it("price cannot be resolved -> 409 NO_PRICE", async () => {
    const t = setup(goodSub());
    t.issuer.windowsFor.mockResolvedValue([WINDOW]);
    t.issuer.issuePeriod.mockResolvedValue({ status: "no_price" });
    expect(body(await thrown(t.svc.issueForTenant("tenant-acme", ADMIN, NOW))).code).toBe(
      API_ERROR_CODES.RF_INVOICE_NO_PRICE,
    );
  });

  it("issues the due period as the acting admin and returns the row", async () => {
    const t = setup(goodSub(), "silent");
    t.issuer.windowsFor.mockResolvedValue([WINDOW]);
    t.issuer.issuePeriod.mockResolvedValue({
      status: "issued",
      invoice: { id: "new-1", number: "RF-2026-0002" },
    });
    const row = await t.svc.issueForTenant("tenant-acme", ADMIN, NOW);
    expect(t.issuer.issuePeriod).toHaveBeenCalledWith(
      expect.objectContaining({ tenantId: "tenant-acme" }),
      WINDOW,
      NOW,
      ADMIN,
    );
    expect(row).toMatchObject({ id: "new-1", status: "OPEN" });
  });
});

describe("SEC-5 an invoice is a record, never a consequence", () => {
  const roots = [
    path.join(__dirname, "../billing/rf-invoice"),
    __dirname, // only the rf-invoices.* files of this folder
  ];
  const files = roots
    .flatMap((dir) =>
      fs
        .readdirSync(dir)
        .filter((f) => f.endsWith(".ts") && !/\.(spec|test)\./.test(f))
        .filter((f) => dir !== __dirname || f.startsWith("rf-invoices."))
        .map((f) => path.join(dir, f)),
    )
    .map((file) => ({
      file: path.basename(file),
      text: fs
        .readFileSync(file, "utf8")
        .replace(/\/\*[\s\S]*?\*\//g, "")
        .replace(/(^|[^:"'`\\])\/\/.*$/gm, "$1"),
    }));

  it("scans the PR1 files and the new queue files (not vacuous)", () => {
    const names = files.map((f) => f.file);
    expect(names).toEqual(
      expect.arrayContaining([
        "rf-invoice-issuer.service.ts",
        "rf-invoices.controller.ts",
        "rf-invoices.service.ts",
      ]),
    );
  });

  it.each([
    ["tenant writes", /\btenant\.(update|updateMany|upsert|delete|deleteMany)\b/],
    ["a SUSPENDED status", /SUSPENDED/],
    ["subscription writes", /tenantSubscription\.(update|updateMany|upsert|create|delete)/],
    ["BillingEvent", /billingEvent|BillingEvent/],
  ])("no rf-invoice file references %s", (_n, re) => {
    for (const f of files)
      expect({ file: f.file, hit: re.test(f.text) }).toEqual({
        file: f.file,
        hit: false,
      });
  });
});
