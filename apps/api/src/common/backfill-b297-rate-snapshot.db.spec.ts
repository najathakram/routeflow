/**
 * B297 PR6 (SA-734r2 D3 / L2 / MED-2) — the provable rate-snapshot backfill against a REAL Postgres, run
 * end to end through the CLI: dry-run writes nothing and counts matched / left; --apply on a test tenant
 * writes the category + trio ONLY where the stored amount proves it; a mismatched or disagreeing line is
 * untouched; every gate (plan hash, backup attestation, fingerprint, changed-since-dry-run) refuses with
 * nothing written. The decisions themselves are pinned without a database in
 * `backfill-b297-rate-snapshot-script.spec.ts` (including a line with no derivable tenant: the schema's
 * `OrderItem_tenantId_nn` check refuses to create one here, so legacy NULL-tenant rows are pinned there).
 *
 * Collected only by `jest.db.config.js` (`.db.spec.ts$`); `requireLocalDatabaseUrl()` refuses any non-local
 * host. The tenant is a throwaway `qa-b297bf-<run>` slug approved by `assertTestTenant`; the script scans
 * the WHOLE database, so run this against a database holding no other tenant's lines (the DB lane's
 * throwaway `rf_dbspec_*` databases). `afterAll` deletes exactly the rows this run created.
 */
import { execFileSync, spawnSync } from "child_process";
import { randomUUID } from "crypto";
import * as path from "path";
import { PrismaClient } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import { Pool } from "pg";
import { describeDb, requireLocalDatabaseUrl } from "./testing/db-spec";

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { assertTestTenant } = require("../../../../scripts/lib/test-tenants.cjs");

const API_DIR = path.resolve(__dirname, "../..");
const SCRIPT = path.resolve(API_DIR, "scripts/backfill-b297-rate-snapshot.mjs");

describeDb("B297 PR6 backfill — provable rate snapshot, real Postgres", () => {
  let pool: Pool;
  let raw: PrismaClient;
  const run = randomUUID().slice(0, 8);
  const slug = assertTestTenant(`qa-b297bf-${run}`, "backfill-b297-rate-snapshot.db.spec.ts");
  let tenantId = "";
  let customerId = "";
  let categoryId = "";
  let productId = "";
  let orderId = "";
  const ids: Record<string, string> = {};
  const url = () => requireLocalDatabaseUrl();

  const cli = (args: string[]) => {
    const env: NodeJS.ProcessEnv = { ...process.env, DATABASE_URL: url() };
    for (const k of Object.keys(env)) if (k.startsWith("RAILWAY_")) delete env[k];
    delete env.PROTECTED_TENANT_SLUGS;
    const res = spawnSync(process.execPath, [SCRIPT, ...args], { encoding: "utf8", env });
    return { status: res.status, out: `${res.stdout}\n${res.stderr}` };
  };
  const planOf = (out: string) => ({
    file: /plan: (.+)/.exec(out)![1].trim(),
    hash: /plan hash: ([0-9a-f]{64})/.exec(out)![1],
  });
  const head = execFileSync("git", ["rev-parse", "HEAD"], {
    cwd: API_DIR,
    encoding: "utf8",
  }).trim();
  const applyArgs = (p: { file: string; hash: string }, extra: string[] = []) => [
    "--apply",
    "--local",
    "--plan",
    p.file,
    "--confirm-plan",
    p.hash,
    "--guard-sha",
    head,
    ...extra,
  ];

  const orderLine = (over: Record<string, unknown>) =>
    raw.orderItem.create({
      data: {
        orderId,
        tenantId,
        productId,
        qty: 12,
        unitPrice: "1.00",
        subtotal: "12.00",
        status: "PENDING",
        priceType: "STANDARD",
        ...over,
      } as never,
    });
  let invoiceId = "";
  const invoiceLine = (over: Record<string, unknown>) =>
    raw.invoiceItem.create({
      data: {
        invoiceId,
        tenantId,
        productId,
        description: "Cigar",
        qty: 12,
        unitPrice: "1.00",
        subtotal: "12.00",
        ...over,
      } as never,
    });
  const TRIO = {
    trackedCategoryId: "", // set in beforeAll
    categoryTaxType: "EXCISE_PER_UNIT",
    categoryTaxRate: "0.0500",
    categoryPriceIncludesTax: false,
  };

  beforeAll(async () => {
    const pool0 = new Pool({ connectionString: url() });
    pool = pool0;
    raw = new PrismaClient({ adapter: new PrismaPg(pool0) });
    tenantId = (await raw.tenant.create({ data: { slug, name: `B297bf ${slug}` } })).id;
    const user = await raw.user.create({
      data: { email: `bf-${run}@example.test`, username: `bf-${run}`, role: "CUSTOMER", tenantId },
    });
    customerId = (
      await raw.customer.create({
        data: { userId: user.id, businessName: "Acme Retail", contactName: "Tester", tenantId },
      })
    ).id;
    categoryId = (
      await raw.trackedCategory.create({
        data: { tenantId, name: `Excise ${run}`, taxType: "EXCISE_PER_UNIT", rate: 0.05 },
      })
    ).id;
    TRIO.trackedCategoryId = categoryId;
    productId = (
      await raw.product.create({
        data: {
          name: `Cigar ${run}`,
          unit: "each",
          pricePerUnit: "1.00",
          currentStock: 100,
          trackedCategoryId: categoryId,
          tenantId,
        },
      })
    ).id;
    orderId = (
      await raw.order.create({
        data: { customerId, status: "PENDING", subtotal: "100.00", total: "100.00", tenantId },
      })
    ).id;
    invoiceId = (
      await raw.invoice.create({
        data: {
          invoiceNumber: `INV-BF-${run}`,
          customerId,
          orderId,
          status: "SENT",
          subtotal: "100.00",
          total: "100.00",
          tenantId,
        },
      })
    ).id;

    // TRIO: proven (12 x 0.05 = 0.60) / left (0.99 does not reproduce it).
    ids.trioProven = (
      await orderLine({
        trackedCategoryId: categoryId,
        categoryTaxAmount: "0.60",
        categoryTaxType: null,
        categoryTaxRate: null,
        categoryPriceIncludesTax: null,
      })
    ).id;
    ids.trioLeft = (
      await orderLine({ trackedCategoryId: categoryId, categoryTaxAmount: "0.99" })
    ).id;
    // L2-ORDER: no category, 84 x 0.05 = 4.20, one invoice line carrying the full trio and agreeing.
    ids.l2Order = (await orderLine({ qty: 84, subtotal: "84.00", categoryTaxAmount: "4.20" })).id;
    await invoiceLine({
      orderItemId: ids.l2Order,
      qty: 84,
      subtotal: "84.00",
      categoryTaxAmount: "4.20",
      ...TRIO,
    });
    // L2-ORDER left: two invoice lines that disagree on the rate.
    ids.l2Disagree = (await orderLine({ categoryTaxAmount: "0.60" })).id;
    await invoiceLine({ orderItemId: ids.l2Disagree, categoryTaxAmount: "0.60", ...TRIO });
    await invoiceLine({
      orderItemId: ids.l2Disagree,
      categoryTaxAmount: "0.60",
      ...TRIO,
      categoryTaxRate: "0.0700",
    });
    // L2-INVOICE: an invoice line with no category whose order line carries the full trio.
    ids.twinOrder = (
      await orderLine({ qty: 24, subtotal: "24.00", categoryTaxAmount: "1.20", ...TRIO })
    ).id;
    ids.l2Invoice = (
      await invoiceLine({
        orderItemId: ids.twinOrder,
        qty: 24,
        subtotal: "24.00",
        categoryTaxAmount: "1.20",
      })
    ).id;
  }, 120_000);

  afterAll(async () => {
    if (raw) {
      await raw.invoiceItem.deleteMany({ where: { tenantId } });
      await raw.invoice.deleteMany({ where: { tenantId } });
      await raw.orderItem.deleteMany({ where: { tenantId } });
      await raw.order.deleteMany({ where: { tenantId } });
      await raw.product.deleteMany({ where: { tenantId } });
      await raw.trackedCategory.deleteMany({ where: { tenantId } });
      await raw.customer.deleteMany({ where: { tenantId } });
      await raw.user.deleteMany({ where: { tenantId } });
      await raw.tenant.deleteMany({ where: { id: tenantId } });
      await raw.$disconnect();
    }
    await pool?.end();
  });

  const state = async () => ({
    trioProven: await raw.orderItem.findUniqueOrThrow({ where: { id: ids.trioProven } }),
    trioLeft: await raw.orderItem.findUniqueOrThrow({ where: { id: ids.trioLeft } }),
    l2Order: await raw.orderItem.findUniqueOrThrow({ where: { id: ids.l2Order } }),
    l2Disagree: await raw.orderItem.findUniqueOrThrow({ where: { id: ids.l2Disagree } }),
    l2Invoice: await raw.invoiceItem.findUniqueOrThrow({ where: { id: ids.l2Invoice } }),
  });

  it("dry-run writes nothing; --apply writes the category + trio only where the amount proves it", async () => {
    const before = await state();
    const dry = cli(["--local"]);
    expect(dry.status).toBe(0);
    expect(dry.out).toMatch(/APPLY: 3 line\(s\)/);
    expect(dry.out).toMatch(/LEFT:\s+2 line\(s\)/);
    expect(JSON.stringify(await state())).toBe(JSON.stringify(before)); // nothing written

    // Gates: a wrong hash and a missing backup attestation each refuse with nothing written.
    const plan = planOf(dry.out);
    expect(
      cli(applyArgs({ ...plan, hash: "0".repeat(64) }, ["--i-have-a-fresh-backup"])).status,
    ).toBe(1);
    expect(cli(applyArgs(plan)).status).toBe(1);
    expect(JSON.stringify(await state())).toBe(JSON.stringify(before));

    const applied = cli(applyArgs(plan, ["--i-have-a-fresh-backup"]));
    expect(applied.out).toMatch(/committed — 3 line\(s\)/);
    expect(applied.status).toBe(0);

    const after = await state();
    // TRIO: stamped at the category's current values; the amount is exactly as before.
    expect(after.trioProven).toMatchObject({
      trackedCategoryId: categoryId,
      categoryTaxType: "EXCISE_PER_UNIT",
      categoryPriceIncludesTax: false,
    });
    expect(Number(after.trioProven.categoryTaxRate)).toBe(0.05);
    expect(Number(after.trioProven.categoryTaxAmount)).toBe(0.6);
    // L2-ORDER: category + trio copied from the agreeing invoice line, amount untouched.
    expect(after.l2Order.trackedCategoryId).toBe(categoryId);
    expect(Number(after.l2Order.categoryTaxRate)).toBe(0.05);
    expect(Number(after.l2Order.categoryTaxAmount)).toBe(4.2);
    // L2-INVOICE (MED-2): the twin copied from its order line.
    expect(after.l2Invoice.trackedCategoryId).toBe(categoryId);
    expect(Number(after.l2Invoice.categoryTaxAmount)).toBe(1.2);
    // Left alone: the mismatch and the disagreeing sources.
    expect(after.trioLeft.categoryTaxType).toBeNull();
    expect(Number(after.trioLeft.categoryTaxAmount)).toBe(0.99);
    expect(after.l2Disagree.trackedCategoryId).toBeNull();
  }, 180_000);

  it("a second run finds nothing left to prove, and a stale plan is refused changed-since-dry-run", async () => {
    const second = cli(["--local"]);
    expect(second.out).toMatch(/APPLY: 0 line\(s\)/);

    // A plan built now, then a line moves before the apply: the re-read refuses the WHOLE apply.
    await raw.orderItem.update({
      where: { id: ids.trioLeft },
      data: { categoryTaxAmount: "0.60" },
    });
    const dry = cli(["--local"]);
    expect(dry.out).toMatch(/APPLY: 1 line\(s\)/);
    const plan = planOf(dry.out);
    await raw.orderItem.update({
      where: { id: ids.trioLeft },
      data: { categoryTaxAmount: "0.61" },
    });
    const stale = cli(applyArgs(plan, ["--i-have-a-fresh-backup"]));
    expect(stale.status).toBe(1);
    expect(stale.out).toMatch(/changed since the dry run -- nothing was written/);
    const row = await raw.orderItem.findUniqueOrThrow({ where: { id: ids.trioLeft } });
    expect(row.categoryTaxType).toBeNull();
  }, 180_000);
});
