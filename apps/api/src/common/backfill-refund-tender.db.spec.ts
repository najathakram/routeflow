/**
 * DB-lane spec for `../../scripts/backfill-refund-tender.mjs` (SA-740r2 item 7): the read -> write -> re-read round trip against a
 * REAL Postgres. The decision rules are locked without a database in `backfill-refund-tender-script.spec.ts`; this proves the
 * tenant-checked audit join, the dry run, the apply, the idempotent rerun, and that an unknown tender stays null.
 *
 * Collected only by `jest.db.config.js`, run via `npm run local:test:db`. SAFETY (L-129): every invocation passes
 * `--tenant-id <this file's own qa- tenant>`; afterAll deletes exactly what this file created.
 *
 * NOT EXECUTED in the authoring session (no local Postgres): written for shape against the real schema.
 */
import { execSync } from "child_process";
import { randomUUID } from "crypto";
import path from "path";
import { PrismaClient } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import { Pool } from "pg";
import { describeDb, requireLocalDatabaseUrl } from "./testing/db-spec";

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { assertTestTenant } = require("../../../../scripts/lib/test-tenants.cjs");

const API_DIR = path.resolve(__dirname, "../..");
const CLI = path.resolve(API_DIR, "scripts/backfill-refund-tender.mjs");
const RUN = randomUUID().slice(0, 8);

function runCli(dbUrl: string, tenantId: string, extra: string[] = []): string {
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const key of Object.keys(env)) {
    if (key.startsWith("RAILWAY_") || key.startsWith("POSTGRES_")) delete env[key];
  }
  env.DATABASE_URL = dbUrl;
  return execSync(`node "${CLI}" --tenant-id ${tenantId} ${extra.join(" ")}`, {
    cwd: API_DIR,
    encoding: "utf8",
    env,
  });
}

describeDb("backfill-refund-tender.mjs, real Postgres", () => {
  let prisma: PrismaClient;
  let pool: Pool;
  let dbUrl: string;
  let tenantId = "";
  let otherTenantId = "";
  let customerId = "";
  let orderId = "";
  const returnIds: Record<string, string> = {};

  const refundedReturn = async (key: string, over: Record<string, unknown> = {}) => {
    const ret = await prisma.return.create({
      data: {
        tenantId,
        customerId,
        orderId,
        returnNumber: `RET-TENDER-${RUN}-${key}`,
        reason: "DAMAGED",
        status: "REFUNDED",
        kind: "INLINE",
        refundMethod: "EXTERNAL_REFUND",
        refundAmount: 5,
        refundedAt: new Date(),
        ...over,
      } as any,
    });
    returnIds[key] = ret.id;
    return ret;
  };
  const audit = (entityId: string, meta: unknown, auditTenantId: string | null) =>
    prisma.auditLog.create({
      data: {
        action: "inline_return.refund",
        entityType: "Return",
        entityId,
        meta: meta as any,
        tenantId: auditTenantId,
      } as any,
    });
  const tenderOf = async (key: string) =>
    (await prisma.return.findUniqueOrThrow({ where: { id: returnIds[key] } })).refundTender;

  beforeAll(async () => {
    dbUrl = requireLocalDatabaseUrl();
    pool = new Pool({ connectionString: dbUrl });
    prisma = new PrismaClient({ adapter: new PrismaPg(pool) });
    const slug = assertTestTenant(`qa-rtender-${RUN}`, "backfill-refund-tender.db.spec.ts");
    tenantId = (await prisma.tenant.create({ data: { slug, name: `rtender ${slug}` } })).id;
    const otherSlug = assertTestTenant(`qa-rtender-o-${RUN}`, "backfill-refund-tender.db.spec.ts");
    otherTenantId = (
      await prisma.tenant.create({ data: { slug: otherSlug, name: `rtender ${otherSlug}` } })
    ).id;
    const user = await prisma.user.create({
      data: { email: `${slug}@example.invalid`, username: slug, role: "CUSTOMER", tenantId },
    });
    customerId = (
      await prisma.customer.create({
        data: { userId: user.id, businessName: "rtender", contactName: "rtender", tenantId } as any,
      })
    ).id;
    orderId = (
      await prisma.order.create({
        data: {
          tenantId,
          customerId,
          orderNumber: `ORD-RTENDER-${RUN}`,
          subtotal: 5,
          tax: 0,
          total: 5,
          status: "DELIVERED",
        } as any,
      })
    ).id;

    await audit((await refundedReturn("cash")).id, { tender: "CASH" }, tenantId);
    await audit((await refundedReturn("card")).id, { tender: "CARD" }, null); // a tenantless audit row is accepted
    await audit((await refundedReturn("check")).id, { tender: "CHECK" }, tenantId);
    await audit((await refundedReturn("unknown")).id, { tender: "BITCOIN" }, tenantId);
    await audit((await refundedReturn("othertenant")).id, { tender: "CASH" }, otherTenantId); // another tenant's row
    await audit(
      (await refundedReturn("set", { refundTender: "CHECK" })).id,
      { tender: "CASH" },
      tenantId,
    );
  }, 120_000);

  afterAll(async () => {
    const swallow = () => undefined;
    for (const id of [tenantId, otherTenantId].filter(Boolean)) {
      await prisma.auditLog.deleteMany({ where: { tenantId: id } }).catch(swallow);
    }
    await prisma.auditLog
      .deleteMany({ where: { entityId: { in: Object.values(returnIds) } } })
      .catch(swallow);
    await prisma.return.deleteMany({ where: { tenantId } }).catch(swallow);
    await prisma.order.deleteMany({ where: { tenantId } }).catch(swallow);
    await prisma.customer.deleteMany({ where: { tenantId } }).catch(swallow);
    await prisma.user.deleteMany({ where: { tenantId } }).catch(swallow);
    for (const id of [tenantId, otherTenantId].filter(Boolean)) {
      await prisma.tenant.delete({ where: { id } }).catch(swallow);
    }
    await prisma.$disconnect();
    await pool.end();
  });

  it("a dry run writes nothing and counts what it would do", async () => {
    const out = runCli(dbUrl, tenantId);
    expect(out).toMatch(/Dry run only/);
    expect(out).toMatch(/3 to backfill/);
    expect(await tenderOf("cash")).toBeNull();
  }, 60_000);

  it("--apply fills CASH / CARD (as CREDIT_CARD) / CHECK; an unknown tender, another tenant's audit row and an already-set column are left alone", async () => {
    runCli(dbUrl, tenantId, ["--apply"]);
    expect(await tenderOf("cash")).toBe("CASH");
    expect(await tenderOf("card")).toBe("CREDIT_CARD");
    expect(await tenderOf("check")).toBe("CHECK");
    expect(await tenderOf("unknown")).toBeNull(); // never CASH
    expect(await tenderOf("othertenant")).toBeNull();
    expect(await tenderOf("set")).toBe("CHECK"); // never overwritten by the audit tender (CASH)
  }, 60_000);

  it("a rerun is idempotent: 0 to backfill, nothing changes", async () => {
    const out = runCli(dbUrl, tenantId, ["--apply"]);
    expect(out).toMatch(/0 to backfill/);
    expect(await tenderOf("cash")).toBe("CASH");
  }, 60_000);
});
