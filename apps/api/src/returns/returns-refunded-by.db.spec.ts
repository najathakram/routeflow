/**
 * Row 257 on real Postgres: `GET /returns/:id` names the refunder (`refundedBy`) from the stored refund audit row, and BOTH
 * reads (the audit row, the user) are scoped to the return's own tenant. Red case: a NEWER refund audit row for the same
 * return id from ANOTHER tenant, and an audit row naming a user of another tenant, must never name anyone. A buyer's read
 * carries no `refundedBy`.
 *
 * WRITTEN, NOT RUN by the builder: win-test runs it (`npm run local:test:db`). Collected only by `jest.db.config.js`.
 * Two throwaway `qa-rfby-<run>-a|b` tenants (assertTestTenant); `afterAll` deletes exactly what this run created.
 */
import { randomUUID } from "crypto";
import { PrismaClient } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import { Pool } from "pg";
import { describeDb, requireLocalDatabaseUrl } from "../common/testing/db-spec";
import { PrismaService } from "../prisma/prisma.service";
import { TenantContextService } from "../tenant/tenant-context.service";
import { ReturnsService } from "./returns.service";
import { INLINE_REFUND_AUDIT_ACTION } from "./inline-return-refund";
import type { JwtPayload } from "../auth/jwt-payload.interface";

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { assertTestTenant } = require("../../../../scripts/lib/test-tenants.cjs");

describeDb("row 257: refundedBy is tenant-scoped, real Postgres", () => {
  let pool: Pool;
  let raw: PrismaClient;
  let prisma: PrismaService;
  let tenantCtx: TenantContextService;
  let returns: ReturnsService;
  const run = randomUUID().slice(0, 8);
  const tenantA = {
    id: "",
    slug: assertTestTenant(`qa-rfby-${run}-a`, "returns-refunded-by.db.spec.ts"),
  };
  const tenantB = {
    id: "",
    slug: assertTestTenant(`qa-rfby-${run}-b`, "returns-refunded-by.db.spec.ts"),
  };
  let caseyId = "";
  let malloryId = "";
  let buyerUserId = "";
  let returnId = "";

  const user = (role: "OPERATOR" | "CUSTOMER", sub: string): JwtPayload =>
    ({
      sub,
      username: `u-${run}`,
      role,
      status: "ACTIVE",
      tenantId: tenantA.id,
      tenantSlug: tenantA.slug,
    }) as JwtPayload;
  const readAs = (u: JwtPayload) =>
    tenantCtx.run(tenantA.id, () => returns.findOneForUser(returnId, u)) as Promise<{
      refundedBy?: string | null;
    }>;

  beforeAll(async () => {
    pool = new Pool({ connectionString: requireLocalDatabaseUrl() });
    raw = new PrismaClient({ adapter: new PrismaPg(pool) });
    tenantCtx = new TenantContextService();
    prisma = new PrismaService(tenantCtx);
    await prisma.$connect();
    returns = Object.assign(Object.create(ReturnsService.prototype), { prisma });

    tenantA.id = (await raw.tenant.create({ data: { slug: tenantA.slug, name: tenantA.slug } })).id;
    tenantB.id = (await raw.tenant.create({ data: { slug: tenantB.slug, name: tenantB.slug } })).id;
    caseyId = (
      await raw.user.create({
        data: {
          email: `casey-${run}@example.test`,
          username: `casey-${run}`,
          role: "OPERATOR",
          tenantId: tenantA.id,
        },
      })
    ).id;
    malloryId = (
      await raw.user.create({
        data: {
          email: `mallory-${run}@example.test`,
          username: `mallory-${run}`,
          role: "OPERATOR",
          tenantId: tenantB.id,
        },
      })
    ).id;
    buyerUserId = (
      await raw.user.create({
        data: {
          email: `buyer-${run}@example.test`,
          username: `buyer-${run}`,
          role: "CUSTOMER",
          tenantId: tenantA.id,
        },
      })
    ).id;
    const customer = await raw.customer.create({
      data: {
        userId: buyerUserId,
        businessName: `Buyer ${run}`,
        contactName: "Buyer",
        tenantId: tenantA.id,
      },
    });
    const order = await raw.order.create({
      data: {
        customerId: customer.id,
        tenantId: tenantA.id,
        status: "DELIVERED" as never,
        subtotal: "0.00",
        total: "0.00",
      },
    });
    returnId = (
      await raw.return.create({
        data: {
          orderId: order.id,
          customerId: customer.id,
          reason: "DAMAGED",
          status: "REFUNDED",
          refundAmount: "5.00",
          refundedAt: new Date("2026-10-20T10:00:00Z"),
          refundMethod: "EXTERNAL_REFUND",
          tenantId: tenantA.id,
          kind: "INLINE",
        },
      })
    ).id;
    // The genuine refund audit row (tenant A, casey) ...
    await raw.auditLog.create({
      data: {
        tenantId: tenantA.id,
        userId: caseyId,
        action: INLINE_REFUND_AUDIT_ACTION,
        entityType: "Return",
        entityId: returnId,
        createdAt: new Date("2026-10-20T10:00:00Z"),
      },
    });
    // ... and a NEWER one for the same return id written under ANOTHER tenant (mallory): must never win.
    await raw.auditLog.create({
      data: {
        tenantId: tenantB.id,
        userId: malloryId,
        action: INLINE_REFUND_AUDIT_ACTION,
        entityType: "Return",
        entityId: returnId,
        createdAt: new Date("2026-10-21T10:00:00Z"),
      },
    });
  }, 120_000);

  afterAll(async () => {
    const tenantIds = [tenantA.id, tenantB.id].filter(Boolean);
    await raw.auditLog.deleteMany({ where: { tenantId: { in: tenantIds } } });
    await raw.return.deleteMany({ where: { tenantId: { in: tenantIds } } });
    await raw.order.deleteMany({ where: { tenantId: { in: tenantIds } } });
    await raw.customer.deleteMany({ where: { tenantId: { in: tenantIds } } });
    await raw.user.deleteMany({ where: { tenantId: { in: tenantIds } } });
    await raw.tenant.deleteMany({ where: { id: { in: tenantIds } } });
    await prisma?.$disconnect();
    await raw?.$disconnect();
    await pool?.end();
  }, 120_000);

  it("names the tenant's own refunder, even when another tenant has a NEWER refund audit row for the same id", async () => {
    expect((await readAs(user("OPERATOR", caseyId))).refundedBy).toBe(`casey-${run}`);
  });

  it("an audit row that names a user of ANOTHER tenant names nobody", async () => {
    await raw.auditLog.create({
      data: {
        tenantId: tenantA.id,
        userId: malloryId,
        action: INLINE_REFUND_AUDIT_ACTION,
        entityType: "Return",
        entityId: returnId,
        createdAt: new Date("2026-10-22T10:00:00Z"),
      },
    });
    expect((await readAs(user("OPERATOR", caseyId))).refundedBy).toBeNull();
  });

  it("a buyer's read of their own return carries no refundedBy", async () => {
    expect(await readAs(user("CUSTOMER", buyerUserId))).not.toHaveProperty("refundedBy");
  });
});
