/**
 * AI limits PR-2: `delete-tenant-anthropic-keys` core against a real database. Stored business Claude keys are found by
 * reference (no value read), deleted together with one AuditLog row each in ONE transaction, and a second run finds nothing.
 * Another key, another business's other settings, and the platform key are never touched; a stale row rolls everything back.
 *
 * Runs only under `npm run local:test:db`. Every tenant is a throwaway `qa-delkeys-<run>-<n>` slug (`assertTestTenant`).
 */
import { randomUUID } from "crypto";
import { Pool } from "pg";
import { describeDb, requireLocalDatabaseUrl } from "../common/testing/db-spec";
import { PrismaService } from "../prisma/prisma.service";
import { TenantContextService } from "../tenant/tenant-context.service";

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { assertTestTenant } = require("../../../../scripts/lib/test-tenants.cjs");
// eslint-disable-next-line @typescript-eslint/no-var-requires
const core = require("../../scripts/lib/delete-anthropic-keys-core.cjs");

const RUN = randomUUID().slice(0, 8);
const SECRET = "sk-ant-api03-DELETEDELETEDELETEDELETEDELETE1111";

describeDb("delete-tenant-anthropic-keys core (AI limits PR-2)", () => {
  let prisma: PrismaService;
  let pool: Pool;
  let url: string;
  const tenantIds: string[] = [];

  beforeAll(async () => {
    url = requireLocalDatabaseUrl();
    prisma = new PrismaService(new TenantContextService());
    await prisma.$connect();
    pool = new Pool({ connectionString: url });
  });

  afterAll(async () => {
    const swallow = () => undefined;
    for (const id of tenantIds) {
      await pool.query(`DELETE FROM "AuditLog" WHERE "tenantId" = $1`, [id]).catch(swallow);
      await prisma.tenant.delete({ where: { id } }).catch(swallow);
    }
    await pool?.end();
    await prisma?.$disconnect();
  });

  async function makeTenant(n: number) {
    const slug = assertTestTenant(`qa-delkeys-${RUN}-${n}`, "delete-anthropic-keys.db.spec.ts");
    const t = await prisma.tenant.create({ data: { slug, name: `delkeys ${slug}` } });
    tenantIds.push(t.id);
    return t.id;
  }
  const put = (tenantId: string, key: string, value: string) =>
    pool.query(
      `INSERT INTO "SystemConfig" ("id","tenantId","key","value","updatedAt") VALUES (gen_random_uuid()::text, $1, $2, $3, now())`,
      [tenantId, key, value],
    );
  const has = async (tenantId: string, key: string) =>
    (
      await pool.query(`SELECT 1 FROM "SystemConfig" WHERE "tenantId" = $1 AND key = $2`, [
        tenantId,
        key,
      ])
    ).rowCount === 1;
  const audits = async (tenantId: string) =>
    (
      await pool.query(
        `SELECT "entityId", meta FROM "AuditLog" WHERE "tenantId" = $1 AND action = $2`,
        [tenantId, core.AUDIT_ACTION],
      )
    ).rows;
  const mine = async () =>
    (await core.keyRefs(pool)).filter((r: { tenantId: string }) => tenantIds.includes(r.tenantId));

  it("D-1: it finds the stored business keys by reference: not a cleared key, not another setting", async () => {
    const a = await makeTenant(1);
    const b = await makeTenant(2);
    const c = await makeTenant(3);
    await put(a, "anthropic.apiKey", SECRET);
    await put(a, "email.smtpPassword", "smtp-keep-me");
    await put(b, "anthropic.apiKey", SECRET);
    await put(c, "anthropic.apiKey", ""); // cleared sentinel: nothing to delete
    const refs = await mine();
    expect(refs.map((r: { tenantId: string }) => r.tenantId).sort()).toEqual([a, b].sort());
    expect(refs.every((r: { isTest: boolean }) => r.isTest)).toBe(true);
    expect(JSON.stringify(refs)).not.toContain(SECRET);
  });

  it("D-2: apply deletes each key and writes one AuditLog row each (ids only); other settings stay", async () => {
    const [a, b] = tenantIds;
    const { write } = core.planDeletes({ refs: await mine(), liveOverride: false });
    expect(await core.deleteAll({ client: pool, write })).toBe(2);
    expect(await has(a, "anthropic.apiKey")).toBe(false);
    expect(await has(b, "anthropic.apiKey")).toBe(false);
    expect(await has(a, "email.smtpPassword")).toBe(true);
    const rows = await audits(a);
    expect(rows).toHaveLength(1);
    expect(rows[0].meta).toEqual({ key: "anthropic.apiKey", actor: "script" });
    expect(JSON.stringify(rows)).not.toContain(SECRET);
  });

  it("D-3: a second run finds nothing and deletes 0", async () => {
    expect(await mine()).toEqual([]);
    expect(await core.deleteAll({ client: pool, write: [] })).toBe(0);
  });

  it("D-5: liveTenantCount counts only tenants that are not approved test tenants; keyRefs marks a non-test tenant's row isTest: false", async () => {
    const before = await core.liveTenantCount(pool);
    const live = await prisma.tenant.create({
      data: { slug: `acme-delkeys-${RUN}`, name: "acme" },
    });
    tenantIds.push(live.id);
    expect(await core.liveTenantCount(pool)).toBe(before + 1);
    await put(live.id, "anthropic.apiKey", SECRET);
    const refs = (await mine()).filter((r: { tenantId: string }) => r.tenantId === live.id);
    expect(refs).toHaveLength(1);
    expect(refs[0].isTest).toBe(false);
    await pool.query(`DELETE FROM "SystemConfig" WHERE "tenantId" = $1`, [live.id]);
  });

  it("D-6: a dry run's session refuses any write; an --apply session may write", async () => {
    const t = tenantIds[0];
    const attempt = (apply: boolean) => {
      const p = new Pool(core.poolConfig(url, apply));
      return p
        .query(
          `INSERT INTO "AuditLog" (id, "tenantId", action, "entityType", "entityId", "createdAt")
           VALUES (gen_random_uuid()::text, $1, 'probe.delkeys.dryrun', 'SystemConfig', 'probe', now())`,
          [t],
        )
        .finally(() => p.end());
    };
    await expect(attempt(false)).rejects.toThrow(/read-only transaction/);
    await attempt(true);
    expect(
      (await pool.query(`SELECT 1 FROM "AuditLog" WHERE action = 'probe.delkeys.dryrun'`)).rowCount,
    ).toBe(1); // only the --apply session's insert landed
  });

  it("D-4: one stale row rolls the whole run back: nothing deleted, no audit row", async () => {
    const d = await makeTenant(4);
    const e = await makeTenant(5);
    await put(d, "anthropic.apiKey", SECRET);
    await put(e, "anthropic.apiKey", SECRET);
    const refs = await mine();
    await pool.query(
      `DELETE FROM "SystemConfig" WHERE "tenantId" = $1 AND key = 'anthropic.apiKey'`,
      [e],
    );
    await expect(core.deleteAll({ client: pool, write: refs })).rejects.toThrow(/rolled back/);
    expect(await has(d, "anthropic.apiKey")).toBe(true);
    expect(await audits(d)).toEqual([]);
  });
});
