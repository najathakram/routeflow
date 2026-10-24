/**
 * One product label per NAME KEY (SA, labels-from-categories): the admin create / rename refuse a labelNameKey
 * collision with 409 LABEL_NAME_TAKEN, under the per-tenant names lock the backfill script also takes. Against a
 * REAL Postgres: the case collision, a concurrent pair of creates (exactly one winner), and a create while the
 * backfill holds the lock (a clear 409, never a hang). Collected only by `jest.db.config.js`.
 */
import { randomUUID } from "crypto";
import { ConflictException } from "@nestjs/common";
import { PrismaClient } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import { Pool } from "pg";
import { describeDb, requireLocalDatabaseUrl } from "../common/testing/db-spec";
import { PrismaService } from "../prisma/prisma.service";
import { TenantContextService } from "../tenant/tenant-context.service";
import { AuditService } from "../audit/audit.service";
import type { JwtPayload } from "../auth/jwt-payload.interface";
import { ProductCategoriesService } from "./product-categories.service";
import { LABEL_NAMES_LOCK, labelNameKey } from "./label-writer";

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { assertTestTenant } = require("../../../../scripts/lib/test-tenants.cjs");

describeDb(
  "product label names — one per key, under the per-tenant names lock (real Postgres)",
  () => {
    const run = randomUUID().slice(0, 8);
    const slug = assertTestTenant(`qa-lname-${run}`, "product-categories-names.db.spec.ts");
    let pool: Pool;
    let raw: PrismaClient;
    let prisma: PrismaService;
    let ctx: TenantContextService;
    let service: ProductCategoriesService;
    let tenantId = "";
    const user = {
      sub: "u-admin",
      username: "admin",
      role: "TENANT_ADMIN",
    } as unknown as JwtPayload;
    const asT = <T>(fn: () => Promise<T>) => ctx.run(tenantId, fn);
    const namesWithKey = async (key: string) =>
      (await raw.productCategory.findMany({ where: { tenantId }, select: { name: true } }))
        .map((r) => r.name)
        .filter((n) => labelNameKey(n) === key);

    beforeAll(async () => {
      pool = new Pool({ connectionString: requireLocalDatabaseUrl() });
      raw = new PrismaClient({ adapter: new PrismaPg(pool) });
      ctx = new TenantContextService();
      prisma = new PrismaService(ctx);
      await prisma.$connect();
      service = new ProductCategoriesService(prisma, new AuditService(prisma));
      tenantId = (await raw.tenant.create({ data: { slug, name: `Label names ${slug}` } })).id;
    }, 120_000);

    afterAll(async () => {
      if (tenantId) {
        await raw.auditLog.deleteMany({ where: { tenantId } });
        await raw.productCategory.deleteMany({ where: { tenantId } });
        await raw.tenant.deleteMany({ where: { id: tenantId } });
      }
      await prisma?.$disconnect();
      await raw?.$disconnect();
      await pool?.end();
    }, 120_000);

    it('creating "vape" when "Vape" exists is a 409 LABEL_NAME_TAKEN naming "Vape"; nothing created', async () => {
      await asT(() => service.create({ name: "Vape" } as never, user));
      const err = await asT(() => service.create({ name: "vape" } as never, user)).catch((e) => e);
      expect(err).toBeInstanceOf(ConflictException);
      expect((err as ConflictException).getResponse()).toMatchObject({
        code: "LABEL_NAME_TAKEN",
        message: 'A label named "Vape" already exists.',
      });
      expect(await namesWithKey("vape")).toEqual(["Vape"]);
    }, 60_000);

    it("a rename onto another label's key is refused; a case-only rename of itself is allowed", async () => {
      const alc = await asT(() => service.create({ name: "Alcohol" } as never, user));
      await expect(
        asT(() => service.update(alc.id, { name: "VAPE" } as never, user)),
      ).rejects.toMatchObject({ response: { code: "LABEL_NAME_TAKEN" } });
      const renamed = await asT(() => service.update(alc.id, { name: "ALCOHOL" } as never, user));
      expect(renamed.name).toBe("ALCOHOL");
    }, 60_000);

    it("two concurrent creates of one key: exactly ONE winner, the other a 409", async () => {
      const results = await Promise.allSettled([
        asT(() => service.create({ name: "Kratom" } as never, user)),
        asT(() => service.create({ name: "KRATOM" } as never, user)),
      ]);
      const won = results.filter((r) => r.status === "fulfilled");
      const lost = results.filter((r) => r.status === "rejected") as PromiseRejectedResult[];
      expect(won).toHaveLength(1);
      expect(lost).toHaveLength(1);
      expect(lost[0].reason).toBeInstanceOf(ConflictException);
      expect(await namesWithKey("kratom")).toHaveLength(1);
    }, 60_000);

    it("a create while the backfill holds the tenant's names lock is a clear 409 (bounded wait), nothing created", async () => {
      const holder = await pool.connect();
      try {
        await holder.query("BEGIN");
        await holder.query("SELECT pg_advisory_xact_lock(hashtext($1), hashtext($2))", [
          LABEL_NAMES_LOCK,
          tenantId,
        ]);
        const err = await asT(() => service.create({ name: "Hemp" } as never, user)).catch(
          (e) => e,
        );
        expect(err).toBeInstanceOf(ConflictException);
        expect(String((err as ConflictException).message)).toMatch(/in progress/);
        expect(await namesWithKey("hemp")).toEqual([]);
      } finally {
        await holder.query("ROLLBACK");
        holder.release();
      }
      // released: the same create now succeeds
      await asT(() => service.create({ name: "Hemp" } as never, user));
      expect(await namesWithKey("hemp")).toEqual(["Hemp"]);
    }, 60_000);
  },
);
