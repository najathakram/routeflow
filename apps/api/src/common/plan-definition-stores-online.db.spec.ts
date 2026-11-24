/**
 * SA-1269 (P-40b) against a real database: after `prisma migrate deploy`, "PlanDefinition"."storesOnlineIncluded" is a
 * nullable INTEGER with no default, so a definition written without it (every row that existed before the migration)
 * reads NULL = no cap. PlanDefinition is platform catalog data, not tenant data: the throwaway PlanVersion rows use a
 * version number far above the real ones and are deleted again (definitions cascade).
 */
import { randomUUID } from "crypto";
import { Pool } from "pg";
import { describeDb, requireLocalDatabaseUrl } from "./testing/db-spec";

const VERSION = 900_000_000 + Math.floor(Math.random() * 99_000_000);

describeDb("PlanDefinition.storesOnlineIncluded (P-40b)", () => {
  let pool: Pool;
  const versionId = randomUUID();

  beforeAll(async () => {
    pool = new Pool({ connectionString: requireLocalDatabaseUrl() });
    await pool.query(
      `INSERT INTO "PlanVersion" ("id","version","updatedAt") VALUES ($1,$2, now())`,
      [versionId, VERSION],
    );
  });

  afterAll(async () => {
    await pool.query(`DELETE FROM "PlanVersion" WHERE id = $1`, [versionId]).catch(() => undefined);
    await pool?.end();
  });

  it("S-1: the column is a nullable INTEGER with no default", async () => {
    const r = await pool.query(
      `SELECT data_type, is_nullable, column_default FROM information_schema.columns
        WHERE table_name = 'PlanDefinition' AND column_name = 'storesOnlineIncluded'`,
    );
    expect(r.rows).toEqual([{ data_type: "integer", is_nullable: "YES", column_default: null }]);
  });

  it("S-2: a definition written without the column reads NULL (no cap); an explicit cap round-trips", async () => {
    await pool.query(
      `INSERT INTO "PlanDefinition" ("id","planVersionId","planKey","name","featureFlags")
       VALUES ($1,$2,'QA_OLD','old row','{}')`,
      [randomUUID(), versionId],
    );
    await pool.query(
      `INSERT INTO "PlanDefinition" ("id","planVersionId","planKey","name","featureFlags","storesOnlineIncluded")
       VALUES ($1,$2,'QA_CAPPED','capped row','{}',3)`,
      [randomUUID(), versionId],
    );
    const r = await pool.query(
      `SELECT "planKey","storesOnlineIncluded" FROM "PlanDefinition" WHERE "planVersionId" = $1 ORDER BY "planKey"`,
      [versionId],
    );
    expect(r.rows).toEqual([
      { planKey: "QA_CAPPED", storesOnlineIncluded: 3 },
      { planKey: "QA_OLD", storesOnlineIncluded: null },
    ]);
  });
});
