/**
 * B1186 / SA-717, real Postgres through the real PrismaService (the pg driver adapter): the
 * number-conflict readers must key on the constraint the adapter reports, not on `meta.target`.
 *   S2/S3  estimate / credit-note number collision -> the coded 409 (control; used to work only because
 *          an empty target was treated as "maybe a number conflict")
 *   S2b/S3b a P2002 from ANOTHER constraint propagates untouched (was mislabelled a number conflict)
 *   S4     isReturnKeyConflict is true for the returnKey index only - not another constraint, not a
 *          returnNumber collision
 *   S5-7   the three exact-name product readers still refuse another constraint's error
 * (The orders.create race exit, S1, is pinned by replay-create-race.db.spec.ts.)
 * Runs only under `npm run local:test:db`; tenant `qa-1186-<run>` is approved by assertTestTenant.
 */
import { randomUUID } from "crypto";
import { PrismaClient } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import { Pool } from "pg";
import { describeDb, requireLocalDatabaseUrl } from "./db-spec";
import { PrismaService } from "../../prisma/prisma.service";
import { TenantContextService } from "../../tenant/tenant-context.service";
import { EstimatesService } from "../../estimates/estimates.service";
import { CreditNotesService } from "../../credit-notes/credit-notes.service";
import { asReadableConflict } from "../../credit-notes/credit-note-errors";
import { NumberingService } from "../../import/numbering.service";
import { InlineReturnsService } from "../../returns/inline-returns.service";
import { mapNameUniqueViolation } from "../../products/product-name-rules";
import { isBarcodeUniqueViolation } from "../../products/product-catalog-sync";
import { recipeUniqueViolation } from "../../products/recipe-rules";

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { assertTestTenant } = require("../../../../../scripts/lib/test-tenants.cjs");

const operatorPayload = {
  status: "ACTIVE",
  forcePasswordChange: false,
  sub: "u",
  username: "op",
  role: "OPERATOR",
};

describeDb("B1186: unique-violation readers match the pg adapter's P2002 shape", () => {
  let pool: Pool;
  let raw: PrismaClient;
  let dbPrisma: PrismaService;
  let tenantCtx: TenantContextService;
  const run = randomUUID().slice(0, 8);
  const slug = assertTestTenant(`qa-1186-${run}`, "p2002-adapter-readers.db.spec.ts");
  let tenantId = "";
  let n = 0;

  beforeAll(async () => {
    pool = new Pool({ connectionString: requireLocalDatabaseUrl() });
    raw = new PrismaClient({ adapter: new PrismaPg(pool) });
    tenantCtx = new TenantContextService();
    dbPrisma = new PrismaService(tenantCtx);
    await dbPrisma.$connect();
    tenantId = (await raw.tenant.create({ data: { slug, name: `b1186 ${slug}` } })).id;
    const op = await raw.user.create({
      data: { email: `op-${run}@example.test`, username: `op-${run}`, role: "OPERATOR", tenantId },
    });
    operatorPayload.sub = op.id;
  }, 120_000);

  afterAll(async () => {
    const where = { tenantId };
    await raw.creditNote.deleteMany({ where });
    await raw.estimate.deleteMany({ where });
    await raw.return.deleteMany({ where });
    await raw.order.deleteMany({ where });
    await raw.numberingSequence.deleteMany({ where }).catch(() => undefined);
    await raw.customer.deleteMany({ where });
    await raw.user.deleteMany({ where });
    if (tenantId) await raw.tenant.deleteMany({ where: { id: tenantId } });
    await dbPrisma?.$disconnect();
    await raw?.$disconnect();
    await pool?.end();
  }, 120_000);

  async function customer() {
    const tag = `c${++n}`;
    const user = await raw.user.create({
      data: {
        email: `${tag}-${run}@example.test`,
        username: `${tag}-${run}`,
        role: "CUSTOMER",
        tenantId,
      },
    });
    return raw.customer.create({
      data: { userId: user.id, businessName: `${tag} co`, contactName: "T", tenantId },
    });
  }
  const staff = () => ({ ...operatorPayload, tenantId }) as never;
  const errorOf = (p: Promise<unknown>) =>
    p.then(
      () => null,
      (e) => e,
    );
  /** A REAL adapter-shape P2002 from a different constraint (Tenant.slug), raised by Postgres. */
  async function realWrongConstraintError(): Promise<any> {
    const e: any = await errorOf(raw.tenant.create({ data: { slug, name: "dup" } }));
    expect(e?.code).toBe("P2002");
    expect(e.meta?.target).toBeUndefined();
    return e;
  }

  // ── sites 2-4: the number-conflict readers misread a P2002 from ANOTHER constraint ──────────
  it("S2 estimates.create: a collision on the REAL estimateNumber index is the 409 (control, green)", async () => {
    const c = await customer();
    const numbering = new NumberingService(dbPrisma);
    const est = new EstimatesService(
      dbPrisma,
      {} as never,
      numbering,
      {} as never,
      { assertLinesSellable: jest.fn() } as never,
      { can: async () => false } as never,
    );
    await raw.estimate.create({
      data: { estimateNumber: `E-${run}`, customerId: c.id, subtotal: 1, total: 1, tenantId },
    });
    jest.spyOn(numbering, "reserveNext").mockResolvedValue(`E-${run}` as never);
    const e = await errorOf(
      tenantCtx.run(tenantId, () => est.create({ customerId: c.id, items: [] } as never)),
    );
    expect(e?.getStatus?.()).toBe(409);
  }, 60_000);

  it("S2b estimates.create: a P2002 from ANOTHER constraint must propagate, not read as 'number conflict'", async () => {
    const c = await customer();
    const real = await realWrongConstraintError();
    const est = new EstimatesService(
      dbPrisma,
      {} as never,
      { reserveNext: async () => `E2-${run}` } as never,
      {} as never,
      { assertLinesSellable: jest.fn() } as never,
      { can: async () => false } as never,
    );
    const realFor = dbPrisma.forTenant.bind(dbPrisma);
    jest.spyOn(dbPrisma, "forTenant").mockImplementation((() => {
      const t: any = realFor();
      return new Proxy(t, {
        get: (o, p) =>
          p === "estimate" ? { ...o.estimate, create: () => Promise.reject(real) } : o[p],
      });
    }) as never);
    const e = await errorOf(
      tenantCtx.run(tenantId, () => est.create({ customerId: c.id, items: [] } as never)),
    );
    jest.restoreAllMocks();
    expect(e?.code).toBe("P2002"); // propagates untouched
  }, 60_000);

  it("S3 credit-notes.create: real creditNoteNumber collision is the 409 (control, green)", async () => {
    const c = await customer();
    const numbering = new NumberingService(dbPrisma);
    const cn = new CreditNotesService(
      dbPrisma,
      { emitCreditNoteCreated: jest.fn() } as never,
      {} as never,
      {} as never,
      numbering,
    );
    await raw.creditNote.create({
      data: { creditNoteNumber: `CN-${run}`, customerId: c.id, amount: 1, tenantId },
    });
    jest.spyOn(numbering, "reserveNext").mockResolvedValue(`CN-${run}` as never);
    const e = await errorOf(
      tenantCtx.run(tenantId, () =>
        cn.create({ customerId: c.id, amount: 5, reason: "x" } as never, staff()),
      ),
    );
    expect(e?.getStatus?.()).toBe(409);
  }, 60_000);

  it("S3b credit-notes asReadableConflict + create catch: other-constraint P2002 must not read as number conflict", async () => {
    const real = await realWrongConstraintError();
    const out: any = asReadableConflict(real, { warn: jest.fn() });
    expect(out).toBe(real); // propagates untouched
  });

  it("S4 inline-returns isReturnKeyConflict: only the returnKey index counts", async () => {
    const real = await realWrongConstraintError();
    const svc4: any = Object.create(InlineReturnsService.prototype);
    const a = svc4.isReturnKeyConflict(real);
    // and the right one (a real Return_tenantId_returnKey_key violation) is true
    const c = await customer();
    const o = await raw.order.create({ data: { customerId: c.id, tenantId } });
    const mkRet = (num: string) =>
      raw.return.create({
        data: {
          orderId: o.id,
          customerId: c.id,
          reason: "DAMAGED",
          returnKey: `rk-${run}`,
          returnNumber: num,
          tenantId,
        },
      });
    await mkRet(`R-${run}-1`);
    const dup: any = await errorOf(mkRet(`R-${run}-2`));
    const b = svc4.isReturnKeyConflict(dup);
    // and a returnNumber collision (a DIFFERENT index) must NOT be taken for a returnKey replay
    const dupNum: any = await errorOf(
      raw.return.create({
        data: {
          orderId: o.id,
          customerId: c.id,
          reason: "DAMAGED",
          returnKey: `rk2-${run}`,
          returnNumber: `R-${run}-1`,
          tenantId,
        },
      }),
    );
    const d = svc4.isReturnKeyConflict(dupNum);
    expect([a, b, d]).toEqual([false, true, false]);
  }, 60_000);

  // ── sites 5-7: already dual-shape (control): real adapter error must be recognised ─────────
  it("S5-7 product-name-rules / product-catalog-sync / recipe-rules refuse a REAL adapter error from another constraint (control)", async () => {
    const real = await realWrongConstraintError();
    expect(() => mapNameUniqueViolation(real, "n", false)).toThrow(real);
    expect(isBarcodeUniqueViolation(real)).toBe(false);
    expect(recipeUniqueViolation(real)).toBeNull();
  });
});
