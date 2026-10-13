/**
 * labels-from-categories (SA-approved backfill) against a REAL Postgres, end to end through the CLI: the dry run
 * writes nothing; --live on a test tenant creates the labels (case variants merged and listed, existing labels
 * reused, archived ones skipped) and adds INCLUDE memberships through the single writer, never touching
 * Product.category or an opt-out; a re-run plans 0; an --expect-rows mismatch, a protected tenant and a live
 * tenant without its override are refused with nothing written.
 *
 * The CLI loads the single writer from the compiled API; here the one file is compiled into a temp dir and
 * passed through the TEST-ONLY `LABELS_WRITER_MODULE` (honoured only inside a Jest worker).
 * Collected only by `jest.db.config.js`; `requireLocalDatabaseUrl()` refuses any non-local host. Run it on a
 * throwaway database (the DB lane's `rf_dbspec_*`). `afterAll` deletes exactly the rows this run created.
 */
import { execFileSync, spawnSync } from "child_process";
import { randomUUID } from "crypto";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { PrismaClient } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import { Pool } from "pg";
import { describeDb, requireLocalDatabaseUrl } from "../common/testing/db-spec";

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { assertTestTenant } = require("../../../../scripts/lib/test-tenants.cjs");

const API_DIR = path.resolve(__dirname, "../..");
const SCRIPT = path.resolve(API_DIR, "scripts/labels-from-categories.mjs");

describeDb("labels-from-categories — real Postgres, through the CLI", () => {
  const run = randomUUID().slice(0, 8);
  const slug = assertTestTenant(`qa-lfc-${run}`, "labels-from-categories.db.spec.ts");
  let pool: Pool;
  let raw: PrismaClient;
  let writerJs = "";
  let tmp = "";
  const tenants: string[] = [];
  let tenantId = "";
  const ids: Record<string, string> = {};
  const url = () => requireLocalDatabaseUrl();

  const cli = (args: string[]) => {
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      DATABASE_URL: url(),
      LABELS_WRITER_MODULE: writerJs,
    };
    for (const k of Object.keys(env)) if (k.startsWith("RAILWAY_")) delete env[k];
    delete env.PROTECTED_TENANT_SLUGS;
    const res = spawnSync(process.execPath, [SCRIPT, "--local", ...args], {
      encoding: "utf8",
      env,
      cwd: path.resolve(API_DIR, "../.."),
    });
    return { status: res.status, out: `${res.stdout}\n${res.stderr}` };
  };
  const rowsOf = (out: string) => Number(/rows to write: (\d+)/.exec(out)?.[1]);

  const product = async (
    name: string,
    category: string | null,
    over: Record<string, unknown> = {},
  ) =>
    (
      await raw.product.create({
        data: {
          name: `${name} ${run}`,
          unit: "each",
          pricePerUnit: "1.00",
          category,
          tenantId,
          ...over,
        } as never,
      })
    ).id;

  /** Everything the run could change, for "nothing was written" checks. */
  const snapshot = async (tid = tenantId) =>
    JSON.stringify({
      labels: await raw.productCategory.findMany({
        where: { tenantId: tid },
        orderBy: { id: "asc" },
      }),
      memberships: await raw.productCategoryLabel.findMany({
        where: { tenantId: tid },
        orderBy: { id: "asc" },
      }),
      texts: await raw.product.findMany({
        where: { tenantId: tid },
        select: { id: true, category: true },
        orderBy: { id: "asc" },
      }),
    });

  beforeAll(async () => {
    // Compile ONLY the single writer (the CLI's dist dependency) into a temp dir.
    // Inside apps/api (gitignored node_modules cache) so the compiled writer resolves @nestjs/common & co.
    const cacheDir = path.resolve(API_DIR, "node_modules/.cache");
    fs.mkdirSync(cacheDir, { recursive: true });
    tmp = fs.mkdtempSync(path.join(cacheDir, "lfc-writer-"));
    execFileSync(
      process.execPath,
      [
        require.resolve("typescript/bin/tsc"),
        "--outDir",
        tmp,
        "--module",
        "commonjs",
        "--target",
        "es2021",
        "--esModuleInterop",
        "--skipLibCheck",
        "--experimentalDecorators",
        "--emitDecoratorMetadata",
        "--rootDir",
        path.resolve(API_DIR, "src"),
        path.resolve(API_DIR, "src/product-categories/label-writer.ts"),
        path.resolve(API_DIR, "src/product-labels/parent-carries.ts"),
      ],
      { cwd: API_DIR, stdio: "pipe" },
    );
    writerJs = path.join(tmp, "product-categories", "label-writer.js");

    pool = new Pool({ connectionString: url() });
    raw = new PrismaClient({ adapter: new PrismaPg(pool) });
    tenantId = (await raw.tenant.create({ data: { slug, name: `LFC ${slug}` } })).id;
    tenants.push(tenantId);

    // Texts: "Snacks" most common (2) vs "snacks" and "SNACKS" -> one label "Snacks", variants listed.
    ids.s1 = await product("Chips", "Snacks");
    ids.s2 = await product("Pretzels", "  Snacks ");
    ids.s3 = await product("Nuts", "snacks");
    ids.s4 = await product("Popcorn", "SNACKS");
    // Whitespace collapses: "Frozen  Foods" and "frozen foods" -> one label.
    ids.f1 = await product("Peas", "Frozen  Foods");
    ids.f2 = await product("Corn", "frozen foods");
    // An EXISTING label "drinks" is reused (not duplicated), its name kept.
    ids.drinks = (await raw.productCategory.create({ data: { tenantId, name: "drinks" } })).id;
    ids.d1 = await product("Cola", "Drinks");
    // A variant whose parent carries "drinks" and which OPTED OUT of it: never flipped.
    ids.dParent = await product("Juice", "Drinks");
    await raw.productCategoryLabel.create({
      data: { tenantId, productId: ids.dParent, categoryId: ids.drinks, mode: "INCLUDE" },
    });
    ids.dVariant = await product("Juice Small", "Drinks", { parentProductId: ids.dParent });
    await raw.productCategoryLabel.create({
      data: {
        tenantId,
        productId: ids.dVariant,
        categoryId: ids.drinks,
        mode: "EXCLUDE",
        reason: "test opt-out",
        parentProductIdAtWrite: ids.dParent,
      },
    });
    // An ARCHIVED existing label matching a text: listed, skipped, never unarchived.
    ids.candy = (
      await raw.productCategory.create({
        data: { tenantId, name: "Candy", archivedAt: new Date() },
      })
    ).id;
    ids.c1 = await product("Gummies", "candy");
    // Variants FOLLOW the parent: a family "Tea" parent + two variants with the same text -> only the parent's row.
    ids.teaParent = await product("Tea Family", "Tea");
    ids.teaV1 = await product("Tea Small", "tea", { parentProductId: ids.teaParent });
    ids.teaV2 = await product("Tea Large", "Tea", { parentProductId: ids.teaParent });
    // A deliberate removal (the admin remove-label audit) is never re-added.
    ids.d2 = await product("Lemonade", "Drinks");
    await raw.auditLog.create({
      data: {
        tenantId,
        action: "product_label.removed",
        entityType: "Product",
        entityId: ids.d2,
        meta: { categoryId: ids.drinks },
      },
    });
    // A parent's deliberate removal covers its family: "Punch" had drinks removed on purpose; its variant gets none.
    ids.punch = await product("Punch", "Drinks");
    await raw.auditLog.create({
      data: {
        tenantId,
        action: "product_label.removed",
        entityType: "Product",
        entityId: ids.punch,
        meta: { categoryId: ids.drinks, mode: "INCLUDE" },
      },
    });
    ids.punchV = await product("Punch Small", "Drinks", { parentProductId: ids.punch });
    // A formula-like text can't be a label name (B983): listed, skipped.
    ids.u1 = await product("Odd", "=HYPERLINK(1)");
    // Blank and missing text: no label.
    ids.b1 = await product("Thing", "   ");
    ids.b2 = await product("Other", null);
  }, 180_000);

  afterAll(async () => {
    if (raw) {
      for (const tid of tenants) {
        await raw.auditLog.deleteMany({ where: { tenantId: tid } });
        await raw.productCategoryLabel.deleteMany({ where: { tenantId: tid } });
        await raw.product.updateMany({ where: { tenantId: tid }, data: { parentProductId: null } });
        await raw.product.deleteMany({ where: { tenantId: tid } });
        await raw.productCategory.deleteMany({ where: { tenantId: tid } });
        await raw.tenantSubscription.deleteMany({ where: { tenantId: tid } });
        await raw.tenant.deleteMany({ where: { id: tid } });
      }
      await raw.$disconnect();
    }
    await pool?.end();
    if (tmp) fs.rmSync(tmp, { recursive: true, force: true });
  });

  it("the dry run writes nothing, merges case variants and LISTS them, lists the archived match", async () => {
    const before = await snapshot();
    const dry = cli(["--tenant", tenantId]);
    expect(dry.status).toBe(0);
    expect(dry.out).toMatch(/DRY-RUN/);
    expect(await snapshot()).toBe(before);
    // labels: Snacks (new), Frozen Foods (new), drinks (reused); Candy archived -> skipped
    expect(dry.out).toMatch(/labels: 4 \(new: 3, reusing existing: 1\)/);
    expect(dry.out).toMatch(/\+ Snacks \(4, 4\)/);
    expect(dry.out).toMatch(/\+ Frozen Foods \(2, 2\)/);
    expect(dry.out).toMatch(/= drinks \(6, 1\)/); // Cola added; Juice in; its variant opted out; Lemonade + Punch removed; Punch Small: parent removed
    // variants FOLLOW the parent: Tea gets ONE row (the family parent), its two variants none
    expect(dry.out).toMatch(/\+ Tea \(3, 1\)/);
    expect(dry.out).toMatch(
      /FOLLOW their parent's label \(no own row\): 2; deliberate removals kept removed: 2/,
    );
    expect(dry.out).toMatch(/removed on purpose by an operator, NOT re-added:\s+drinks \(2\)/);
    expect(dry.out).toMatch(
      /parent removed \(the parent's label was removed on purpose; its variants stay without it\):\s+drinks \(1\)/,
    );
    expect(dry.out).toMatch(/can't be a label name[\s\S]*\[unsafe\] =HYPERLINK\(1\) \(1\)/);
    expect(dry.out).toMatch(/re-run: a re-run plans only what is left/);
    expect(dry.out).toMatch(/owner checklist \(not enforced by code\)/);
    expect(dry.out).toMatch(/Snacks <- SNACKS \| Snacks \| snacks/);
    expect(dry.out).toMatch(/ARCHIVED label, skipped[\s\S]*Candy \(1\)/);
    expect(dry.out).toMatch(/blank: 1/);
    expect(dry.out).toMatch(/opted out, left as is: 1/);
    // 3 new labels + 4 (Snacks) + 2 (Frozen Foods) + 1 (drinks) + 1 (Tea parent) memberships
    expect(rowsOf(dry.out)).toBe(11);
    // the slug is never printed
    expect(dry.out).not.toContain(slug);
  }, 120_000);

  it("--live adds through the single writer; Product.category, the opt-out and the archived label are untouched", async () => {
    const textsBefore = await raw.product.findMany({
      where: { tenantId },
      select: { id: true, category: true },
      orderBy: { id: "asc" },
    });
    const res = cli(["--tenant", tenantId, "--live", "--backup-taken", "--expect-rows", "11"]);
    expect(res.out).toMatch(/committed — 3 label\(s\) created, 8 membership\(s\) added/);
    expect(res.status).toBe(0);

    const labels = await raw.productCategory.findMany({
      where: { tenantId },
      orderBy: { name: "asc" },
    });
    expect(labels.map((l) => l.name).sort()).toEqual([
      "Candy",
      "Frozen Foods",
      "Snacks",
      "Tea",
      "drinks",
    ]);
    const tea = labels.find((l) => l.name === "Tea")!;
    const snacks = labels.find((l) => l.name === "Snacks")!;
    const frozen = labels.find((l) => l.name === "Frozen Foods")!;
    const of = async (productId: string) =>
      raw.productCategoryLabel.findMany({
        where: { productId },
        select: { categoryId: true, mode: true },
      });
    for (const id of [ids.s1, ids.s2, ids.s3, ids.s4])
      expect(await of(id)).toEqual([{ categoryId: snacks.id, mode: "INCLUDE" }]);
    for (const id of [ids.f1, ids.f2])
      expect(await of(id)).toEqual([{ categoryId: frozen.id, mode: "INCLUDE" }]);
    expect(await of(ids.d1)).toEqual([{ categoryId: ids.drinks, mode: "INCLUDE" }]);
    expect(await of(ids.dVariant)).toEqual([{ categoryId: ids.drinks, mode: "EXCLUDE" }]); // never flipped
    expect(await of(ids.c1)).toEqual([]); // archived label skipped
    expect(await of(ids.teaParent)).toEqual([{ categoryId: tea.id, mode: "INCLUDE" }]);
    expect(await of(ids.teaV1)).toEqual([]); // follows its parent
    expect(await of(ids.teaV2)).toEqual([]);
    expect(await of(ids.d2)).toEqual([]); // removed on purpose: not re-added
    expect(await of(ids.punch)).toEqual([]);
    expect(await of(ids.punchV)).toEqual([]); // the parent's removal covers the family
    expect(await of(ids.u1)).toEqual([]); // unsafe text: no label
    expect(await of(ids.b1)).toEqual([]);
    expect(
      (await raw.productCategory.findUnique({ where: { id: ids.candy } }))?.archivedAt,
    ).not.toBeNull();
    const added = await raw.productCategoryLabel.findMany({
      where: { tenantId, productId: { in: [ids.s1, ids.d1] } },
    });
    for (const m of added) expect(m.parentProductIdAtWrite).toBeNull(); // an INCLUDE carries no pin
    // Product.category is never written
    expect(
      await raw.product.findMany({
        where: { tenantId },
        select: { id: true, category: true },
        orderBy: { id: "asc" },
      }),
    ).toEqual(textsBefore);
    expect(
      await raw.auditLog.count({
        where: { tenantId, action: "product_label.backfill_from_category_text" },
      }),
    ).toBe(1);
  }, 180_000);

  it("a re-run plans 0, and an --expect-rows mismatch is refused (exit 3) with nothing written", async () => {
    const again = cli(["--tenant", tenantId]);
    expect(again.status).toBe(0);
    expect(rowsOf(again.out)).toBe(0);
    const before = await snapshot();
    const res = cli(["--tenant", tenantId, "--live", "--backup-taken", "--expect-rows", "5"]);
    expect(res.status).toBe(3);
    expect(res.out).toMatch(/--expect-rows 5 but this run would write 0 -- nothing was written/);
    expect(await snapshot()).toBe(before);
  }, 120_000);

  it("--live without --backup-taken or --expect-rows is refused before any write", async () => {
    const t2 = (await raw.tenant.create({ data: { slug: `qa-lfc2-${run}`, name: "LFC2" } })).id;
    tenants.push(t2);
    await raw.product.create({
      data: {
        name: `X ${run}`,
        unit: "each",
        pricePerUnit: "1.00",
        category: "Tea",
        tenantId: t2,
      } as never,
    });
    const before = await snapshot(t2);
    expect(cli(["--tenant", t2, "--live", "--expect-rows", "2"]).status).toBe(1);
    expect(cli(["--tenant", t2, "--live", "--backup-taken"]).status).toBe(1);
    expect(await snapshot(t2)).toBe(before);
  }, 120_000);

  it("a PROTECTED tenant (Stripe-linked) without the override is refused, nothing written", async () => {
    const t3 = (await raw.tenant.create({ data: { slug: `qa-lfc3-${run}`, name: "LFC3" } })).id;
    tenants.push(t3);
    await raw.tenantSubscription.create({ data: { tenantId: t3, stripeSubId: `sub_qa_${run}` } });
    await raw.product.create({
      data: {
        name: `Y ${run}`,
        unit: "each",
        pricePerUnit: "1.00",
        category: "Tea",
        tenantId: t3,
      } as never,
    });
    const before = await snapshot(t3);
    const res = cli(["--tenant", t3, "--live", "--backup-taken", "--expect-rows", "2"]);
    expect(res.out).toMatch(/is protected: override refused/);
    expect(res.out).toMatch(/nothing was written/);
    expect(res.status).toBe(1);
    expect(await snapshot(t3)).toBe(before);
  }, 120_000);

  it("a LIVE (non-test) tenant without --live-tenant-override is refused, nothing written", async () => {
    // A local throwaway DB: an acme-style non-test slug stands in for a live tenant.
    const t4 = (await raw.tenant.create({ data: { slug: `acme-lfc-${run}`, name: "Acme LFC" } }))
      .id;
    tenants.push(t4);
    await raw.product.create({
      data: {
        name: `Z ${run}`,
        unit: "each",
        pricePerUnit: "1.00",
        category: "Tea",
        tenantId: t4,
      } as never,
    });
    const before = await snapshot(t4);
    const res = cli(["--tenant", t4, "--live", "--backup-taken", "--expect-rows", "2"]);
    expect(res.out).toMatch(/needs --live-tenant-override -- nothing was written/);
    expect(res.status).toBe(1);
    expect(await snapshot(t4)).toBe(before);
    // with the override but no terminal: still refused (the typed phrase needs a real TTY)
    const res2 = cli([
      "--tenant",
      t4,
      "--live",
      "--backup-taken",
      "--expect-rows",
      "2",
      "--live-tenant-override",
    ]);
    expect(res2.out).toMatch(/real terminal/);
    expect(res2.status).toBe(1);
    expect(await snapshot(t4)).toBe(before);
  }, 120_000);
});
