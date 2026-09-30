/**
 * DB-lane spec for `../../scripts/bootstrap-house-tenant.mjs` — proves the dry-run/apply
 * mechanics against a REAL Postgres (idempotency, "dry run makes no writes", the house tenant
 * actually created as class INTERNAL). Lives under `src/common` (not next to the script under
 * `scripts/`) because `jest.db.config.js` inherits `rootDir: "src"` from the base Jest config —
 * a spec under `apps/api/scripts/` would never be discovered by `npm run local:test:db`,
 * matching the sibling precedent `backfill-tenant-class.db.spec.ts`.
 *
 * Collected only by `jest.db.config.js` (`.db.spec.ts$`), run via `npm run local:test:db`
 * (`node scripts/local-env.mjs --db --db-specs -- "npm run test:db -w apps/api"`), which points
 * DATABASE_URL at the compose Postgres and sets RUN_DB_SPECS. `requireLocalDatabaseUrl()`
 * refuses any non-local host.
 *
 * `routeflow-hq` is a global singleton slug — unlike the scoped `qa-*`/`acme-*` fixtures other
 * `.db.spec.ts` files use, this spec's rows are NOT namespaced per-run. `beforeAll` clears any
 * leftover `routeflow-hq` tenant / `platform.houseTenantId` config key (a prior run's failed
 * cleanup, never a real seed — `npm run local:seed` does not call this script) so the spec starts
 * from a known-empty slate; `afterAll` restores that slate.
 */
import { execSync } from "child_process";
import path from "path";
import { PrismaClient } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import { Pool } from "pg";
import { describeDb, requireLocalDatabaseUrl } from "./testing/db-spec";

const API_DIR = path.resolve(__dirname, "../..");
const CLI = path.resolve(API_DIR, "scripts/bootstrap-house-tenant.mjs");
const HOUSE_SLUG = "routeflow-hq";
const HOUSE_CONFIG_KEY = "platform.houseTenantId";

// Mirrors backfill-tenant-class.db.spec.ts's REG-743-N2 guard: a leftover `railway run` proxy
// export (or one this spec's own process happens to carry) must never make this prod-targeting
// CLI resolve anything but this spec's own local `dbUrl`.
function childEnv(dbUrl: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const key of Object.keys(env)) {
    if (key.startsWith("RAILWAY_") || key.startsWith("POSTGRES_")) delete env[key];
  }
  env.DATABASE_URL = dbUrl;
  return env;
}

describeDb("bootstrap-house-tenant.mjs (db)", () => {
  const dbUrl = requireLocalDatabaseUrl();
  const pool = new Pool({ connectionString: dbUrl });
  const prisma = new PrismaClient({ adapter: new PrismaPg(pool) });

  async function clearHouseTenant() {
    await prisma.tenant.deleteMany({ where: { slug: HOUSE_SLUG } });
    await prisma.$executeRaw`DELETE FROM "PlatformConfig" WHERE key = ${HOUSE_CONFIG_KEY}`;
  }

  beforeAll(async () => {
    await clearHouseTenant();
  });

  afterAll(async () => {
    await clearHouseTenant();
    await prisma.$disconnect();
    await pool.end();
  });

  it("dry run makes no writes", async () => {
    execSync(`node ${CLI}`, { encoding: "utf-8", env: childEnv(dbUrl) });

    const tenant = await prisma.tenant.findUnique({ where: { slug: HOUSE_SLUG } });
    const config = await prisma.$queryRaw<
      Array<{ value: string }>
    >`SELECT value FROM "PlatformConfig" WHERE key = ${HOUSE_CONFIG_KEY}`;
    expect(tenant).toBeNull();
    expect(config).toHaveLength(0);
  });

  it("apply creates routeflow-hq as class INTERNAL and sets the config key", async () => {
    const output = execSync(`node ${CLI} --apply`, { encoding: "utf-8", env: childEnv(dbUrl) });
    expect(output).toMatch(/^Resolved database host: /);

    const tenant = await prisma.tenant.findUnique({
      where: { slug: HOUSE_SLUG },
      include: { config: true },
    });
    expect(tenant?.class).toBe("INTERNAL");
    expect(tenant?.status).toBe("ACTIVE");
    expect(tenant?.plan).toBe("ENTERPRISE");
    expect(tenant?.config?.businessName).toBe("RouteFlow HQ");

    const config = await prisma.$queryRaw<
      Array<{ value: string }>
    >`SELECT value FROM "PlatformConfig" WHERE key = ${HOUSE_CONFIG_KEY}`;
    expect(config[0]?.value).toBe(tenant?.id);
  });

  it("a second apply is a no-op (idempotent)", async () => {
    const before = await prisma.tenant.findUnique({ where: { slug: HOUSE_SLUG } });

    execSync(`node ${CLI} --apply`, { encoding: "utf-8", env: childEnv(dbUrl) });

    const all = await prisma.tenant.findMany({ where: { slug: HOUSE_SLUG } });
    expect(all).toHaveLength(1);
    expect(all[0]?.id).toBe(before?.id);
    expect(all[0]?.class).toBe("INTERNAL");

    const config = await prisma.$queryRaw<
      Array<{ value: string }>
    >`SELECT value FROM "PlatformConfig" WHERE key = ${HOUSE_CONFIG_KEY}`;
    expect(config[0]?.value).toBe(before?.id);
  });
});
