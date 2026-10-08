/**
 * Units U-6, real Postgres: scripts/backfill-tenant-units.mjs.
 *
 * Seeds a throwaway `qa-*` tenant with products carrying ladder levels and legacy pack words, then
 * drives the REAL CLI (child process): dry-run writes nothing, --apply creates/links/fills, a second
 * --apply changes nothing, a non-test slug with --apply is refused, and only the tenant's own rows
 * are touched (a second tenant is byte-identical afterwards).
 *
 * Runs only under `npm run local:test:db`. Output is counts only; the spec asserts that no unit name
 * or id is printed.
 */
import { spawnSync } from "node:child_process";
import path from "node:path";
import { randomUUID } from "crypto";
import { PrismaClient } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import { Pool } from "pg";
import { describeDb, requireLocalDatabaseUrl } from "../common/testing/db-spec";

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { assertTestTenant } = require("../../../../scripts/lib/test-tenants.cjs");

const CLI = path.resolve(__dirname, "../../scripts/backfill-tenant-units.mjs");
const RUN = randomUUID().slice(0, 8);

describeDb("tenant unit backfill (U-6)", () => {
  let pool: Pool;
  let prisma: PrismaClient;
  let url: string;
  const slugA = assertTestTenant(`qa-u6-${RUN}-a`, "backfill-tenant-units.db.spec.ts");
  const slugB = assertTestTenant(`qa-u6-${RUN}-b`, "backfill-tenant-units.db.spec.ts");
  let tenantA = "";
  let tenantB = "";

  const cli = (slug: string, apply: boolean) =>
    spawnSync(process.execPath, [CLI, "--tenant", slug, ...(apply ? ["--apply"] : [])], {
      env: { ...process.env, DATABASE_URL: url },
      encoding: "utf8",
    });

  async function product(tenantId: string, tag: string, unit: string, levels: string[]) {
    const p = await prisma.product.create({
      data: { tenantId, name: `u6 ${tag}`, unit, pricePerUnit: 10 },
    });
    let factor = 2;
    for (const label of levels) {
      await prisma.productUnit.create({
        data: { tenantId, productId: p.id, label, factorToBase: factor },
      });
      factor *= 3;
    }
    return p.id;
  }

  const snapshotB = async () =>
    JSON.stringify([
      await prisma.productUnit.findMany({ where: { tenantId: tenantB }, orderBy: { id: "asc" } }),
      await prisma.product.findMany({ where: { tenantId: tenantB }, orderBy: { id: "asc" } }),
      await prisma.tenantUnit.findMany({ where: { tenantId: tenantB } }),
    ]);

  beforeAll(async () => {
    url = requireLocalDatabaseUrl();
    pool = new Pool({ connectionString: url });
    prisma = new PrismaClient({ adapter: new PrismaPg(pool) });
    tenantA = (await prisma.tenant.create({ data: { slug: slugA, name: `u6 ${slugA}` } })).id;
    tenantB = (await prisma.tenant.create({ data: { slug: slugB, name: `u6 ${slugB}` } })).id;

    // Tenant A: levels Case x2 (casing "Case" wins 2:1), Pack, a synonym, a too-long word;
    // legacy words Case / Tray / "" and a product that already has a packLabel.
    await product(tenantA, "1", "Case", ["Case", "Pack"]);
    await product(tenantA, "2", "case", ["Case", "piece"]);
    await product(tenantA, "3", "Tray", ["x".repeat(31)]);
    const keep = await product(tenantA, "4", "Crate", []);
    await prisma.product.update({ where: { id: keep }, data: { packLabel: "Carton" } });
    // Tenant B is an untouched control with a legacy word of its own.
    await product(tenantB, "b", "Bundle", ["Bundle"]);
  });

  afterAll(async () => {
    const ids = [tenantA, tenantB].filter(Boolean);
    await prisma?.productUnit.deleteMany({ where: { tenantId: { in: ids } } });
    await prisma?.product.deleteMany({ where: { tenantId: { in: ids } } });
    await prisma?.tenantUnit.deleteMany({ where: { tenantId: { in: ids } } });
    await prisma?.tenant.deleteMany({ where: { id: { in: ids } } });
    await prisma?.$disconnect();
    await pool?.end();
  });

  it("refuses --apply on a non-test slug", () => {
    const r = cli("acme-wholesale", true);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("Test-tenant policy violation");
  });

  it("dry-run reports counts and writes nothing", async () => {
    const bBefore = await snapshotB();
    const r = cli(slugA, false);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("Would apply");
    expect(await prisma.tenantUnit.count({ where: { tenantId: tenantA } })).toBe(0);
    expect(
      await prisma.productUnit.count({ where: { tenantId: tenantA, tenantUnitId: { not: null } } }),
    ).toBe(0);
    expect(await snapshotB()).toBe(bBefore);
  });

  it("--apply creates, links and fills; counts only; control tenant untouched", async () => {
    const bBefore = await snapshotB();
    const r = cli(slugA, true);
    expect(r.status).toBe(0);
    // Distinct usable keys: case, pack, tray, crate (crate is a legacy pack word only)
    // => case, pack, tray, crate = 4 created. Too long: 1 level key. Synonyms: piece = 1.
    // Levels linked: Case, Pack, Case, (piece skipped), (too-long skipped) = 3.
    // packLabel filled: p1 Case, p2 case, p3 Tray = 3 (p4 already has Carton).
    expect(r.stdout).toContain("tenantUnits created=4 existing=0");
    expect(r.stdout).toContain("productUnits linked=3");
    expect(r.stdout).toContain("products packLabel filled=3");
    expect(r.stdout).toContain("skipped tooLong=1 synonyms=1");
    expect(r.stdout).not.toMatch(/Tray|Crate|Carton|[0-9a-f]{8}-[0-9a-f]{4}/);

    const units = await prisma.tenantUnit.findMany({ where: { tenantId: tenantA } });
    expect(units.map((u) => u.nameKey).sort()).toEqual(["case", "crate", "pack", "tray"]);
    expect(units.find((u) => u.nameKey === "case")?.name).toBe("Case");

    const linked = await prisma.productUnit.findMany({
      where: { tenantId: tenantA, tenantUnitId: { not: null } },
      include: { tenantUnit: true },
    });
    expect(linked).toHaveLength(3);
    for (const l of linked) expect(l.tenantUnit?.nameKey).toBe(l.label.trim().toLowerCase());
    const unlinked = await prisma.productUnit.findMany({
      where: { tenantId: tenantA, tenantUnitId: null },
    });
    expect(unlinked.map((u) => u.label.length === 31 || u.label === "piece").every(Boolean)).toBe(
      true,
    );

    const packs = await prisma.product.findMany({
      where: { tenantId: tenantA },
      orderBy: { name: "asc" },
      select: { packLabel: true, baseUnitLabel: true },
    });
    expect(packs.map((p) => p.packLabel)).toEqual(["Case", "case", "Tray", "Carton"]);
    expect(packs.every((p) => p.baseUnitLabel === null)).toBe(true);

    expect(await snapshotB()).toBe(bBefore);
  });

  it("a second --apply changes nothing (idempotent)", async () => {
    const before = JSON.stringify([
      await prisma.tenantUnit.findMany({
        where: { tenantId: tenantA },
        orderBy: { nameKey: "asc" },
      }),
      await prisma.productUnit.findMany({ where: { tenantId: tenantA }, orderBy: { id: "asc" } }),
      await prisma.product.findMany({ where: { tenantId: tenantA }, orderBy: { id: "asc" } }),
    ]);
    const r = cli(slugA, true);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("tenantUnits created=0 existing=4");
    expect(r.stdout).toContain("productUnits linked=0");
    expect(r.stdout).toContain("products packLabel filled=0");
    const after = JSON.stringify([
      await prisma.tenantUnit.findMany({
        where: { tenantId: tenantA },
        orderBy: { nameKey: "asc" },
      }),
      await prisma.productUnit.findMany({ where: { tenantId: tenantA }, orderBy: { id: "asc" } }),
      await prisma.product.findMany({ where: { tenantId: tenantA }, orderBy: { id: "asc" } }),
    ]);
    expect(after).toBe(before);
  });
});
