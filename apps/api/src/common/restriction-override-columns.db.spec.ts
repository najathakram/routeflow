/**
 * Row 510 (brief 1), L-262: EXECUTED queries for the four restriction-override stamp columns on OrderItem and
 * InvoiceItem against real Postgres: a stamped line round-trips through `OVERRIDE_STAMP_SELECT`, an unstamped line
 * stores SQL NULL in the list column and Prisma reads it as `[]`, `CLEARED_OVERRIDE_STAMP` clears in place, and the
 * audit helper writes its rows through a real transaction (and loses them with the transaction).
 *
 * SAFETY: one throwaway `qa-r510-<run>` tenant approved by `assertTestTenant`; `afterAll` deletes exactly the rows
 * this run created.
 */
import { randomUUID } from "crypto";
import { PrismaClient } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import { Pool } from "pg";
import { describeDb, requireLocalDatabaseUrl } from "./testing/db-spec";
import { CLEARED_OVERRIDE_STAMP, OVERRIDE_STAMP_SELECT } from "./restriction-override-columns";
import { AUDIT_ACTIONS } from "../audit/audit-actions.constant";
import { writeOverrideAuditRows } from "../selling-restrictions/restriction-override-audit";

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { assertTestTenant } = require("../../../../scripts/lib/test-tenants.cjs");

describeDb("row 510: restriction-override stamp columns, real Postgres", () => {
  let pool: Pool;
  let raw: PrismaClient;
  const run = randomUUID().slice(0, 8);
  const slug = assertTestTenant(`qa-r510-${run}`, "restriction-override-columns.db.spec.ts");
  let tenantId = "";
  let userId = "";
  let operatorId = "";
  let customerId = "";
  let orderId = "";
  let invoiceId = "";
  const at = new Date("2026-10-14T12:00:00.000Z");

  beforeAll(async () => {
    pool = new Pool({ connectionString: requireLocalDatabaseUrl() });
    raw = new PrismaClient({ adapter: new PrismaPg(pool) });
    tenantId = (await raw.tenant.create({ data: { slug, name: `r510 ${slug}` } })).id;
    userId = (
      await raw.user.create({
        data: { email: `b-${run}@example.test`, username: `b-${run}`, role: "CUSTOMER", tenantId },
      })
    ).id;
    operatorId = (
      await raw.user.create({
        data: { email: `o-${run}@example.test`, username: `o-${run}`, role: "OPERATOR", tenantId },
      })
    ).id;
    customerId = (
      await raw.customer.create({
        data: { userId, businessName: "r510 co", contactName: "Tester", tenantId },
      })
    ).id;
    orderId = (
      await raw.order.create({
        data: { customerId, tenantId, status: "PENDING", subtotal: "0.00", total: "0.00" },
      })
    ).id;
    invoiceId = (
      await raw.invoice.create({
        data: {
          invoiceNumber: `R510-${run}`,
          customerId,
          tenantId,
          subtotal: "0.00",
          total: "0.00",
        },
      })
    ).id;
  }, 120_000);

  afterAll(async () => {
    await raw.auditLog.deleteMany({ where: { tenantId } });
    await raw.invoiceItem.deleteMany({ where: { invoiceId } });
    await raw.invoice.deleteMany({ where: { id: invoiceId } });
    await raw.orderItem.deleteMany({ where: { orderId } });
    await raw.order.deleteMany({ where: { id: orderId } });
    await raw.customer.deleteMany({ where: { id: customerId } });
    await raw.user.deleteMany({ where: { id: { in: [userId, operatorId] } } });
    await raw.tenant.deleteMany({ where: { id: tenantId } });
    await raw?.$disconnect();
    await pool?.end();
  }, 120_000);

  const stamp = {
    restrictionOverrideReason: "Customer holds a licence",
    restrictionOverrideBy: "",
    restrictionOverrideAt: at,
    restrictionOverrideRuleIds: ["r1"],
  };

  it("OrderItem: a stamped line round-trips; an unstamped line is SQL NULL and reads as []", async () => {
    const stamped = await raw.orderItem.create({
      data: {
        orderId,
        tenantId,
        name: "Stamped",
        qty: "1",
        unitPrice: "1.00",
        ...stamp,
        restrictionOverrideBy: operatorId,
      },
    });
    const plain = await raw.orderItem.create({
      data: { orderId, tenantId, name: "Plain", qty: "1", unitPrice: "1.00" },
    });
    const read = await raw.orderItem.findFirst({
      where: { id: stamped.id },
      select: OVERRIDE_STAMP_SELECT,
    });
    expect(read).toEqual({ ...stamp, restrictionOverrideBy: operatorId });
    const none = await raw.orderItem.findFirst({
      where: { id: plain.id },
      select: OVERRIDE_STAMP_SELECT,
    });
    expect(none).toEqual({
      restrictionOverrideReason: null,
      restrictionOverrideBy: null,
      restrictionOverrideAt: null,
      restrictionOverrideRuleIds: [],
    });
    const sql = await pool.query(
      `SELECT "restrictionOverrideRuleIds" IS NULL AS "isNull" FROM "OrderItem" WHERE id = $1`,
      [plain.id],
    );
    expect(sql.rows[0].isNull).toBe(true);
  });

  it("OrderItem: CLEARED_OVERRIDE_STAMP clears a stamp in place", async () => {
    const line = await raw.orderItem.create({
      data: {
        orderId,
        tenantId,
        name: "Cleared",
        qty: "1",
        unitPrice: "1.00",
        ...stamp,
        restrictionOverrideBy: operatorId,
      },
    });
    await raw.orderItem.update({ where: { id: line.id }, data: { ...CLEARED_OVERRIDE_STAMP } });
    const read = await raw.orderItem.findFirst({
      where: { id: line.id },
      select: OVERRIDE_STAMP_SELECT,
    });
    expect(read).toEqual({ ...CLEARED_OVERRIDE_STAMP });
  });

  it("InvoiceItem: a stamped line round-trips; an unstamped line reads as []", async () => {
    const stamped = await raw.invoiceItem.create({
      data: {
        invoiceId,
        tenantId,
        description: "Stamped",
        qty: "1",
        unitPrice: "1.00",
        subtotal: "1.00",
        ...stamp,
        restrictionOverrideBy: operatorId,
        restrictionOverrideRuleIds: ["r1", "r2"],
      },
    });
    const plain = await raw.invoiceItem.create({
      data: {
        invoiceId,
        tenantId,
        description: "Plain",
        qty: "1",
        unitPrice: "1.00",
        subtotal: "1.00",
      },
    });
    expect(
      await raw.invoiceItem.findFirst({ where: { id: stamped.id }, select: OVERRIDE_STAMP_SELECT }),
    ).toEqual({
      ...stamp,
      restrictionOverrideBy: operatorId,
      restrictionOverrideRuleIds: ["r1", "r2"],
    });
    const none = await raw.invoiceItem.findFirst({ where: { id: plain.id } });
    expect(none?.restrictionOverrideRuleIds).toEqual([]);
    expect(none?.restrictionOverrideAt).toBeNull();
  });

  it("the audit helper writes one row per line inside a real tx, and a rolled-back tx keeps none", async () => {
    const ctx = {
      tenantId,
      by: operatorId,
      entityType: "OrderItem" as const,
      documentType: "ORDER" as const,
      documentId: orderId,
      warningHash: "rw1:test",
      basis: "CUSTOMER" as const,
    };
    const lines = [
      {
        lineId: `l-a-${run}`,
        productId: "p-a",
        lineKey: "n:0",
        ruleIds: ["r1"],
        reason: "Licence on file",
      },
      {
        lineId: `l-b-${run}`,
        productId: "p-b",
        lineKey: "n:1",
        ruleIds: ["r2"],
        reason: "Licence on file",
      },
    ];
    await raw.$transaction((tx) => writeOverrideAuditRows(tx, ctx, lines));
    const rows = await raw.auditLog.findMany({
      where: { tenantId, action: AUDIT_ACTIONS.SELLING_RESTRICTION_OVERRIDDEN },
      orderBy: { entityId: "asc" },
    });
    expect(rows.map((r) => [r.entityType, r.entityId, r.userId])).toEqual([
      ["OrderItem", `l-a-${run}`, operatorId],
      ["OrderItem", `l-b-${run}`, operatorId],
    ]);
    expect(rows[0].meta).toMatchObject({ documentId: orderId, ruleIds: ["r1"], lineKey: "n:0" });

    await expect(
      raw.$transaction(async (tx) => {
        await writeOverrideAuditRows(tx, ctx, [{ ...lines[0], lineId: `l-rb-${run}` }]);
        throw new Error("the write failed after its audit row");
      }),
    ).rejects.toThrow("the write failed");
    expect(await raw.auditLog.count({ where: { tenantId, entityId: `l-rb-${run}` } })).toBe(0);
  });
});
