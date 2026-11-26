/**
 * SA-1506 PR-1a (Amendment 1, red-first cases 1-5, 7, 10, 11, 14), real Postgres, THROUGH
 * OrdersService.updateOrderItems(): a TENANT_ADMIN corrects a delivered line of a reopened order (CONFIRMED, holding a
 * live delivered line) whose delivery evidence is office-only. The stored delivered quantity, the office evidence rows,
 * the stock counter + ledger and the audit row all move together; every other actor or evidence shape is a coded 409
 * with nothing written.
 *
 * Builds a REAL OrdersService via `Object.create` (no Nest DI) with the invoice collaborators stubbed, as
 * b1234-delivered-line-lock.db.spec.ts does; the invoice restatement cases are in
 * delivered-line-correction.routing.db.spec.ts.
 *
 * Runs only under `npm run local:test:db`. SAFETY: one throwaway `qa-sa1506-<run>` tenant approved by
 * `assertTestTenant`; `afterAll` deletes exactly the rows this run created.
 */
jest.mock("../invoices/invoices.service", () => ({
  InvoicesService: jest.fn().mockImplementation(() => ({})),
}));
jest.mock("../notifications/notifications.service", () => ({
  NotificationsService: jest.fn().mockImplementation(() => ({})),
}));

import { randomUUID } from "crypto";
import { PrismaClient } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import { Pool } from "pg";
import { Logger } from "@nestjs/common";
import { describeDb, requireLocalDatabaseUrl } from "../common/testing/db-spec";
import { CORRECT_IDENTITY_MESSAGE } from "./delivered-line-copy";
import { PrismaService } from "../prisma/prisma.service";
import { TenantContextService } from "../tenant/tenant-context.service";
import { EncryptionService } from "../common/encryption.service";
import { SystemConfigService } from "../system-config/system-config.service";
import { OrdersService } from "./orders.service";
import type { JwtPayload } from "../auth/jwt-payload.interface";
import { INVOICE_EDIT_STUBS } from "./testing/invoice-edit-stubs";

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { assertTestTenant } = require("../../../../scripts/lib/test-tenants.cjs");

describeDb("SA-1506 PR-1a: an admin corrects a delivered line of a reopened order", () => {
  let pool: Pool;
  let raw: PrismaClient;
  let prisma: PrismaService;
  let tenantCtx: TenantContextService;
  let orders: any;
  const run = randomUUID().slice(0, 8);
  const slug = assertTestTenant(`qa-sa1506-${run}`, "delivered-line-correction.db.spec.ts");
  let tenantId = "";
  let adminUserId = "";
  let operatorUserId = "";
  let buyerUserId = "";
  let driverUserId = "";
  let driverId = "";
  let customerId = "";
  const productIds: string[] = [];
  const orderIds: string[] = [];

  const principal = (role: string, sub: string, extra: Partial<JwtPayload> = {}): JwtPayload =>
    ({
      sub,
      username: `${role.toLowerCase()}-${run}`,
      role,
      status: "ACTIVE",
      forcePasswordChange: false,
      tenantId,
      tenantSlug: slug,
      ...extra,
    }) as JwtPayload;
  const admin = (extra: Partial<JwtPayload> = {}) => principal("TENANT_ADMIN", adminUserId, extra);
  const operator = () => principal("OPERATOR", operatorUserId);

  async function product(tag: string, unitsPerBox: number | null = null) {
    const p = await raw.product.create({
      data: {
        name: `${tag} cola ${run} #${productIds.length + 1}`,
        unit: "ea",
        pricePerUnit: "1.00",
        currentStock: "90",
        unitsPerBox,
        tenantId,
      },
    });
    productIds.push(p.id);
    return p.id;
  }

  /** A reopened order: CONFIRMED, its lines already out of stock (the counter starts at 90). */
  async function reopened(lines: any[], status = "CONFIRMED") {
    const o = await raw.order.create({
      data: {
        customerId,
        tenantId,
        status: status as any,
        subtotal: "20.00",
        total: "20.00",
        lineItems: { create: lines.map((l) => ({ tenantId, ...l })) },
      },
      include: { lineItems: true },
    });
    orderIds.push(o.id);
    return o;
  }
  /** One office evidence row (no route stop, no driver): what an office DELIVERED / PD leaves. */
  const officeRow = (orderId: string, line: { id: string; productId: string }, qty: number) =>
    raw.deliveryMutation.create({
      data: {
        orderId,
        orderItemId: line.id,
        productId: line.productId,
        routeRunStopId: null,
        driverId: null,
        type: "DELIVERED",
        quantityDelivered: qty,
        note: "OFFICE_MARKED",
        tenantId,
      },
    });
  const plain = (productId: string, qty: number, deliveredQty = qty) => ({
    productId,
    qty,
    deliveredQty,
    unitPrice: "1.00",
    subtotal: String(qty),
  });
  const edit = (orderId: string, dto: any, who: JwtPayload = admin()) =>
    tenantCtx.run(tenantId, () => orders.updateOrderItems(orderId, dto, who));
  const line = (orderId: string) => raw.orderItem.findFirstOrThrow({ where: { orderId } });
  const stock = async (id: string) =>
    Number((await raw.product.findUniqueOrThrow({ where: { id } })).currentStock);
  const ledgerNet = async (productId: string) =>
    (await raw.stockMovement.findMany({ where: { productId } })).reduce(
      (s, m) => s + Number(m.quantity),
      0,
    );
  const officeSum = async (orderId: string) =>
    (await raw.deliveryMutation.findMany({ where: { orderId } })).reduce(
      (s, m) => s + Number(m.quantityDelivered ?? 0),
      0,
    );
  const audits = (orderId: string) =>
    raw.auditLog.findMany({
      where: { tenantId, action: "order.line-corrected", entityId: orderId },
    });
  const conflict = (code = "LINE_ALREADY_DELIVERED") => ({ response: { code } });

  beforeAll(async () => {
    pool = new Pool({ connectionString: requireLocalDatabaseUrl() });
    raw = new PrismaClient({ adapter: new PrismaPg(pool) });
    tenantCtx = new TenantContextService();
    prisma = new PrismaService(tenantCtx);
    await prisma.$connect();
    const systemConfig = new SystemConfigService(
      prisma,
      new EncryptionService({ get: () => undefined } as any),
    );
    orders = Object.assign(Object.create(OrdersService.prototype), {
      prisma,
      gateway: { emitOrderStatusChanged: jest.fn(), emitOrderCreated: jest.fn() },
      systemConfig,
      entitlements: { hasFlag: async () => true },
      sellingRestrictions: {
        getPolicy: async () => ({ enabled: false, addressPrecedence: "BILLING_FIRST" }),
        assertLinesSellable: async () => undefined,
      },
      authGuard: { assertAuthorizedOrThrow: async () => undefined },
      promotionsService: { activeForCatalog: async () => [] },
      tenantCtx,
      invoicesService: {
        revertLinkedInvoicesForOrderEdit: async () => undefined,
        resyncOrderInvoicesForEdit: async () => [],
        ...INVOICE_EDIT_STUBS,
        reconcileOrderDraftInvoice: async () => undefined,
      },
      logger: new Logger(OrdersService.name),
      inlineReturns: {},
      creditNotes: { settleOrderCreditsInTx: async () => ({ applied: 0, unapplied: 0 }) },
    });
    tenantId = (await raw.tenant.create({ data: { slug, name: `sa1506 ${slug}` } })).id;
    const user = async (tag: string, role: string) =>
      (
        await raw.user.create({
          data: {
            email: `${tag}-${run}@example.test`,
            username: `${tag}-${run}`,
            role: role as any,
            tenantId,
          },
        })
      ).id;
    adminUserId = await user("a", "TENANT_ADMIN");
    operatorUserId = await user("o", "OPERATOR");
    buyerUserId = await user("b", "CUSTOMER");
    driverUserId = await user("d", "DRIVER");
    customerId = (
      await raw.customer.create({
        data: { userId: buyerUserId, businessName: "sa1506 co", contactName: "Tester", tenantId },
      })
    ).id;
    driverId = (await raw.driver.create({ data: { userId: driverUserId, tenantId } as any })).id;
  }, 120_000);

  afterAll(async () => {
    await raw.auditLog.deleteMany({ where: { tenantId } });
    await raw.deliveryMutation.deleteMany({ where: { orderId: { in: orderIds } } });
    await raw.orderRevision?.deleteMany?.({ where: { orderId: { in: orderIds } } });
    await raw.orderItem.deleteMany({ where: { orderId: { in: orderIds } } });
    await raw.order.deleteMany({ where: { id: { in: orderIds } } });
    await raw.stockMovement.deleteMany({ where: { productId: { in: productIds } } });
    await raw.product.deleteMany({ where: { id: { in: productIds } } });
    await raw.customer.deleteMany({ where: { id: customerId } });
    await raw.driver.deleteMany({ where: { tenantId } });
    await raw.user.deleteMany({
      where: { id: { in: [adminUserId, operatorUserId, buyerUserId, driverUserId] } },
    });
    await raw.tenant.deleteMany({ where: { id: tenantId } });
    await prisma?.$disconnect();
    await raw?.$disconnect();
    await pool?.end();
  }, 120_000);

  it("case 1: loose 10/10 corrected to 8 puts 2 back, restates the office row, one audit row", async () => {
    const p = await product("c1");
    const o = await reopened([plain(p, 10)]);
    await officeRow(o.id, { id: o.lineItems[0].id, productId: p }, 10);
    await edit(o.id, { replaceAll: false, items: [{ id: o.lineItems[0].id, qty: 8 }] });
    const after = await line(o.id);
    expect(Number(after.qty)).toBe(8);
    expect(Number(after.deliveredQty)).toBe(8);
    expect(await officeSum(o.id)).toBe(8);
    expect(await stock(p)).toBe(92);
    expect(await ledgerNet(p)).toBe(2);
    const rows = await audits(o.id);
    expect(rows).toHaveLength(1);
    expect((rows[0].meta as any).lineId).toBe(o.lineItems[0].id);
    expect((await raw.order.findUniqueOrThrow({ where: { id: o.id } })).status).toBe("CONFIRMED");
  });

  it("case 1b (SA-1514 R1 case 2): raising 10/10 to 12 takes 2 more from stock; a fully delivered line stays fully delivered (12, one office row of 2)", async () => {
    const p = await product("c1b");
    const o = await reopened([plain(p, 10)]);
    await officeRow(o.id, { id: o.lineItems[0].id, productId: p }, 10);
    await edit(o.id, { replaceAll: false, items: [{ id: o.lineItems[0].id, qty: 12 }] });
    expect(Number((await line(o.id)).qty)).toBe(12);
    expect(Number((await line(o.id)).deliveredQty)).toBe(12);
    expect(await officeSum(o.id)).toBe(12);
    expect(await stock(p)).toBe(88);
  });

  it("case 2: take-off (CANCEL) keeps the row CANCELLED at deliveredQty 0 and returns all 10; DELETE does the same", async () => {
    for (const action of ["CANCEL", "DELETE"] as const) {
      const p = await product(`c2-${action}`);
      const o = await reopened([plain(p, 10)]);
      await officeRow(o.id, { id: o.lineItems[0].id, productId: p }, 10);
      await edit(o.id, { replaceAll: false, items: [{ id: o.lineItems[0].id, action }] });
      const after = await line(o.id); // the row is kept
      expect(after.status).toBe("CANCELLED");
      expect(Number(after.deliveredQty)).toBe(0);
      expect(await officeSum(o.id)).toBe(0);
      expect(await stock(p)).toBe(100);
      expect(await ledgerNet(p)).toBe(10);
    }
  });

  it("case 3: a box-split line and a box-unaware perPack line move the exact piece deltas", async () => {
    const p = await product("c3", 12);
    // box-split: 2 boxes of 12 = 24 pieces (qty is pieces), corrected to 1 box + 6 pieces = 18: +6
    const split = await reopened([
      {
        productId: p,
        qty: 24,
        boxes: 2,
        pieces: 0,
        unitsPerBox: 12,
        deliveredQty: 24,
        unitPrice: "0.50",
        subtotal: "12.00",
      },
    ]);
    await officeRow(split.id, { id: split.lineItems[0].id, productId: p }, 24);
    await edit(split.id, {
      replaceAll: false,
      items: [{ id: split.lineItems[0].id, boxes: 1, pieces: 6 }],
    });
    expect(Number((await line(split.id)).deliveredQty)).toBe(18);
    expect(await stock(p)).toBe(96);
    // box-unaware: qty 3 BOXES at the live pack of 12 = 36 pieces, corrected to 2 boxes = 24: +12
    const q = await product("c3b", 12);
    const unaware = await reopened([plain(q, 3)]);
    await officeRow(unaware.id, { id: unaware.lineItems[0].id, productId: q }, 3);
    await edit(unaware.id, { replaceAll: false, items: [{ id: unaware.lineItems[0].id, qty: 2 }] });
    expect(await stock(q)).toBe(102);
  });

  it("case 4: correct to 8, then mark DELIVERED again: still 8, no remainder row, no stock move", async () => {
    const { completeOfficeEvidencedLines } = await import("./office-evidence-completion");
    const p = await product("c4");
    const o = await reopened([plain(p, 10)]);
    await officeRow(o.id, { id: o.lineItems[0].id, productId: p }, 10);
    await edit(o.id, { replaceAll: false, items: [{ id: o.lineItems[0].id, qty: 8 }] });
    const rowsBefore = await raw.deliveryMutation.count({ where: { orderId: o.id } });
    const done = await raw.$transaction((tx) =>
      completeOfficeEvidencedLines(tx, o.id, { tenantId, userId: adminUserId }),
    );
    expect(done).toEqual([]);
    expect(await raw.deliveryMutation.count({ where: { orderId: o.id } })).toBe(rowsBefore);
    expect(Number((await line(o.id)).deliveredQty)).toBe(8);
    expect(await stock(p)).toBe(92);
  });

  it("case 5: a delivered-quantity recompute after the correction still reads 8; raising qty to 12 later keeps it fully delivered (12)", async () => {
    const { deliveredQtyRecompute } = await import("../routes/delivered-so-far");
    const p = await product("c5");
    const o = await reopened([plain(p, 10)]);
    const id = o.lineItems[0].id;
    await officeRow(o.id, { id, productId: p }, 10);
    await edit(o.id, { replaceAll: false, items: [{ id, qty: 8 }] });
    const recomputed = await raw.$transaction((tx) => deliveredQtyRecompute(tx, o.id, [id]));
    expect(recomputed.map((u: any) => Number(u.deliveredQty))).toEqual([8]);
    expect(await raw.deliveryMutation.count({ where: { orderId: o.id } })).toBe(1); // restated, never deleted
    await edit(o.id, { replaceAll: false, items: [{ id, qty: 12 }] });
    const raised = await line(o.id);
    expect(Number(raised.qty) - Number(raised.deliveredQty)).toBe(0); // fully delivered stays fully delivered (R1 case 2)
  });

  it("case 7: an operator lowering the delivered line is refused with the admin sentence, nothing moves", async () => {
    const p = await product("c7");
    const o = await reopened([plain(p, 10)]);
    await officeRow(o.id, { id: o.lineItems[0].id, productId: p }, 10);
    await expect(
      edit(o.id, { replaceAll: false, items: [{ id: o.lineItems[0].id, qty: 8 }] }, operator()),
    ).rejects.toMatchObject({
      response: {
        code: "LINE_ALREADY_DELIVERED",
        message: expect.stringContaining("Only an admin can correct a delivered line."),
      },
    });
    expect(await stock(p)).toBe(90);
    expect(Number((await line(o.id)).qty)).toBe(10);
    expect(await audits(o.id)).toHaveLength(0);
  });

  it("case 10: a SUPER_ADMIN with no tenant context is refused and writes nothing; an impersonated admin is allowed and named", async () => {
    const p = await product("c10");
    const o = await reopened([plain(p, 10)]);
    const id = o.lineItems[0].id;
    await officeRow(o.id, { id, productId: p }, 10);
    const sa = principal("SUPER_ADMIN", adminUserId, { tenantId: null });
    await expect(
      orders.updateOrderItems(o.id, { replaceAll: false, items: [{ id, qty: 8 }] }, sa),
    ).rejects.toBeDefined();
    expect(await stock(p)).toBe(90);
    expect(await audits(o.id)).toHaveLength(0);
    await edit(
      o.id,
      { replaceAll: false, items: [{ id, qty: 8 }] },
      admin({ impersonatedBy: operatorUserId }),
    );
    const rows = await audits(o.id);
    expect(rows).toHaveLength(1);
    expect(rows[0].impersonatedBy ?? (rows[0].meta as any).impersonatedBy).toBe(operatorUserId);
  });

  it("case 11: each LOCKED reason is a coded 409 with its sentence and writes nothing (route, partly invoiced)", async () => {
    // ROUTE: a driver-recorded row on the line
    const p = await product("c11r");
    const route = await reopened([plain(p, 10)]);
    const rid = route.lineItems[0].id;
    await raw.deliveryMutation.create({
      data: {
        orderId: route.id,
        orderItemId: rid,
        productId: p,
        driverId,
        type: "DELIVERED",
        quantityDelivered: 10,
        tenantId,
      },
    });
    await expect(
      edit(route.id, { replaceAll: false, items: [{ id: rid, qty: 8 }] }),
    ).rejects.toMatchObject({
      response: {
        code: "LINE_ALREADY_DELIVERED",
        message: expect.stringContaining("A driver delivered this item."),
      },
    });
    // SPLIT_BILL: part of the order is invoiced
    const split = await reopened([{ ...plain(p, 10), invoicedQty: 4 }, plain(p, 5)]);
    await officeRow(split.id, { id: split.lineItems[0].id, productId: p }, 10);
    await expect(
      edit(split.id, { replaceAll: false, items: [{ id: split.lineItems[0].id, qty: 8 }] }),
    ).rejects.toMatchObject(conflict());
    expect(await stock(p)).toBe(90);
    expect(await ledgerNet(p)).toBe(0);
    expect(Number((await line(route.id)).qty)).toBe(10);
  });

  it("case 17 (A2 NEW-M2): an office Mark delivered with ZERO rows, 10/10 corrected to 8: column 8, no row created, stock +2; recompute keeps 8", async () => {
    const p = await product("c17");
    const o = await reopened([plain(p, 10)]);
    const id = o.lineItems[0].id;
    await edit(o.id, { replaceAll: false, items: [{ id, qty: 8 }] });
    const after = await line(o.id);
    expect(Number(after.qty)).toBe(8);
    expect(Number(after.deliveredQty)).toBe(8);
    expect(await raw.deliveryMutation.count({ where: { orderId: o.id } })).toBe(0);
    expect(await stock(p)).toBe(92);
    const { deliveredQtyRecompute } = await import("../routes/delivered-so-far");
    await raw.$transaction((tx) => deliveredQtyRecompute(tx, o.id, [id]));
    expect(Number((await line(o.id)).deliveredQty)).toBe(8);
  });

  it("R4-G (SA-1520): a row-less line (column 8, qty 12) on an order whose other lines have rows: qty to 13 gives delivered 13 and bills 13", async () => {
    const { deliveredBasisByLine, billableQtyFromBasis } =
      await import("../invoices/delivered-basis-by-line");
    const p = await product("r4g");
    const q = await product("r4g2");
    const o = await reopened([plain(p, 12, 8), plain(q, 5)]);
    const [rowless, withRows] = o.lineItems;
    await officeRow(o.id, { id: withRows.id, productId: q }, 5);
    await edit(o.id, { replaceAll: false, items: [{ id: rowless.id, qty: 13 }] });
    const after = await raw.orderItem.findUniqueOrThrow({ where: { id: rowless.id } });
    expect(Number(after.deliveredQty)).toBe(13); // wrong value: 8 (the column) while the invoice bills 13
    const basis = await deliveredBasisByLine(raw as any, o.id);
    expect(billableQtyFromBasis({ id: rowless.id, qty: 13 }, basis)).toBe(13);
  });

  it("R4-F (SA-1520 M-1): a NONE line (qty 12, no rows) corrected to deliveredTo 8 writes ONE office row of 8: bills 8, column 8", async () => {
    const { restateLineEvidence } = await import("./delivered-line-correction");
    const { deliveredBasisByLine, billableQtyFromBasis } =
      await import("../invoices/delivered-basis-by-line");
    const p = await product("r4f");
    const o = await reopened([plain(p, 12)]);
    const id = o.lineItems[0].id;
    // the DTO field deliveredTo is PR-1c's; the seam and the one function are PR-1a's
    await raw.$transaction(async (tx) => {
      const { correctedDeliveredFor } = await import("./corrected-delivered");
      const d = correctedDeliveredFor(
        { deliveredQty: 12, qty: 12 },
        { finalQty: 12, struck: false, deliveredTo: 8 },
      );
      await tx.orderItem.update({ where: { id }, data: { deliveredQty: d } });
      await restateLineEvidence(
        tx,
        { orderId: o.id, tenantId },
        { id, productId: p },
        d,
        "NONE",
        12,
      );
    });
    const rows = await raw.deliveryMutation.findMany({ where: { orderId: o.id } });
    expect(rows).toHaveLength(1); // wrong value: 0 rows, so the invoice bills 12
    expect(Number(rows[0].quantityDelivered)).toBe(8);
    expect(rows[0].routeRunStopId).toBeNull();
    expect(rows[0].driverId).toBeNull();
    const basis = await deliveredBasisByLine(raw as any, o.id);
    expect(billableQtyFromBasis({ id, qty: 12 }, basis)).toBe(8);
    expect(Number((await line(o.id)).deliveredQty)).toBe(8);
  });

  it("case 18 (A2 M8): the allow-list is CONFIRMED / PARTIALLY_DELIVERED; every other status is LOCKED STATUS with its own sentence", async () => {
    const p = await product("c18");
    const sentences: Record<string, string> = {
      PENDING: "Confirm the order to correct delivered items.",
      DRAFT: "Submit and confirm the order to correct delivered items.",
      OUT_FOR_DELIVERY: "Move the order back to Confirmed to correct delivered items.",
      REFUSED: "Use Deliver again, then correct delivered items.",
    };
    for (const [status, sentence] of Object.entries(sentences)) {
      const o = await reopened([plain(p, 10)], status);
      const id = o.lineItems[0].id;
      await officeRow(o.id, { id, productId: p }, 10);
      await expect(
        edit(o.id, { replaceAll: false, items: [{ id, qty: 8 }] }),
      ).rejects.toMatchObject({ response: { message: expect.stringContaining(sentence) } });
      expect(Number((await line(o.id)).qty)).toBe(10);
    }
    expect(await stock(p)).toBe(90);
  });

  it("case 19 (A2 M5): a CORRECT entry together with an inline return is refused in one save, nothing written", async () => {
    const p = await product("c19");
    const o = await reopened([plain(p, 10)]);
    const id = o.lineItems[0].id;
    await officeRow(o.id, { id, productId: p }, 10);
    await expect(
      edit(o.id, {
        replaceAll: false,
        items: [{ id, qty: 8 }],
        inlineReturn: { returnKey: "k19", items: [] },
      }),
    ).rejects.toMatchObject({
      response: {
        message: expect.stringContaining(
          "Save the delivered-item changes first, then add the return.",
        ),
      },
    });
    expect(await stock(p)).toBe(90);
    expect(await audits(o.id)).toHaveLength(0);
  });

  // A2 case 16 (SA-1514 LOW 10): which assertion is red where. The productId change is red BY BEHAVIOUR on the base: without
  // the rule the entry reaches the write loop and the old product's stock moves. The substitution assertion is red BY
  // MESSAGE ONLY: the base already refuses a substitution, with another sentence, so only the swap sentence check can fail.
  it("case 16 (11b): CORRECT refuses substitution, a product change and a unit-label change with the swap sentence", async () => {
    const p = await product("c11s");
    const other = await product("c11o");
    for (const change of [
      { substituteProductId: other }, // red by message only
      { productId: other }, // red by behaviour
      { unitLabel: "case" },
    ]) {
      const o = await reopened([plain(p, 10)]);
      const id = o.lineItems[0].id;
      await officeRow(o.id, { id, productId: p }, 10);
      await expect(
        edit(o.id, { replaceAll: false, items: [{ id, ...change }] }),
      ).rejects.toMatchObject({
        response: { code: "LINE_ALREADY_DELIVERED", message: CORRECT_IDENTITY_MESSAGE },
      });
      expect(Number((await line(o.id)).qty)).toBe(10);
    }
    expect(await stock(p)).toBe(90);
  });

  it("case 14: a reopened PARTIALLY_DELIVERED order with office evidence is CORRECT; one with a stop row is LOCKED", async () => {
    const p = await product("c14");
    const ok = await reopened([plain(p, 10)], "PARTIALLY_DELIVERED");
    await officeRow(ok.id, { id: ok.lineItems[0].id, productId: p }, 10);
    await edit(ok.id, { replaceAll: false, items: [{ id: ok.lineItems[0].id, qty: 8 }] });
    expect(Number((await line(ok.id)).deliveredQty)).toBe(8);
    const nativeStop = await reopened([plain(p, 10)], "PARTIALLY_DELIVERED");
    await raw.deliveryMutation.create({
      data: {
        orderId: nativeStop.id,
        orderItemId: nativeStop.lineItems[0].id,
        productId: p,
        driverId,
        type: "PARTIAL",
        quantityDelivered: 10,
        tenantId,
      },
    });
    await expect(
      edit(nativeStop.id, {
        replaceAll: false,
        items: [{ id: nativeStop.lineItems[0].id, qty: 8 }],
      }),
    ).rejects.toMatchObject(conflict());
  });
});
