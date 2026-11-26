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
import { DELIVERED_LINE_REMOVED_MESSAGE } from "./delivered-line-lock";
import { PrismaService } from "../prisma/prisma.service";
import { TenantContextService } from "../tenant/tenant-context.service";
import { EncryptionService } from "../common/encryption.service";
import { SystemConfigService } from "../system-config/system-config.service";
import { OrdersService } from "./orders.service";
import type { JwtPayload } from "../auth/jwt-payload.interface";
import { INVOICE_EDIT_STUBS } from "./testing/invoice-edit-stubs";
import { completeOfficeEvidencedLines } from "./office-evidence-completion";
import { deliveredQtyRecompute } from "../routes/delivered-so-far";
import { deliveredBasisByLine, billableQtyFromBasis } from "../invoices/delivered-basis-by-line";
import { restateLineEvidence } from "./delivered-line-correction";
import { captureRecreatedCarry } from "./delivered-stamp";
import { correctedDeliveredFor } from "./corrected-delivered";

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
  const stopIds: Array<{ route: string; routeStop: string; run: string; stop: string }> = [];

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
      inlineReturns: { assertInlineReturnAllowed: async () => undefined },
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
    await raw.routeRunStop.deleteMany({ where: { id: { in: stopIds.map((s) => s.stop) } } });
    await raw.routeRun.deleteMany({ where: { id: { in: stopIds.map((s) => s.run) } } });
    await raw.routeStop.deleteMany({ where: { id: { in: stopIds.map((s) => s.routeStop) } } });
    await raw.route.deleteMany({ where: { id: { in: stopIds.map((s) => s.route) } } });
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
      await edit(o.id, {
        replaceAll: false,
        items: [{ id: o.lineItems[0].id, action, deliveredTo: 0 }],
      });
      const after = await line(o.id); // the row is kept
      expect(after.status).toBe("CANCELLED");
      expect(Number(after.deliveredQty)).toBe(0);
      expect(await officeSum(o.id)).toBe(0);
      expect(await stock(p)).toBe(100);
      expect(await ledgerNet(p)).toBe(10);
    }
  });

  it("case 2b (SA-1533 s): a bare CANCEL / DELETE of a CORRECT line is master's removal 409: stock 0 moves, column 10, line live; deliveredTo 0 restocks +10", async () => {
    for (const action of ["CANCEL", "DELETE"] as const) {
      const p = await product(`c2b-${action}`);
      const o = await reopened([plain(p, 10)]);
      const id = o.lineItems[0].id;
      await officeRow(o.id, { id, productId: p }, 10);
      await expect(
        edit(o.id, { replaceAll: false, items: [{ id, action }] }),
      ).rejects.toMatchObject({
        status: 409,
        response: {
          code: "LINE_ALREADY_DELIVERED",
          message: DELIVERED_LINE_REMOVED_MESSAGE,
        },
      });
      const after = await line(o.id);
      expect([after.status, Number(after.deliveredQty), Number(after.qty)]).toEqual([
        "PENDING",
        10,
        10,
      ]);
      expect(await stock(p)).toBe(90);
      expect(await ledgerNet(p)).toBe(0);
      expect(await officeSum(o.id)).toBe(10);
      expect(await audits(o.id)).toHaveLength(0);
      // the same save with the admin's word: +10
      await edit(o.id, { replaceAll: false, items: [{ id, action, deliveredTo: 0 }] });
      expect(await stock(p)).toBe(100);
    }
  });

  it("(s) shape: deliveredTo other than 0, or 0 without a take-off, is a 400 with nothing written", async () => {
    const p = await product("s400");
    const o = await reopened([plain(p, 10)]);
    const id = o.lineItems[0].id;
    await officeRow(o.id, { id, productId: p }, 10);
    for (const item of [
      { id, action: "CANCEL", deliveredTo: 5 },
      { id, action: "DELETE", deliveredTo: -1 },
      { id, qty: 8, deliveredTo: 0 },
    ])
      await expect(edit(o.id, { replaceAll: false, items: [item] })).rejects.toMatchObject({
        status: 400,
      });
    expect(await stock(p)).toBe(90);
    expect(await ledgerNet(p)).toBe(0);
    expect(Number((await line(o.id)).qty)).toBe(10);
    expect(await audits(o.id)).toHaveLength(0);
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
    // a SUPER_ADMIN token with no tenant context never reaches the lock: the tenant seam refuses it first (403), 0 writes
    await expect(
      orders.updateOrderItems(o.id, { replaceAll: false, items: [{ id, qty: 8 }] }, sa),
    ).rejects.toMatchObject({ status: 403 });
    expect(await stock(p)).toBe(90);
    expect(Number((await line(o.id)).qty)).toBe(10);
    expect(await audits(o.id)).toHaveLength(0);
    // inside a tenant context a SUPER_ADMIN is not a tenant admin: LOCKED ROLE, the same 409, 0 writes
    await expect(
      edit(o.id, { replaceAll: false, items: [{ id, qty: 8 }] }, sa),
    ).rejects.toMatchObject({ status: 409, response: { code: "LINE_ALREADY_DELIVERED" } });
    expect(await stock(p)).toBe(90);
    expect(Number((await line(o.id)).qty)).toBe(10);
    expect(await audits(o.id)).toHaveLength(0);
  });

  // SA-1546 (bb) / A10 10.1: a price is never a delivered statement. A no-row line at column 10 of 12 keeps its column when
  // only the price changes, in BOTH payload shapes (head: 12, the price edit erased the legacy delivered figure).
  it.each([
    ["the bare price shape", (id: string) => ({ id, unitPrice: 2 })],
    [
      "the web shape (held qty carried)",
      (id: string) => ({ id, action: "UPDATE", qty: 12, unitPrice: 2 }),
    ],
  ])(
    "SA-1546 (bb): a price-only edit of a no-row 10/12 line keeps column 10 - %s",
    async (_name, entry) => {
      const p = await product("x-price");
      const o = await reopened([plain(p, 12, 10)]);
      const id = o.lineItems[0].id;
      const before = await stock(p);
      await edit(o.id, { replaceAll: false, items: [entry(id)] });
      const a = await line(o.id);
      expect(Number(a.deliveredQty)).toBe(10); // wrong value: 12 (the head restated the column to the carried qty)
      expect(Number(a.qty)).toBe(12);
      expect(Number(a.unitPrice)).toBe(2);
      expect(await raw.deliveryMutation.count({ where: { orderId: o.id } })).toBe(0);
      expect((await stock(p)) - before).toBe(0);
      const basis = await deliveredBasisByLine(raw as any, o.id);
      expect(billableQtyFromBasis({ id, qty: 12 }, basis)).toBe(12); // a no-row line bills its qty, before and after
      // the audit row of a price edit says the delivered figure did not move
      const rows = await audits(o.id);
      expect(rows).toHaveLength(1);
      const meta = rows[0].meta as any;
      expect(meta.deliveredQty).toEqual({ before: 10, after: 10 });
      expect(meta.unitPrice).toEqual({ before: 1, after: 2 });
      expect(meta.evidenceRows).toEqual([]);
    },
  );

  it("SA-1546 (bb) controls: a qty edit still restates the no-row column (L to 11 gives 11, N to 10 gives 10) and a take-off still zeroes it", async () => {
    const pl = await product("x-l");
    const ol = await reopened([plain(pl, 12, 10)]);
    await edit(ol.id, { replaceAll: false, items: [{ id: ol.lineItems[0].id, qty: 11 }] });
    expect(Number((await line(ol.id)).deliveredQty)).toBe(11);
    const pn = await product("x-n");
    const on = await reopened([plain(pn, 12, 10)]);
    await edit(on.id, { replaceAll: false, items: [{ id: on.lineItems[0].id, qty: 10 }] });
    expect(Number((await line(on.id)).deliveredQty)).toBe(10);
    const pt = await product("x-t");
    const ot = await reopened([plain(pt, 12, 10)]);
    await edit(ot.id, {
      replaceAll: false,
      items: [{ id: ot.lineItems[0].id, action: "CANCEL", deliveredTo: 0 }],
    });
    expect(Number((await line(ot.id)).deliveredQty)).toBe(0);
  });

  it("SA-1536 (y): on a DELIVERED office order an admin's L, N, B1 and take-off are each 409 REOPEN_FIRST, 0 moves", async () => {
    const REOPEN = "Reopen the order to correct delivered items.";
    const cases: Array<{
      name: string;
      q: number;
      d: number;
      rows: boolean;
      item: (id: string) => any;
    }> = [
      { name: "L cut 10/12 to 11", q: 12, d: 10, rows: false, item: (id) => ({ id, qty: 11 }) },
      { name: "N cut 10/12 to 10", q: 12, d: 10, rows: false, item: (id) => ({ id, qty: 10 }) },
      { name: "B1 cut 10/10 to 8", q: 10, d: 10, rows: true, item: (id) => ({ id, qty: 8 }) },
      {
        name: "take-off 10/10",
        q: 10,
        d: 10,
        rows: true,
        item: (id) => ({ id, action: "CANCEL", deliveredTo: 0 }),
      },
    ];
    for (const c of cases) {
      const p = await product("y-" + c.name.slice(0, 2));
      const o = await reopened([plain(p, c.q, c.d)], "DELIVERED");
      const id = o.lineItems[0].id;
      if (c.rows) await officeRow(o.id, { id, productId: p }, c.d);
      const read = async () => ({
        qty: Number((await line(o.id)).qty),
        d: Number((await line(o.id)).deliveredQty),
        status: (await line(o.id)).status,
        rows: await raw.deliveryMutation.count({ where: { orderId: o.id } }),
      });
      const before = await read();
      await expect(edit(o.id, { replaceAll: false, items: [c.item(id)] })).rejects.toMatchObject({
        status: 409,
        response: { message: expect.stringContaining(REOPEN) },
      });
      expect([c.name, await read()]).toEqual([c.name, before]);
      expect(await stock(p)).toBe(90);
      expect(await ledgerNet(p)).toBe(0);
      expect(await audits(o.id)).toHaveLength(0);
    }
  });

  it("SA-1536 (y) E: a raise of a no-row 10/12 line to 14 on a DELIVERED order is accepted: column 14, qty 14, stock -2", async () => {
    const p = await product("y-e");
    const o = await reopened([plain(p, 12, 10)], "DELIVERED");
    const id = o.lineItems[0].id;
    await edit(o.id, { replaceAll: false, items: [{ id, qty: 14 }] });
    const a = await line(o.id);
    expect([Number(a.deliveredQty), Number(a.qty), (await stock(p)) - 90]).toEqual([14, 14, -2]);
  });

  // SA-1536 (z): the route lock reads the ORDER's rows. A pickup-switched order (no run, no stop) with a driver row on a
  // sibling line is a route order: its no-row line answers ROUTE, 409, 0 moves.
  it("SA-1536 (z): a pickup-switched order (links null) with a driver row on a sibling line: the no-row line is LOCKED ROUTE, 0 moves", async () => {
    const a = await product("z-a");
    const b = await product("z-b");
    const o = await reopened([plain(a, 5), plain(b, 10)]);
    const sibling = o.lineItems.find((l) => l.productId === a)!;
    const noRow = o.lineItems.find((l) => l.productId === b)!;
    await raw.deliveryMutation.create({
      data: {
        orderId: o.id,
        orderItemId: sibling.id,
        productId: a,
        driverId,
        type: "PARTIAL",
        quantityDelivered: 5,
        tenantId,
      },
    });
    const head = await raw.order.findUniqueOrThrow({ where: { id: o.id } });
    expect([head.routeRunId, head.routeRunStopId]).toEqual([null, null]);
    await expect(
      edit(o.id, { replaceAll: false, items: [{ id: noRow.id, qty: 8 }] }),
    ).rejects.toMatchObject({
      status: 409,
      response: {
        code: "LINE_ALREADY_DELIVERED",
        message: expect.stringContaining("A driver delivered this item."),
      },
    });
    expect(Number((await raw.orderItem.findUniqueOrThrow({ where: { id: noRow.id } })).qty)).toBe(
      10,
    );
    expect(await stock(b)).toBe(90);
    expect(await ledgerNet(b)).toBe(0);
    expect(await audits(o.id)).toHaveLength(0);
  });

  // SA-1544 (az) / L-4: the route lock reads the order's rows by orderId, the grouped per-line reader dropped a row with no line.
  it("SA-1544 (az): a driver row with NO line id still makes the order a route order: the no-row line is LOCKED ROUTE, 0 moves", async () => {
    const a = await product("az-a");
    const o = await reopened([plain(a, 10)]);
    const noRow = o.lineItems.find((l) => l.productId === a)!;
    await raw.deliveryMutation.create({
      data: {
        orderId: o.id,
        orderItemId: null,
        productId: a,
        driverId,
        type: "PARTIAL",
        quantityDelivered: 5,
        tenantId,
      },
    });
    await expect(
      edit(o.id, { replaceAll: false, items: [{ id: noRow.id, qty: 8 }] }),
    ).rejects.toMatchObject({
      status: 409,
      response: {
        code: "LINE_ALREADY_DELIVERED",
        message: expect.stringContaining("A driver delivered this item."),
      },
    });
    expect(Number((await raw.orderItem.findUniqueOrThrow({ where: { id: noRow.id } })).qty)).toBe(
      10,
    );
    expect(await stock(a)).toBe(90);
  });

  // SA-1546 (be) / A10 10.4: the at-door change-request merge writes ADD_ON rows with a driver set and no delivered quantity.
  // Such a row is not evidence, but a driver changed this order at the door: a route order, the lock fails closed.
  it("SA-1546 (be): a driver ADD_ON row (null quantityDelivered) on a sibling line of a released-link order locks the no-row line ROUTE, 0 moves", async () => {
    const a = await product("be-a");
    const b = await product("be-b");
    const o = await reopened([plain(a, 5, 0), plain(b, 10)]);
    const sibling = o.lineItems.find((l) => l.productId === a)!;
    const noRow = o.lineItems.find((l) => l.productId === b)!;
    await raw.deliveryMutation.create({
      data: {
        orderId: o.id,
        orderItemId: sibling.id,
        productId: a,
        driverId,
        type: "ADD_ON",
        quantityDelivered: null,
        tenantId,
      },
    });
    const head = await raw.order.findUniqueOrThrow({ where: { id: o.id } });
    expect([head.routeRunId, head.routeRunStopId]).toEqual([null, null]); // the links are released
    await expect(
      edit(o.id, { replaceAll: false, items: [{ id: noRow.id, qty: 8 }] }),
    ).rejects.toMatchObject({
      status: 409,
      response: {
        code: "LINE_ALREADY_DELIVERED",
        message: expect.stringContaining("A driver delivered this item."),
      },
    }); // wrong value: accepted (the head filtered the row out as not evidence)
    expect(Number((await raw.orderItem.findUniqueOrThrow({ where: { id: noRow.id } })).qty)).toBe(
      10,
    );
    expect(await stock(b)).toBe(90);
    expect(await ledgerNet(b)).toBe(0);
    expect(await audits(o.id)).toHaveLength(0);
  });

  it("SA-1544 (az) control: an OFFICE row with no line id does not lock the order (office orders stay correctable)", async () => {
    const a = await product("az-c");
    const o = await reopened([plain(a, 10)]);
    const noRow = o.lineItems.find((l) => l.productId === a)!;
    await raw.deliveryMutation.create({
      data: {
        orderId: o.id,
        orderItemId: null,
        productId: a,
        routeRunStopId: null,
        driverId: null,
        type: "DELIVERED",
        quantityDelivered: 3,
        note: "OFFICE_MARKED",
        tenantId,
      },
    });
    await edit(o.id, { replaceAll: false, items: [{ id: noRow.id, qty: 8 }] });
    expect(Number((await raw.orderItem.findUniqueOrThrow({ where: { id: noRow.id } })).qty)).toBe(
      8,
    );
  });

  // LOW-b: on a route order WITH rows master's own guards judge the edit: a raise, a cut at or above delivered and a price
  // change pass as master (column untouched, no row written, no correction audit row).
  it("SA-1536 (z) LOW-b: on a route order with rows a raise, a cut at or above delivered and a price change pass as master", async () => {
    const edits: Array<{ name: string; item: (id: string) => any; qty: number; price: number }> = [
      { name: "raise", item: (id) => ({ id, qty: 14 }), qty: 14, price: 1 },
      { name: "cut at delivered", item: (id) => ({ id, qty: 10 }), qty: 10, price: 1 },
      { name: "price", item: (id) => ({ id, qty: 12, unitPrice: 2 }), qty: 12, price: 2 },
    ];
    for (const e of edits) {
      const p = await product("zb-" + e.name.slice(0, 3));
      const o = await reopened([plain(p, 12, 10)]);
      const id = o.lineItems[0].id;
      const stopId = await completedStop();
      await raw.order.update({ where: { id: o.id }, data: { routeRunStopId: stopId } });
      await raw.deliveryMutation.create({
        data: {
          orderId: o.id,
          orderItemId: id,
          productId: p,
          routeRunStopId: stopId,
          driverId,
          type: "PARTIAL",
          quantityDelivered: 10,
          tenantId,
        },
      });
      await edit(o.id, { replaceAll: false, items: [e.item(id)] });
      const after = await line(o.id);
      expect([
        e.name,
        Number(after.qty),
        Number(after.unitPrice),
        Number(after.deliveredQty),
      ]).toEqual([e.name, e.qty, e.price, 10]);
      expect(await raw.deliveryMutation.count({ where: { orderId: o.id } })).toBe(1);
      expect(await audits(o.id)).toHaveLength(0);
    }
  });

  // SA-1536 (aa): a take-off is accepted ONLY with deliveredTo === 0; absent and null are master's removal 409, 0 moves.
  it("SA-1536 (aa): a take-off with deliveredTo absent or null is refused (master's removal 409), 0 moves", async () => {
    for (const extra of [{}, { deliveredTo: null }]) {
      const p = await product("aa-" + Object.keys(extra).length);
      const o = await reopened([plain(p, 10)]);
      const id = o.lineItems[0].id;
      await officeRow(o.id, { id, productId: p }, 10);
      await expect(
        edit(o.id, { replaceAll: false, items: [{ id, action: "CANCEL", ...extra }] }),
      ).rejects.toMatchObject({
        status: 409,
        response: { code: "LINE_ALREADY_DELIVERED", message: DELIVERED_LINE_REMOVED_MESSAGE },
      });
      expect(await stock(p)).toBe(90);
      expect(await ledgerNet(p)).toBe(0);
      expect(await officeSum(o.id)).toBe(10);
      expect((await line(o.id)).status).toBe("PENDING");
      expect(await audits(o.id)).toHaveLength(0);
    }
  });

  // SA-1536 (ad): the price-only entry is applied, never accepted and ignored.
  it("SA-1536 (ad): a price-only edit of a delivered office line applies the price (not accepted-and-ignored)", async () => {
    const p = await product("ad");
    const o = await reopened([plain(p, 10)]);
    const id = o.lineItems[0].id;
    await officeRow(o.id, { id, productId: p }, 10);
    await edit(o.id, { replaceAll: false, items: [{ id, action: "UPDATE", unitPrice: 2 }] });
    const a = await line(o.id);
    expect(Number(a.unitPrice)).toBe(2); // wrong value: 1 (accepted, the price dropped)
    expect(Number(a.qty)).toBe(10);
    expect(Number(a.deliveredQty)).toBe(10);
    expect(Number(a.subtotal)).toBe(20);
    expect(await stock(p)).toBe(90);
  });

  // SA-1536 (ae), §8.8 / P-2: every sender of a FULL list (a replace) meets 409 LINES_REPLACE_AFTER_DELIVERY, 0 moves, on a
  // reopened order that holds a delivered line. The buyer (M1-5, B9), the driver (D2-15) and the operator (D2-13) are pinned in
  // w946r-merge-delivered, w946r-qty-floor and buyer-edit-input; the two tenant senders are here.
  it("SA-1536 (ae): an OPERATOR's and a TENANT_ADMIN's replace-all on a reopened order with a delivered line is 409 LINES_REPLACE_AFTER_DELIVERY, 0 moves", async () => {
    for (const who of [operator(), admin()]) {
      const p = await product("ae-" + who.role.slice(0, 3));
      const o = await reopened([plain(p, 10)]);
      const id = o.lineItems[0].id;
      await officeRow(o.id, { id, productId: p }, 10);
      const rows = await raw.deliveryMutation.count({ where: { orderId: o.id } });
      await expect(
        edit(o.id, { replaceAll: true, items: [{ productId: p, qty: 6, unitPrice: "1.00" }] }, who),
      ).rejects.toMatchObject({
        status: 409,
        response: { code: "LINES_REPLACE_AFTER_DELIVERY" },
      });
      expect([
        who.role,
        Number((await line(o.id)).qty),
        Number((await line(o.id)).deliveredQty),
      ]).toEqual([who.role, 10, 10]);
      expect(await raw.deliveryMutation.count({ where: { orderId: o.id } })).toBe(rows);
      expect(await stock(p)).toBe(90);
      expect(await audits(o.id)).toHaveLength(0);
    }
  });

  it("P-3b: the office row a correction writes carries the order's tenantId", async () => {
    const p = await product("p3b");
    const o = await reopened([plain(p, 12, 8)]);
    const id = o.lineItems[0].id;
    await raw.$transaction((tx) =>
      restateLineEvidence(
        tx,
        { orderId: o.id, tenantId: o.tenantId, evidence: [] },
        { id, productId: p },
        8,
        "NONE",
        12,
      ),
    );
    const row = await raw.deliveryMutation.findFirstOrThrow({ where: { orderId: o.id } });
    expect(row.tenantId).toBe(o.tenantId);
  });

  it("P-3: an office row is never written without the order's tenantId (explicit tenantId, 0 rows)", async () => {
    const p = await product("p3");
    const o = await reopened([plain(p, 12)]);
    const id = o.lineItems[0].id;
    await expect(
      raw.$transaction((tx) =>
        restateLineEvidence(
          tx,
          { orderId: o.id, tenantId: null, evidence: [] },
          { id, productId: p },
          8,
          "NONE",
          12,
        ),
      ),
    ).rejects.toThrow(/tenantId/);
    expect(await raw.deliveryMutation.count({ where: { orderId: o.id } })).toBe(0);
    await raw.$transaction((tx) =>
      restateLineEvidence(
        tx,
        { orderId: o.id, tenantId, evidence: [] },
        { id, productId: p },
        8,
        "NONE",
        12,
      ),
    );
    const row = await raw.deliveryMutation.findFirstOrThrow({ where: { orderId: o.id } });
    expect(row.tenantId).toBe(tenantId);
  });

  it("R4-L pin (SA-1525 l): the M-1 office row makes a replace-all of the DELIVERED order answer ORDER_EDIT_NEEDS_LINE_IDS, rows kept", async () => {
    const p = await product("r4l");
    const o = await reopened([plain(p, 12)]);
    const id = o.lineItems[0].id;
    await raw.$transaction(async (tx) => {
      await tx.orderItem.update({ where: { id }, data: { deliveredQty: 8 } });
      await restateLineEvidence(
        tx,
        { orderId: o.id, tenantId, evidence: [] },
        { id, productId: p },
        8,
        "NONE",
        12,
      );
    });
    expect(await raw.deliveryMutation.count({ where: { orderId: o.id } })).toBe(1);
    await raw.order.update({ where: { id: o.id }, data: { status: "DELIVERED" as any } });
    // the request path answers LINES_REPLACE_AFTER_DELIVERY first; the net under it is the carry capture
    await expect(
      raw.$transaction((tx) =>
        captureRecreatedCarry(tx, o.id, [{ id, productId: p, qty: 12, deliveredQty: 8 }]),
      ),
    ).rejects.toMatchObject({ status: 409, response: { code: "ORDER_EDIT_NEEDS_LINE_IDS" } });
    expect(await raw.deliveryMutation.count({ where: { orderId: o.id } })).toBe(1);
    expect(Number((await line(o.id)).deliveredQty)).toBe(8);
  });

  async function completedStop() {
    const route = await raw.route.create({
      data: { name: `a5 route ${run}-${stopIds.length}`, tenantId } as any,
    });
    const routeStop = await raw.routeStop.create({
      data: { tenantId, routeId: route.id, stopNumber: 1, customerId } as any,
    });
    const rr = await raw.routeRun.create({
      data: {
        tenantId,
        routeId: route.id,
        scheduledDate: new Date("2026-09-27T00:00:00.000Z"),
        status: "COMPLETED" as any,
        driverId,
      },
    });
    const stop = await raw.routeRunStop.create({
      data: {
        tenantId,
        routeRunId: rr.id,
        routeStopId: routeStop.id,
        stopNumber: 1,
        status: "COMPLETED" as any,
      } as any,
    });
    stopIds.push({ route: route.id, routeStop: routeStop.id, run: rr.id, stop: stop.id });
    return stop.id;
  }

  it("R4-I2 (SA-1525 i, restated by SA-1533 (r)): a stop-linked order never gets a stop-less office row: master judges the edit, a take-off is the ROUTE 409", async () => {
    const p = await product("r4i2");
    const o = await reopened([plain(p, 12, 8)]);
    const id = o.lineItems[0].id;
    const stopId = await completedStop();
    await raw.order.update({ where: { id: o.id }, data: { routeRunStopId: stopId } });
    // SA-1533 (r): every line of a run order is LOCKED ROUTE, so master's own guards judge it (PR-1a changes nothing here):
    // a cut or raise that stays at or above what was delivered is master's plain edit (column 8 untouched, no row, no
    // correction, no audit row); a take-off is master's removal 409, with the ROUTE sentence, even with deliveredTo 0.
    for (const qty of [11, 13]) {
      await edit(o.id, { replaceAll: false, items: [{ id, qty }] });
      expect(Number((await line(o.id)).qty)).toBe(qty);
      expect(Number((await line(o.id)).deliveredQty)).toBe(8);
      expect(await raw.deliveryMutation.count({ where: { orderId: o.id } })).toBe(0);
      expect(await audits(o.id)).toHaveLength(0);
    }
    const mid = await stock(p);
    for (const item of [
      { id, action: "CANCEL", deliveredTo: 0 },
      { id, action: "CANCEL" },
    ])
      await expect(edit(o.id, { replaceAll: false, items: [item] })).rejects.toMatchObject({
        status: 409,
        response: {
          code: "LINE_ALREADY_DELIVERED",
          message: expect.stringContaining("A driver delivered this item."),
        },
      });
    expect(await raw.deliveryMutation.count({ where: { orderId: o.id } })).toBe(0);
    expect((await line(o.id)).status).toBe("PENDING");
    expect(await stock(p)).toBe(mid);
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
