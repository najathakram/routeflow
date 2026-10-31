/**
 * SA-1067 C3 (rows C-7, C-8) - real-Postgres pin of the order the receipt and the packing slip read an order's lines in:
 * `[{ position: "asc" }, { createdAt: "asc" }, { id: "asc" }]`. Lines made in one write share a `createdAt`, so position
 * decides; a line with NO position (legacy rows, merge and change-request appends) sorts LAST, which is Postgres's NULLS LAST
 * on ASC and not something Prisma adds. The query-argument pins in receipt.service.spec.ts / packing-slip.service.spec.ts
 * prove both services ask for this order; this proves what the database does with it.
 *
 * SAFETY: one throwaway `qa-c3order-<run>` tenant approved by `assertTestTenant`; `afterAll` deletes exactly its rows.
 */
import { randomUUID } from "crypto";
import { PrismaClient } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import { Pool } from "pg";
import { describeDb, requireLocalDatabaseUrl } from "../common/testing/db-spec";

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { assertTestTenant } = require("../../../../scripts/lib/test-tenants.cjs");

const LINE_ORDER = [
  { position: "asc" as const },
  { createdAt: "asc" as const },
  { id: "asc" as const },
];

describeDb(
  "SA-1067 C3: an order's lines read by position, then createdAt, then id (real Postgres)",
  () => {
    let pool: Pool;
    let raw: PrismaClient;
    const run = randomUUID().slice(0, 8);
    const slug = assertTestTenant(`qa-c3order-${run}`, "line-order.db.spec.ts");
    let tenantId = "";
    let userId = "";
    let customerId = "";
    const orderIds: string[] = [];

    beforeAll(async () => {
      pool = new Pool({ connectionString: requireLocalDatabaseUrl() });
      raw = new PrismaClient({ adapter: new PrismaPg(pool) });
      tenantId = (await raw.tenant.create({ data: { slug, name: `c3 ${slug}` } })).id;
      userId = (
        await raw.user.create({
          data: {
            email: `c-${run}@example.test`,
            username: `c-${run}`,
            role: "CUSTOMER",
            tenantId,
          },
        })
      ).id;
      customerId = (
        await raw.customer.create({
          data: { userId, businessName: "c3 co", contactName: "Tester", tenantId },
        })
      ).id;
    }, 120_000);

    afterAll(async () => {
      await raw.orderItem.deleteMany({ where: { orderId: { in: orderIds } } });
      await raw.order.deleteMany({ where: { id: { in: orderIds } } });
      await raw.customer.deleteMany({ where: { id: customerId } });
      await raw.user.deleteMany({ where: { id: userId } });
      await raw.tenant.deleteMany({ where: { id: tenantId } });
      await raw?.$disconnect();
      await pool?.end();
    }, 120_000);

    /** One order whose lines all share one createdAt, with the given positions (null = legacy/appended). */
    async function orderWith(
      positions: Array<number | null>,
      createdAt = new Date("2026-10-01T12:00:00Z"),
    ) {
      const o = await raw.order.create({
        data: {
          customerId,
          tenantId,
          status: "PENDING",
          subtotal: "3.00",
          total: "3.00",
          lineItems: {
            create: positions.map((position, i) => ({
              tenantId,
              name: `line ${i}`,
              qty: "1",
              unitPrice: "1.00",
              position,
              createdAt,
            })),
          },
        },
      });
      orderIds.push(o.id);
      return o.id;
    }
    const read = async (orderId: string) =>
      (await raw.orderItem.findMany({ where: { orderId }, orderBy: LINE_ORDER })).map(
        (l) => [l.name, l.position] as const,
      );

    it("C-7: lines at an equal createdAt, positions 1 then 0 inserted, read 0 then 1", async () => {
      const id = await orderWith([1, 0]);
      expect(await read(id)).toEqual([
        ["line 1", 0],
        ["line 0", 1],
      ]);
    });

    it("C-8: lines with no position sort last, after every positioned line", async () => {
      const id = await orderWith([null, 1, null, 0]);
      const lines = await read(id);
      expect(lines.map(([, p]) => p)).toEqual([0, 1, null, null]);
    });

    it("an equal position and createdAt falls back to id, so the order is fixed", async () => {
      const id = await orderWith([null, null, null]);
      const ids = (
        await raw.orderItem.findMany({ where: { orderId: id }, orderBy: LINE_ORDER })
      ).map((l) => l.id);
      expect(ids).toEqual([...ids].sort());
    });
  },
);
