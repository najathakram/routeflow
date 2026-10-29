/**
 * B562 PR-4 — D1 (SA-136 §5): `apps/api/scripts/b562-d1-ledger-gap-backfill.mjs` against real
 * Postgres, run as the owner runs it (a child process, `--local`, scoped to a throwaway tenant).
 *
 * World: an AVCO product bought 100 @ $2 (a PURCHASE row), then a pre-PR-2 order sold 2 boxes of a
 * 12-pack box-unaware — the counter moved by the raw decrement with NO StockMovement (the gap).
 * Under test:
 * - the dry run writes nothing, reports drift −2 with the unseen order and SA-136b's
 *   "box-unaware × (pack − 1)" = 22, and saves a hashed plan;
 * - every gate refuses with exit 1 and writes nothing: no backup flag, a wrong plan hash, a guard
 *   sha that is not an ancestor, and a product that changed since the dry run;
 * - the apply writes ONE SALE row (quantity = drift, unitCost null, `B562:BACKFILL:<hash>`,
 *   effectiveAt = the cutover, stockAfter = the counter), after which `stock-ledger-gap.mjs` exits
 *   0, the replay reports no gap and the average is untouched; a second apply writes nothing.
 *
 * Collected only by `jest.db.config.js`, run via `npm run local:test:db`. `requireLocalDatabaseUrl()`
 * refuses any non-local host. Tenants are throwaway `qa-b562-d1-<run>-<n>-<label>` slugs approved by
 * `assertTestTenant`; `afterAll` deletes exactly the rows this run created, in FK order.
 */
import { spawnSync } from "child_process";
import { randomUUID } from "crypto";
import { mkdtempSync, readFileSync } from "fs";
import { tmpdir } from "os";
import * as path from "path";
import { Prisma, PrismaClient } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import { Pool } from "pg";
import { describeDb, requireLocalDatabaseUrl } from "../common/testing/db-spec";

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { assertTestTenant } = require("../../../../scripts/lib/test-tenants.cjs");

const RUN_SUFFIX = randomUUID().slice(0, 8);
let tenantSeq = 0;
const freshTenantSlug = (label: string): string => {
  tenantSeq += 1;
  return assertTestTenant(
    `qa-b562-d1-${RUN_SUFFIX}-${tenantSeq}-${label}`,
    "b562-d1-backfill.db.spec.ts",
  );
};

const SCRIPTS = path.resolve(__dirname, "../../scripts");
const D1 = path.join(SCRIPTS, "b562-d1-ledger-gap-backfill.mjs");
const GAP = path.join(SCRIPTS, "stock-ledger-gap.mjs");
const REPO = path.resolve(__dirname, "../../../..");
const CUTOVER = "2026-09-24T23:57:31.000Z";
const n = (v: Prisma.Decimal | null | undefined) => (v == null ? null : Number(v));

const run = (script: string, args: string[]) =>
  spawnSync(process.execPath, [script, ...args], {
    env: { ...process.env },
    encoding: "utf8",
    timeout: 60_000,
    cwd: REPO,
  });
const head = () =>
  spawnSync("git", ["-C", REPO, "rev-parse", "HEAD"], { encoding: "utf8" }).stdout.trim();

describeDb("B562 PR-4 D1 ledger-gap backfill — real Postgres", () => {
  let pool: Pool;
  let db: PrismaClient;
  const tenantIds: string[] = [];
  const outDir = mkdtempSync(path.join(tmpdir(), "b562-d1-"));

  beforeAll(async () => {
    const url = requireLocalDatabaseUrl();
    pool = new Pool({ connectionString: url });
    db = new PrismaClient({ adapter: new PrismaPg(pool) });
  });

  afterAll(async () => {
    for (const tenantId of tenantIds) {
      // eslint-disable-next-line no-await-in-loop
      await (async () => {
        await db.orderItem.deleteMany({ where: { order: { tenantId } } });
        await db.order.deleteMany({ where: { tenantId } });
        await db.customer.deleteMany({ where: { tenantId } });
        await db.stockMovement.deleteMany({ where: { tenantId } });
        await db.product.deleteMany({ where: { tenantId } });
        await db.user.deleteMany({ where: { tenantId } });
        await db.tenant.delete({ where: { id: tenantId } });
      })().catch(() => undefined);
    }
    await db?.$disconnect();
    await pool?.end();
  });

  async function seed(label: string) {
    const slug = freshTenantSlug(label);
    const tenant = await db.tenant.create({ data: { slug, name: `B562 D1 ${slug}` } });
    tenantIds.push(tenant.id);
    const buyer = await db.user.create({
      data: {
        email: `${slug}@example.invalid`,
        username: slug,
        role: "CUSTOMER",
        tenantId: tenant.id,
      },
    });
    const customer = await db.customer.create({
      data: {
        userId: buyer.id,
        businessName: `Acme ${slug}`,
        contactName: "Acme Buyer",
        tenantId: tenant.id,
      },
    });
    const product = await db.product.create({
      data: {
        name: `Water 12pk ${slug}`,
        unit: "ea",
        pricePerUnit: 5,
        unitsPerBox: 12,
        currentStock: 100,
        averageCost: 2,
        costingMethod: "AVCO",
        tenantId: tenant.id,
      },
    });
    await db.stockMovement.create({
      data: {
        productId: product.id,
        tenantId: tenant.id,
        type: "PURCHASE",
        quantity: 100,
        unitCost: 2,
        avgCostAfter: 2,
        stockAfter: 100,
        effectiveAt: new Date("2026-09-01T00:00:00Z"),
      },
    });
    // A pre-PR-2 order: 2 boxes, box-unaware (no split, no label, no snapshot). The old code moved
    // the counter by the BOX count (−2) and wrote no movement row — the gap D1 closes.
    await db.order.create({
      data: {
        customerId: customer.id,
        tenantId: tenant.id,
        status: "PENDING",
        lineItems: {
          create: [
            { productId: product.id, qty: 2, unitPrice: 24, subtotal: 48, tenantId: tenant.id },
          ],
        },
      },
    });
    await db.product.update({
      where: { id: product.id },
      data: { currentStock: { decrement: 2 } },
    });
    return { slug, tenantId: tenant.id, productId: product.id };
  }

  function dryRun(slug: string) {
    const res = run(D1, ["--local", "--cutover", CUTOVER, "--tenant", slug, "--out", outDir]);
    expect(res.status).toBe(0);
    const file = /plan: (.+)/.exec(res.stdout)?.[1]?.trim() ?? "";
    const hash = /plan hash: ([0-9a-f]{64})/.exec(res.stdout)?.[1] ?? "";
    return { res, file, hash, plan: JSON.parse(readFileSync(file, "utf8")) };
  }
  const apply = (file: string, hash: string, extra: string[] = []) =>
    run(D1, [
      "--apply",
      "--local",
      "--plan",
      file,
      "--confirm-plan",
      hash,
      "--guard-sha",
      head(),
      "--backup-taken",
      ...extra,
    ]);
  const backfillRows = (productId: string) =>
    db.stockMovement.findMany({
      where: { productId, reference: { startsWith: "B562:BACKFILL:" } },
    });

  it("dry run writes nothing and reports drift, the unseen order and box-unaware × (pack − 1)", async () => {
    const w = await seed("dry");
    const before = await db.stockMovement.count({ where: { productId: w.productId } });
    const { plan } = dryRun(w.slug);
    expect(plan.apply).toEqual([
      expect.objectContaining({ productId: w.productId, quantity: "-2" }),
    ]);
    expect(plan.report).toEqual([
      expect.objectContaining({
        productId: w.productId,
        drift: "-2",
        unseenOrders: 1,
        unseenLineQty: 2,
        ordersWithRevisions: 0,
        boxUnawareUnderDecrement: 22,
      }),
    ]);
    expect(await db.stockMovement.count({ where: { productId: w.productId } })).toBe(before);
    expect(run(GAP, ["--tenant", w.slug]).status).toBe(2);
  });

  it("every gate refuses with exit 1 and writes nothing", async () => {
    const w = await seed("gates");
    const { file, hash } = dryRun(w.slug);
    const noBackup = run(D1, [
      "--apply",
      "--local",
      "--plan",
      file,
      "--confirm-plan",
      hash,
      "--guard-sha",
      head(),
    ]);
    expect(noBackup.status).toBe(1);
    expect(apply(file, "0".repeat(64)).status).toBe(1);
    const badGuard = run(D1, [
      "--apply",
      "--local",
      "--plan",
      file,
      "--confirm-plan",
      hash,
      "--guard-sha",
      "0000000000000000000000000000000000000000",
      "--backup-taken",
    ]);
    expect(badGuard.status).toBe(1);
    // A stock write since the dry run: the re-read refuses the whole apply.
    await db.product.update({
      where: { id: w.productId },
      data: { currentStock: { decrement: 1 } },
    });
    const changed = apply(file, hash);
    expect(changed.status).toBe(1);
    expect(changed.stderr).toContain("changed since the dry run");
    expect(await backfillRows(w.productId)).toHaveLength(0);
  });

  it("apply writes ONE backfill SALE row; the gap closes, the average is untouched, a re-run is idempotent", async () => {
    const w = await seed("apply");
    const { file, hash } = dryRun(w.slug);
    const res = apply(file, hash);
    expect(res.stderr).toBe("");
    expect(res.status).toBe(0);

    const rows = await backfillRows(w.productId);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      type: "SALE",
      reference: `B562:BACKFILL:${hash}`,
      notes: "ledger gap closed at cutover",
      unitCost: null,
      performedById: null,
      tenantId: w.tenantId,
    });
    expect([n(rows[0].quantity), n(rows[0].stockAfter), n(rows[0].avgCostAfter)]).toEqual([
      -2, 98, 2,
    ]);
    expect(rows[0].effectiveAt.toISOString()).toBe(CUTOVER);

    const gap = run(GAP, ["--tenant", w.slug]);
    expect(gap.stdout).toContain("NO DRIFT");
    expect(gap.status).toBe(0);
    const product = await db.product.findUniqueOrThrow({ where: { id: w.productId } });
    expect([n(product.currentStock), n(product.averageCost)]).toEqual([98, 2]);

    const again = apply(file, hash);
    expect(again.status).toBe(0);
    expect(again.stdout).toContain("1 already applied");
    expect(await backfillRows(w.productId)).toHaveLength(1);
  });
});
