/**
 * Row 531: the census SQL of report-buyer-split-mismatch.mjs run for real against Postgres, through
 * the script itself (spawned with --json --tenant), on a throwaway approved test tenant.
 *
 * Fixture (one tenant, boxed product 12/box at $12.00 a box):
 *   counted      A  buyer line, 1 box                     -> in `lines` only
 *                B  buyer line, 2 boxes + a staff revision that cut the product to 6 pieces
 *                C  buyer line + a change request
 *                D  buyer line + a return of that product
 *                E  buyer line, delivered 5 of 12 inside the window (short-pick)
 *                F  LEGACY line (authorChannel NULL) on an order recorded as APP -> counted
 *   NOT counted  staff-authored; pieces > 0; cancelled; before --since; legacy line on an
 *                UNRECORDED order (its source says nothing); a unit (Case) line; a non-boxed line
 * The tenant is an approved test tenant, so the script folds it into its `test` bucket.
 * SAFETY: one `qa-531c-<run>` tenant approved by `assertTestTenant`; afterAll deletes exactly the
 * rows this run created. Run via `npm run local:test:db`.
 */
import { randomUUID } from "crypto";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { PrismaClient } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import { Pool } from "pg";
import { describeDb, requireLocalDatabaseUrl } from "./testing/db-spec";

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { assertTestTenant } = require("../../../../scripts/lib/test-tenants.cjs");

const SCRIPT = path.resolve(__dirname, "../../scripts/report-buyer-split-mismatch.mjs");
const DAY = 86_400_000;

describeDb("row 531 census SQL, real Postgres, through the script", () => {
  let pool: Pool;
  let raw: PrismaClient;
  const run = randomUUID().slice(0, 8);
  const slug = assertTestTenant(`qa-531c-${run}`, "report-buyer-split-mismatch.db.spec.ts");
  let tenantId = "";
  let customerId = "";
  let productId = "";
  let plainProductId = "";
  const t0 = new Date("2026-06-01T10:00:00Z");

  /** One order with one line; returns the line. */
  async function lineOn(
    over: Record<string, unknown> = {},
    order: { source?: "APP" | "PHONE"; sourceRecorded?: boolean } = {},
    createdAt: Date = t0,
  ) {
    const o = await raw.order.create({
      data: {
        customerId,
        tenantId,
        status: "PENDING",
        subtotal: "0.00",
        total: "0.00",
        source: order.source ?? "APP",
        sourceRecorded: order.sourceRecorded ?? true,
        createdAt,
        lineItems: {
          create: [
            {
              tenantId,
              productId,
              qty: 12,
              boxes: 1,
              pieces: 0,
              unitsPerBox: 12,
              unitPrice: "12.00",
              subtotal: "12.00",
              priceType: "STANDARD",
              authorChannel: "BUYER",
              createdAt,
              ...over,
            },
          ],
        },
      },
      include: { lineItems: true },
    });
    return { order: o, line: o.lineItems[0] };
  }

  const census = (extra: string[] = []) => {
    const res = spawnSync(
      process.execPath,
      [SCRIPT, "--json", "--tenant", tenantId, "--since", "2026-04-12", ...extra],
      { encoding: "utf8", env: { ...process.env, DATABASE_URL: requireLocalDatabaseUrl() } },
    );
    expect(res.status).toBe(0);
    return JSON.parse(res.stdout);
  };

  beforeAll(async () => {
    pool = new Pool({ connectionString: requireLocalDatabaseUrl() });
    raw = new PrismaClient({ adapter: new PrismaPg(pool) });
    tenantId = (await raw.tenant.create({ data: { slug, name: `Census ${slug}` } })).id;
    const user = await raw.user.create({
      data: { email: `c-${run}@example.test`, username: `c-${run}`, role: "CUSTOMER", tenantId },
    });
    customerId = (
      await raw.customer.create({
        data: { userId: user.id, businessName: `Acme ${run}`, contactName: "T", tenantId },
      })
    ).id;
    productId = (
      await raw.product.create({
        data: {
          name: `Cola ${run}`,
          unit: "Box",
          pricePerUnit: "12.00",
          unitsPerBox: 12,
          tenantId,
        },
      })
    ).id;
    plainProductId = (
      await raw.product.create({
        data: { name: `Loose ${run}`, unit: "each", pricePerUnit: "1.00", tenantId },
      })
    ).id;

    // counted
    await lineOn(); // A
    const b = await lineOn({ qty: 24, boxes: 2, subtotal: "24.00" }); // B
    await raw.orderRevision.create({
      data: {
        tenantId,
        orderId: b.order.id,
        revisionNumber: 1,
        editedByRole: "OPERATOR",
        createdAt: new Date(t0.getTime() + 2 * DAY),
        snapshot: { lineItems: [{ productId, qty: 6, status: "PENDING" }] },
      },
    });
    const c = await lineOn(); // C
    await raw.changeRequest.create({
      data: {
        tenantId,
        orderId: c.order.id,
        orderItemId: c.line.id,
        productId,
        type: "CHANGE_QTY",
        payload: { orderItemId: c.line.id, newQty: 1 },
        createdAt: new Date(t0.getTime() + 3 * DAY),
      },
    });
    const d = await lineOn(); // D
    await raw.return.create({
      data: {
        tenantId,
        orderId: d.order.id,
        customerId,
        reason: "EXCESS_ORDER",
        createdAt: new Date(t0.getTime() + 4 * DAY),
        items: { create: [{ tenantId, productId, qty: 6 }] },
      },
    });
    await lineOn({ deliveredQty: "5", updatedAt: new Date(t0.getTime() + 1 * DAY) }); // E
    await lineOn({ authorChannel: null }); // F: legacy marker, recorded APP order

    // NOT counted
    await lineOn({ authorChannel: "STAFF" });
    await lineOn({ qty: 14, boxes: 1, pieces: 2 });
    await lineOn({ status: "CANCELLED" });
    await lineOn({}, {}, new Date("2026-03-01T10:00:00Z")); // before --since
    await lineOn({ authorChannel: null }, { sourceRecorded: false }); // unrecorded legacy order
    await lineOn({ authorChannel: null }, { source: "PHONE" }); // legacy line on a staff order
    await lineOn({ unitLabel: "Case" });
    await lineOn({
      productId: plainProductId,
      qty: 3,
      boxes: null,
      pieces: null,
      unitsPerBox: null,
    });
  }, 120_000);

  afterAll(async () => {
    try {
      const ids = (await raw.order.findMany({ where: { tenantId }, select: { id: true } })).map(
        (o) => o.id,
      );
      await raw.returnItem.deleteMany({ where: { tenantId } });
      await raw.return.deleteMany({ where: { tenantId } });
      await raw.changeRequest.deleteMany({ where: { tenantId } });
      await raw.orderRevision.deleteMany({ where: { orderId: { in: ids } } });
      await raw.orderItem.deleteMany({ where: { tenantId } });
      await raw.order.deleteMany({ where: { tenantId } });
      await raw.product.deleteMany({ where: { tenantId } });
      await raw.customer.deleteMany({ where: { tenantId } });
      await raw.user.deleteMany({ where: { tenantId } });
      await raw.tenant.deleteMany({ where: { id: tenantId } });
    } finally {
      await raw?.$disconnect();
      await pool?.end();
    }
  }, 120_000);

  it("counts the buyer whole-Case lines (ceiling) and the ones their own history contradicts", () => {
    const r = census();
    // an approved test tenant folds into `test`; no live tenant is listed
    expect(r.total.lines).toBe(0);
    expect(r.detail).toEqual([]);
    expect(r.test.lines).toBe(6); // A..F
    expect(r.test.likelier).toBe(4); // B staff reduction, C change request, D return, E short-pick
    expect(r.test).toMatchObject({
      staffReduction: 1,
      changeRequest: 1,
      returned: 1,
      shortPick: 1,
    });
    // A, C, D, E, F bill one box ($12.00); B bills two ($24.00): computeLineSubtotal + roundMoney
    expect(r.test.amount).toBe(84);
    expect(r.test.likelierAmount).toBe(60); // B 24 + C 12 + D 12 + E 12
  }, 120_000);

  it("--since moves the start: from June 2 nothing created on June 1 is counted", () => {
    expect(census(["--since", "2026-06-02"]).test.lines).toBe(0);
  }, 120_000);

  it("--window narrows the follow-up: a 1-day window keeps only the short-pick settled in a day", () => {
    const r = census(["--window", "1"]);
    expect(r.test.lines).toBe(6);
    expect(r.test.likelier).toBe(1);
    expect(r.test.shortPick).toBe(1);
  }, 120_000);
});
