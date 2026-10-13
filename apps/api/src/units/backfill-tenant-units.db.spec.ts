/**
 * Units U-6, real Postgres: scripts/backfill-tenant-units.mjs (SA verdict on #3336: M1-M4).
 *
 * Seeds throwaway `qa-*` tenants and drives the REAL CLI (child process, --local --tenant <id>):
 *   - a dry run writes nothing at all (Product byte-identical, no unit, no link);
 *   - --apply creates units, links levels and fills parentUnitId/perParent, and NEVER writes a Product
 *     (M1); a second --apply changes nothing; a control tenant is byte-identical;
 *   - the parent fill picks the largest dividing lower level, and a non-divisible level is reported and
 *     skipped (M2);
 *   - a protected (Stripe-linked) tenant is refused --apply without the override, and nothing is
 *     written (M3);
 *   - an edit landing between plan and apply on real PG is skipped and reported, never overwritten (M4
 *     + compare-and-set).
 * Runs only under `npm run local:test:db`. Output never names a tenant, slug or row id.
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
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { planTenantUnits } = require("../../scripts/lib/tenant-units-plan.cjs");
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { applyTenantUnitsPlan } = require("../../scripts/lib/tenant-units-apply.cjs");

const CLI = path.resolve(__dirname, "../../scripts/backfill-tenant-units.mjs");
const RUN = randomUUID().slice(0, 8);
const SPEC = "backfill-tenant-units.db.spec.ts";

describeDb("tenant unit backfill (U-6)", () => {
  let pool: Pool;
  let prisma: PrismaClient;
  let url: string;
  const ids: Record<string, string> = {};
  const slug = (k: string) => assertTestTenant(`qa-u6-${RUN}-${k}`, SPEC);

  const cli = (tenantId: string, ...extra: string[]) =>
    spawnSync(process.execPath, [CLI, "--local", "--tenant", tenantId, ...extra], {
      env: { ...process.env, DATABASE_URL: url, PROTECTED_TENANT_SLUGS: "" },
      encoding: "utf8",
    });

  /** A product with levels [label, factor] (factor 1 = the base row). */
  async function product(tenantId: string, tag: string, unit: string, levels: [string, number][]) {
    const p = await prisma.product.create({
      data: { tenantId, name: `u6 ${tag}`, unit, pricePerUnit: 10 },
    });
    const out: Record<string, string> = {};
    for (const [label, factorToBase] of levels) {
      out[label] = (
        await prisma.productUnit.create({
          data: { tenantId, productId: p.id, label, factorToBase },
        })
      ).id;
    }
    return { id: p.id, units: out };
  }

  const snapshot = async (tenantId: string) =>
    JSON.stringify([
      await prisma.productUnit.findMany({ where: { tenantId }, orderBy: { id: "asc" } }),
      await prisma.product.findMany({ where: { tenantId }, orderBy: { id: "asc" } }),
      await prisma.tenantUnit.findMany({ where: { tenantId }, orderBy: { nameKey: "asc" } }),
    ]);
  const products = (tenantId: string) =>
    prisma.product.findMany({ where: { tenantId }, orderBy: { id: "asc" } }).then(JSON.stringify);

  beforeAll(async () => {
    url = requireLocalDatabaseUrl();
    pool = new Pool({ connectionString: url });
    prisma = new PrismaClient({ adapter: new PrismaPg(pool) });
    for (const k of ["a", "ctl", "p", "edit", "arch", "pk"]) {
      ids[k] = (await prisma.tenant.create({ data: { slug: slug(k), name: `u6 ${k}` } })).id;
    }
    // Tenant A: casing "Case" wins 2:1, a synonym level, a too-long level, legacy words.
    await product(ids.a, "1", "Case", [
      ["Piece", 1],
      ["Case", 12],
      ["Pallet", 48],
    ]);
    await product(ids.a, "2", "case", [
      ["Case", 6],
      ["piece", 1],
    ]);
    await product(ids.a, "3", "Tray", [["x".repeat(31), 4]]);
    // Ladder 1 / 6 / 24 / 36 plus a level 25 that names 6 as its parent: non-divisible -> skipped.
    const ladder = await product(ids.a, "4", "Crate", [
      ["Each", 1],
      ["Six", 6],
      ["Box", 24],
      ["Bale", 36],
    ]);
    await prisma.productUnit.create({
      data: {
        tenantId: ids.a,
        productId: ladder.id,
        label: "Odd",
        factorToBase: 25,
        parentUnitId: ladder.units.Six,
      },
    });
    await prisma.product.update({ where: { id: ladder.id }, data: { packLabel: "Carton" } });
    await product(ids.ctl, "c", "Bundle", [["Bundle", 10]]);
    // Protected: Stripe-linked (no plan), so the "stripe-linked" arm protects it.
    await product(ids.p, "p", "Bin", [["Bin", 8]]);
    await prisma.tenantSubscription.create({
      data: { tenantId: ids.p, stripeSubId: `sub_qa_${RUN}`, basePriceSnapshot: 0, discount: 0 },
    });
  });

  afterAll(async () => {
    const all = Object.values(ids);
    await prisma?.tenantSubscription.deleteMany({ where: { tenantId: { in: all } } });
    await prisma?.productUnit.updateMany({
      where: { tenantId: { in: all } },
      data: { parentUnitId: null },
    });
    await prisma?.productUnit.deleteMany({ where: { tenantId: { in: all } } });
    await prisma?.product.deleteMany({ where: { tenantId: { in: all } } });
    await prisma?.tenantUnit.deleteMany({ where: { tenantId: { in: all } } });
    await prisma?.tenant.deleteMany({ where: { id: { in: all } } });
    await prisma?.$disconnect();
    await pool?.end();
  });

  it("a dry run writes nothing: Product byte-identical, no unit, no link, no parent", async () => {
    const before = await snapshot(ids.a);
    const r = cli(ids.a);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("MODE: dry-run");
    expect(r.stdout).toContain("Would apply");
    expect(await snapshot(ids.a)).toBe(before);
  });

  it("--apply creates, links and fills parents; never writes a Product (M1); control untouched", async () => {
    const productsBefore = await products(ids.a);
    const ctlBefore = await snapshot(ids.ctl);
    const r = cli(ids.a, "--apply");
    expect(r.status).toBe(0);
    // keys: case, pallet, tray, crate, six, box, bale, odd (x31 too long; piece/each synonyms)
    expect(r.stdout).toContain("tenantUnits created=8 existing=0");
    expect(r.stdout).toContain("skipped tooLong=1 synonyms=2 parent=1");
    expect(r.stdout).toContain("parent not filled for 1 level(s)");
    // Odd names "Six" (not a factor-1 row) as its parent: no explicit-Piece line for tenant A
    expect(r.stdout).not.toContain("parent is an explicit Piece row");
    expect(r.stdout).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}/);
    expect(r.stdout).not.toContain(slug("a"));

    expect(await products(ids.a)).toBe(productsBefore); // M1: no Product column written
    expect(await snapshot(ids.ctl)).toBe(ctlBefore);

    const units = await prisma.tenantUnit.findMany({ where: { tenantId: ids.a } });
    expect(units.find((u) => u.nameKey === "case")?.name).toBe("Case");
    const linked = await prisma.productUnit.findMany({
      where: { tenantId: ids.a, tenantUnitId: { not: null } },
      include: { tenantUnit: true },
    });
    for (const l of linked) expect(l.tenantUnit?.nameKey).toBe(l.label.trim().toLowerCase());
  });

  it("parent = the largest dividing lower level; a non-divisible level is skipped (M2)", async () => {
    const levels = await prisma.productUnit.findMany({ where: { tenantId: ids.a } });
    const by = (label: string) => levels.find((l) => l.label === label)!;
    // a factor-1 ROW is never a parent: Six sits on the base (NULL), not on the "Each" row (SA-728)
    expect(by("Six")).toMatchObject({ parentUnitId: null, perParent: 6 });
    expect(by("Box")).toMatchObject({ parentUnitId: by("Six").id, perParent: 4 });
    expect(by("Bale")).toMatchObject({ parentUnitId: by("Six").id, perParent: 6 });
    expect(by("Odd")).toMatchObject({ parentUnitId: by("Six").id, perParent: null });
    // product 1: Case 12 -> the base (NULL, not the Piece row), Pallet 48 -> Case 12 (x4)
    const case12 = levels.find((l) => l.label === "Case" && l.factorToBase === 12)!;
    expect(case12).toMatchObject({ parentUnitId: null, perParent: 12 });
    expect(levels.find((l) => l.label === "Pallet")).toMatchObject({
      parentUnitId: case12.id,
      perParent: 4,
    });
    // a level with no lower level: the parent is the implicit base piece
    expect(levels.find((l) => l.factorToBase === 4)).toMatchObject({
      parentUnitId: null,
      perParent: 4,
    });
    // base rows get nothing
    for (const b of levels.filter((l) => l.factorToBase === 1)) expect(b.perParent).toBeNull();
  });

  it("the PACK is a lower level: upb 12 / Case 48 -> perParent 4; upb 1 / Case 12 -> 12, base", async () => {
    const t = ids.pk;
    const packed = await product(t, "k1", "Box", [["Case", 48]]);
    await prisma.product.update({ where: { id: packed.id }, data: { unitsPerBox: 12 } });
    const loose = await product(t, "k2", "Box", [["Case", 12]]);
    await prisma.product.update({ where: { id: loose.id }, data: { unitsPerBox: 1 } });
    const productsBefore = await products(t);
    const r = cli(t, "--apply");
    expect(r.status).toBe(0);
    expect(await prisma.productUnit.findUnique({ where: { id: packed.units.Case } })).toMatchObject(
      {
        parentUnitId: null,
        perParent: 4, // "4 Box = 1 Case"
      },
    );
    expect(await prisma.productUnit.findUnique({ where: { id: loose.units.Case } })).toMatchObject({
      parentUnitId: null,
      perParent: 12, // no pack: the base
    });
    expect(await products(t)).toBe(productsBefore); // still no Product write
  });

  it("an existing parent on an explicit Piece row is left, counted and listed, dry run and apply", async () => {
    const t = ids.pk;
    const p = await product(t, "k3", "Box", [["Piece", 1]]);
    const piece = p.units.Piece;
    const tub = await prisma.productUnit.create({
      data: { tenantId: t, productId: p.id, label: "Tub", factorToBase: 10, parentUnitId: piece },
    });
    for (const extra of [[], ["--apply"]]) {
      const r = cli(t, ...extra);
      expect(r.status).toBe(0);
      expect(r.stdout).toContain("parent is an explicit Piece row: 1");
      expect(r.stdout).toContain("  Tub: 1");
    }
    // fill-only: the pointer stays, perParent is filled (10 / 1)
    expect(await prisma.productUnit.findUnique({ where: { id: tub.id } })).toMatchObject({
      parentUnitId: piece,
      perParent: 10,
    });
  });

  it("a second --apply changes nothing (idempotent)", async () => {
    const before = await snapshot(ids.a);
    const r = cli(ids.a, "--apply");
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("tenantUnits created=0 existing=8");
    expect(r.stdout).toContain("productUnits linked=0 parentFilled=0");
    expect(await snapshot(ids.a)).toBe(before);
  });

  it("a protected tenant is refused --apply without the override, and nothing is written (M3)", async () => {
    const before = await snapshot(ids.p);
    const refused = cli(ids.p, "--apply");
    expect(refused.status).toBe(1);
    expect(refused.stderr).toContain("override refused");
    expect(refused.stderr).not.toContain(slug("p"));
    expect(await snapshot(ids.p)).toBe(before);
    // naming it without a terminal still refuses: the typed phrase has no argv form
    const noTty = cli(ids.p, "--apply", "--allow-protected", ids.p, "--backup-taken");
    expect(noTty.status).toBe(1);
    expect(noTty.stderr).toContain("real terminal");
    expect(await snapshot(ids.p)).toBe(before);
    // a dry run reads a protected tenant freely
    expect(cli(ids.p).status).toBe(0);
  });

  it("an edit between plan and apply on real PG is skipped and reported, never overwritten", async () => {
    const t = ids.edit;
    const a = await product(t, "e1", "Bin", [["Bin", 6]]);
    const b = await product(t, "e2", "Bin", [["Bin", 6]]);
    const read = async () => {
      const [productUnits, prods, existingUnits] = await Promise.all([
        prisma.productUnit.findMany({ where: { tenantId: t } }),
        prisma.product.findMany({ where: { tenantId: t }, select: { id: true, unit: true } }),
        prisma.tenantUnit.findMany({ where: { tenantId: t } }),
      ]);
      return { productUnits, products: prods, existingUnits };
    };
    const snap = await read();
    const plan = planTenantUnits(snap);
    expect(plan.links).toHaveLength(2);
    expect(plan.parentFills).toHaveLength(2);
    // The operator edits between plan and apply: renames one level, sets the other's chain by hand.
    await prisma.productUnit.update({ where: { id: a.units.Bin }, data: { label: "Tub" } });
    await prisma.productUnit.update({ where: { id: b.units.Bin }, data: { perParent: 3 } });
    const r = await applyTenantUnitsPlan({
      prisma,
      tenantId: t,
      plan,
      productIdByUnit: new Map(
        snap.productUnits.map((u: { id: string; productId: string }) => [u.id, u.productId]),
      ),
      batchSize: 1,
    });
    expect(r).toMatchObject({ linked: 1, linksChanged: 1, parentFilled: 1, parentsChanged: 1 });
    const [ua, ub] = await Promise.all([
      prisma.productUnit.findUnique({ where: { id: a.units.Bin } }),
      prisma.productUnit.findUnique({ where: { id: b.units.Bin } }),
    ]);
    expect(ua).toMatchObject({ label: "Tub", tenantUnitId: null, perParent: 6 });
    expect(ub?.perParent).toBe(3); // the hand-set chain stands
    expect(ub?.tenantUnitId).not.toBeNull();
  });

  it("links to an ARCHIVED unit (no second unit) and reports it, in dry run and apply", async () => {
    const t = ids.arch;
    const archived = await prisma.tenantUnit.create({
      data: { tenantId: t, name: "Bin", nameKey: "bin", archivedAt: new Date() },
    });
    await product(t, "d1", "Bin", [
      ["bin", 2],
      ["BIN ", 6],
    ]);
    const line = 'linked to archived unit "Bin" — restore in Settings: 2 product level(s)';
    const dry = cli(t);
    expect(dry.status).toBe(0);
    expect(dry.stdout).toContain("tenantUnits created=0 existing=1");
    expect(dry.stdout).toContain(line);
    expect(dry.stdout).not.toContain(archived.id);
    const applied = cli(t, "--apply");
    expect(applied.status).toBe(0);
    expect(await prisma.tenantUnit.count({ where: { tenantId: t } })).toBe(1);
    const levels = await prisma.productUnit.findMany({ where: { tenantId: t } });
    expect(levels.every((l) => l.tenantUnitId === archived.id)).toBe(true);
    expect(
      (await prisma.tenantUnit.findUnique({ where: { id: archived.id } }))?.archivedAt,
    ).not.toBeNull();
  });
});
