/**
 * Row 434: `prisma/seed.ts` wrote CustomerAddress.state ("TX") without deriving stateCode, so every
 * seeded customer was INDETERMINATE to the selling-restrictions engine (which reads ONLY stateCode)
 * and showed up as "needs a state". The seed must derive the code at the write boundary through
 * `addressStateFields`, like every other address writer.
 *
 * Runs the REAL seed against the local compose Postgres, then asserts that no seeded address carries
 * state text with a NULL stateCode. The seed's tenant is the approved test tenant `test` (its own
 * assertTestTenant + assertSafeTarget guard it). Run via `npm run local:test:db` on a FRESH database:
 * the seed upserts with `update: {}`, so rows an older seed wrote are not rewritten.
 */
import { spawnSync } from "child_process";
import path from "path";
import { PrismaClient } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import { Pool } from "pg";
import { describeDb, requireLocalDatabaseUrl } from "../common/testing/db-spec";

const API_DIR = path.resolve(__dirname, "../..");

describeDb("prisma/seed.ts addresses carry a derived stateCode (row 434)", () => {
  let pool: Pool;
  let prisma: PrismaClient;

  beforeAll(async () => {
    const url = requireLocalDatabaseUrl();
    const env: NodeJS.ProcessEnv = { ...process.env };
    for (const key of Object.keys(env)) {
      if (key.startsWith("RAILWAY_") || key.startsWith("POSTGRES_")) delete env[key];
    }
    env.DATABASE_URL = url;
    const res = spawnSync("npx", ["tsx", "./prisma/seed.ts"], {
      cwd: API_DIR,
      env,
      encoding: "utf8",
      timeout: 300_000,
      // On Windows `npx` is npx.cmd, which spawnSync cannot start without a shell (status null, no output).
      shell: process.platform === "win32",
    });
    if (res.status !== 0)
      throw new Error(`seed exited ${res.status}\n${res.stdout}\n${res.stderr}`);
    pool = new Pool({ connectionString: url });
    prisma = new PrismaClient({ adapter: new PrismaPg(pool) });
  }, 330_000);

  afterAll(async () => {
    await prisma?.$disconnect();
    await pool?.end();
  });

  it("no seeded address has state text with a NULL stateCode", async () => {
    const tenant = await prisma.tenant.findUnique({
      where: { slug: "test" },
      select: { id: true },
    });
    expect(tenant).not.toBeNull();
    const seeded = await prisma.customerAddress.findMany({
      where: { tenantId: tenant!.id, id: { startsWith: "seed-addr-" } },
      select: { state: true, stateCode: true, stateNeedsReview: true },
    });
    expect(seeded.length).toBeGreaterThan(0);
    const unresolved = seeded.filter((a) => (a.state ?? "").trim() !== "" && a.stateCode === null);
    expect(unresolved).toEqual([]);
    for (const a of seeded) expect(a).toMatchObject({ stateCode: "TX", stateNeedsReview: false });
  });
});
