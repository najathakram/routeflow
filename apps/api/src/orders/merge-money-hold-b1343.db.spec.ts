/**
 * B1343 (SA-1330 + Amendment 1): an order that holds money is never a merge participant. An order with any
 * OrderCreditNote row (a credit intent) is kept out of both merge kinds; for `force`, an order whose DRAFT invoice
 * holds ANY InvoicePayment row (any method, any status, VOID included) is kept out too. Before the fix the loser's
 * draft was deleted under RESTRICT payments (a 500 that rolled the consolidate back) or its intent cascaded away.
 * `forceConsolidateCustomer` reports who was kept out through `opts.onKeptSeparate` (MONEY_ON_ORDER / MULTI_DRAFT).
 *
 * Runs only under `npm run local:test:db`. The tenant is a throwaway `qa-b1343-<run>` slug.
 */

import { randomUUID } from "crypto";
import { PrismaClient } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import { Pool } from "pg";
import { Logger } from "@nestjs/common";
import { describeDb, requireLocalDatabaseUrl } from "../common/testing/db-spec";
import { _resetLockPoolForTests } from "../common/db-locks";
import { PrismaService } from "../prisma/prisma.service";
import { TenantContextService } from "../tenant/tenant-context.service";
import { EncryptionService } from "../common/encryption.service";
import { SystemConfigService } from "../system-config/system-config.service";
import { OrdersService } from "./orders.service";
import type { JwtPayload } from "../auth/jwt-payload.interface";
import { INVOICE_EDIT_STUBS } from "./testing/invoice-edit-stubs";
import { RegulatedLedgerService } from "../regulated/regulated-ledger.service";
import { readMergeGroup } from "./merge-lock-recheck";

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { assertTestTenant } = require("../../../../scripts/lib/test-tenants.cjs");

type KeptSeparate = Array<{
  orderId: string;
  orderNumber: string | null;
  reason: "MONEY_ON_ORDER" | "MULTI_DRAFT";
}>;

describeDb("B1343: an order holding money is never merged (real Postgres)", () => {
  let pool: Pool;
  let raw: PrismaClient;
  let prisma: PrismaService;
  let tenantCtx: TenantContextService;
  let orders: any;
  const run = randomUUID().slice(0, 8);
  const slug = assertTestTenant(`qa-b1343-${run}`, "merge-money-hold-b1343.db.spec.ts");
  let tenantId = "";
  let operatorUserId = "";
  let customerId = "";
  let productId = "";
  let seq = 0;
  const warn = jest.spyOn(Logger.prototype, "warn");

  const operator = (): JwtPayload =>
    ({
      sub: operatorUserId,
      username: `op-${run}`,
      role: "OPERATOR",
      status: "ACTIVE",
      forcePasswordChange: false,
      tenantId,
      tenantSlug: slug,
    }) as JwtPayload;

  const inTenant = <T>(fn: () => Promise<T>) => tenantCtx.run(tenantId, fn);

  /** A real staff create (PENDING); created in call order, so the first call is the OLDER (loser) order. */
  const createOrder = async (qty: number) => {
    const created: any = await inTenant(() =>
      orders.create({ customerId, items: [{ productId, qty }] }, operator(), {
        skipAutoMerge: true,
      }),
    );
    await raw.orderItem.updateMany({ where: { orderId: created.id }, data: { deliveredQty: 0 } });
    await raw.order.update({ where: { id: created.id }, data: { skipAutoMerge: false } });
    return created.id as string;
  };

  /** An open DRAFT invoice for `orderId` with one plain line (no regulated ledger rows). */
  async function draftFor(orderId: string, qty = 1) {
    const line = await raw.orderItem.findFirstOrThrow({ where: { orderId } });
    seq += 1;
    const inv = await raw.invoice.create({
      data: {
        tenantId,
        customerId,
        orderId,
        invoiceNumber: `INV-b1343-${run}-${seq}`,
        status: "DRAFT",
        subtotal: qty,
        taxAmount: 0,
        total: qty,
      },
    });
    await raw.invoiceItem.create({
      data: {
        tenantId,
        invoiceId: inv.id,
        orderItemId: line.id,
        productId,
        description: "item",
        qty,
        unitPrice: 1,
        subtotal: qty,
      },
    });
    return inv.id;
  }

  async function payment(
    invoiceId: string,
    data: { method: "CASH" | "CREDIT_NOTE"; status?: "PAID" | "VOID"; creditNoteId?: string },
  ) {
    return raw.invoicePayment.create({
      data: {
        tenantId,
        invoiceId,
        amount: "5.00",
        method: data.method,
        status: data.status ?? "PAID",
        creditNoteId: data.creditNoteId ?? null,
      },
    });
  }

  async function creditNote(amountUsed: string) {
    seq += 1;
    return raw.creditNote.create({
      data: {
        tenantId,
        customerId,
        creditNoteNumber: `CN-b1343-${run}-${seq}`,
        amount: "5.00",
        amountUsed,
      },
    });
  }

  const intent = (orderId: string, creditNoteId: string) =>
    raw.orderCreditNote.create({ data: { tenantId, orderId, creditNoteId, amount: "5.00" } });

  const force = async () => {
    let captured: KeptSeparate | undefined;
    await inTenant(() =>
      orders.forceConsolidateCustomer(customerId, {
        onKeptSeparate: (rows: KeptSeparate) => {
          captured = rows;
        },
      }),
    );
    return captured;
  };
  const forceGroupIds = async () =>
    (await inTenant(() => readMergeGroup(prisma.forTenant(), customerId, "force"))).group.map(
      (o: any) => o.id as string,
    );
  const orderIds = async () =>
    (await raw.order.findMany({ where: { tenantId }, select: { id: true } })).map((o) => o.id);

  async function wipe() {
    await raw.changeRequest.deleteMany({ where: { tenantId } });
    await raw.deliveryMutation.deleteMany({ where: { tenantId } });
    await raw.orderIdempotencyKey.deleteMany({ where: { tenantId } });
    const ids = (await raw.order.findMany({ where: { tenantId }, select: { id: true } })).map(
      (o) => o.id,
    );
    await (raw as any).orderRevision?.deleteMany?.({ where: { orderId: { in: ids } } });
    await raw.stockMovement.deleteMany({ where: { product: { tenantId } } });
    await raw.orderCreditNote.deleteMany({ where: { tenantId } });
    await raw.invoicePayment.deleteMany({ where: { invoice: { tenantId } } });
    await raw.creditNote.deleteMany({ where: { tenantId } });
    await raw.invoiceItem.deleteMany({ where: { invoice: { tenantId } } });
    await raw.invoice.deleteMany({ where: { tenantId } });
    await raw.orderItem.deleteMany({ where: { tenantId } });
    await raw.order.deleteMany({ where: { tenantId } });
  }

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
      gateway: {
        emitOrderCreated: jest.fn(),
        emitUrgentOrder: jest.fn(),
        emitOrderStatusChanged: jest.fn(),
        emitLowStock: jest.fn(),
      },
      notifications: {
        sendToCustomer: jest.fn().mockResolvedValue(undefined),
        sendToUser: jest.fn().mockResolvedValue(1),
      },
      messaging: { notifyEvent: jest.fn().mockResolvedValue(undefined) },
      systemConfig,
      entitlements: { hasFlag: async () => true },
      sellingRestrictions: {
        getPolicy: async () => ({ enabled: false, addressPrecedence: "BILLING_FIRST" }),
        assertLinesSellable: async () => undefined,
      },
      authGuard: { assertAuthorizedOrThrow: async () => undefined },
      promotionsService: { activeForCatalog: async () => [] },
      tenantCtx,
      ledger: new RegulatedLedgerService(prisma),
      invoicesService: {
        // the merge deletes the loser's open DRAFT mirror it finds here: the REAL lookup.
        findOpenOrderDraft: async (orderId: string, tx?: any) =>
          (tx ?? prisma.forTenant()).invoice.findFirst({
            where: { orderId, status: "DRAFT", deliveryBatchId: null },
            orderBy: { createdAt: "asc" },
          }),
        revertLinkedInvoicesForOrderEdit: async () => undefined,
        resyncOrderInvoicesForEdit: async () => [],
        ...INVOICE_EDIT_STUBS,
        reconcileOrderDraftInvoice: async () => undefined,
        releaseWalletPaymentsInTx: async () => undefined,
        voidInvoiceInTx: async () => undefined,
      },
      creditNotes: {
        settleOrderCreditsInTx: async () => ({ applied: 0, unapplied: 0 }),
        previewOrderCreditRelease: async () => [],
        releaseOrderCreditsInTx: async () => undefined,
      },
      logger: new Logger(OrdersService.name),
      inlineReturns: {},
      oversellReader: { read: async () => false },
    });

    tenantId = (await raw.tenant.create({ data: { slug, name: `B1343 ${slug}` } })).id;
    operatorUserId = (
      await raw.user.create({
        data: {
          email: `op-${run}@example.test`,
          username: `op-${run}`,
          role: "OPERATOR",
          tenantId,
        },
      })
    ).id;
    const buyer = await raw.user.create({
      data: {
        email: `buyer-${run}@example.test`,
        username: `buyer-${run}`,
        role: "CUSTOMER",
        tenantId,
      },
    });
    customerId = (
      await raw.customer.create({
        data: { userId: buyer.id, businessName: "Acme Retail", contactName: "Tester", tenantId },
      })
    ).id;
    productId = (
      await raw.product.create({
        data: {
          name: `Widget ${run}`,
          unit: "each",
          pricePerUnit: "1.00",
          currentStock: 1000,
          tenantId,
        },
      })
    ).id;
  }, 120_000);

  beforeEach(async () => {
    warn.mockClear();
    await wipe();
    await raw.product.update({ where: { id: productId }, data: { currentStock: 1000 } });
  });

  afterAll(async () => {
    try {
      await wipe();
      await raw.auditLog.deleteMany({ where: { tenantId } });
      await raw.productUnit.deleteMany({ where: { tenantId } });
      await raw.product.deleteMany({ where: { tenantId } });
      await raw.customer.deleteMany({ where: { tenantId } });
      await raw.user.deleteMany({ where: { tenantId } });
      await raw.tenant.deleteMany({ where: { id: tenantId } });
    } finally {
      warn.mockRestore();
      await _resetLockPoolForTests();
      await prisma?.$disconnect();
      await raw?.$disconnect();
      await pool?.end();
    }
  }, 120_000);

  it("1: force, the loser's DRAFT holds a live CASH 5.00 payment: kept out, nothing merged (master: loser in the group, 500 on the RESTRICT FK)", async () => {
    const held = await createOrder(10);
    const other = await createOrder(14);
    const draft = await draftFor(held, 10);
    const pay = await payment(draft, { method: "CASH" });

    expect(await forceGroupIds()).not.toContain(held);
    await force();

    expect((await orderIds()).sort()).toEqual([held, other].sort());
    expect(await raw.invoice.findUnique({ where: { id: draft } })).not.toBeNull();
    const row = await raw.invoicePayment.findUnique({ where: { id: pay.id } });
    expect(row).not.toBeNull();
    expect(Number(row!.amount)).toBe(5);
  }, 120_000);

  it("2: force, the loser's DRAFT holds only a settle-adjusted CREDIT_NOTE payment with its intent: kept out, credit untouched (master: in the group, then a 500)", async () => {
    const held = await createOrder(10);
    const other = await createOrder(14);
    const draft = await draftFor(held, 10);
    const cn = await creditNote("5.00");
    const pay = await payment(draft, { method: "CREDIT_NOTE", creditNoteId: cn.id });
    const link = await intent(held, cn.id);

    expect(await forceGroupIds()).not.toContain(held);
    await force();

    expect((await orderIds()).sort()).toEqual([held, other].sort());
    const note = await raw.creditNote.findUniqueOrThrow({ where: { id: cn.id } });
    expect(Number(note.amountUsed)).toBe(5);
    expect(await raw.invoicePayment.findUnique({ where: { id: pay.id } })).not.toBeNull();
    expect(await raw.orderCreditNote.findUnique({ where: { id: link.id } })).not.toBeNull();
  }, 120_000);

  it("3: force, the loser's DRAFT holds only a VOID cash row: kept out (master: in the group, then a 500)", async () => {
    const held = await createOrder(10);
    const other = await createOrder(14);
    const draft = await draftFor(held, 10);
    const pay = await payment(draft, { method: "CASH", status: "VOID" });

    expect(await forceGroupIds()).not.toContain(held);
    await force();

    expect((await orderIds()).sort()).toEqual([held, other].sort());
    expect(await raw.invoicePayment.findUnique({ where: { id: pay.id } })).not.toBeNull();
  }, 120_000);

  it("4: force, the loser has a credit intent and NO invoice: kept out, intent survives (master: merged, the intent cascaded away)", async () => {
    const held = await createOrder(10);
    const other = await createOrder(14);
    const cn = await creditNote("0");
    const link = await intent(held, cn.id);

    expect(await forceGroupIds()).not.toContain(held);
    await force();

    expect((await orderIds()).sort()).toEqual([held, other].sort());
    expect(await raw.orderCreditNote.findUnique({ where: { id: link.id } })).not.toBeNull();
  }, 120_000);

  it("5: auto sweep, an order with a credit intent and no invoice is neither winner nor loser (master: folded, the intent gone)", async () => {
    const held = await createOrder(10);
    const fresh = await createOrder(14);
    const cn = await creditNote("0");
    const link = await intent(held, cn.id);

    await inTenant(() => orders.mergeAllPendingForCustomer(customerId, { focusOrderId: fresh }));

    expect((await orderIds()).sort()).toEqual([held, fresh].sort());
    expect(await raw.orderCreditNote.findUnique({ where: { id: link.id } })).not.toBeNull();
  }, 120_000);

  it("6a: an unpaid DRAFT-mirror loser still merges and its draft is removed (B214; green on master too)", async () => {
    const older = await createOrder(10);
    await createOrder(14);
    const draft = await draftFor(older, 10);

    await force();

    expect(await orderIds()).toHaveLength(1);
    expect(await raw.invoice.findUnique({ where: { id: draft } })).toBeNull();
  }, 120_000);

  it("6b: two plain pending orders still merge into one (green on master too)", async () => {
    await createOrder(10);
    await createOrder(14);

    await force();

    expect(await orderIds()).toHaveLength(1);
  }, 120_000);

  it("8: force, loser held by a live CASH payment: onKeptSeparate gets MONEY_ON_ORDER, the winner is unchanged (master: never called)", async () => {
    const held = await createOrder(10);
    const winner = await createOrder(14);
    await payment(await draftFor(held, 10), { method: "CASH" });
    const heldRow = await raw.order.findUniqueOrThrow({ where: { id: held } });
    const lines = () =>
      raw.orderItem.findMany({
        where: { orderId: winner },
        orderBy: { id: "asc" },
        select: { id: true, productId: true, qty: true },
      });
    const before = await lines();

    const captured = await force();

    expect(captured).toEqual([
      { orderId: held, orderNumber: heldRow.orderNumber, reason: "MONEY_ON_ORDER" },
    ]);
    expect(await lines()).toEqual(before);
  }, 120_000);

  it("9: force, loser held by a credit intent and no invoice: MONEY_ON_ORDER (master: none)", async () => {
    const held = await createOrder(10);
    await createOrder(14);
    await intent(held, (await creditNote("0")).id);
    const heldRow = await raw.order.findUniqueOrThrow({ where: { id: held } });

    const captured = await force();

    expect(captured).toEqual([
      { orderId: held, orderNumber: heldRow.orderNumber, reason: "MONEY_ON_ORDER" },
    ]);
  }, 120_000);

  it("10: force, loser with TWO DRAFT invoices and no payments: MULTI_DRAFT (master: none)", async () => {
    const multi = await createOrder(10);
    await createOrder(14);
    await draftFor(multi, 5);
    await draftFor(multi, 5);
    const multiRow = await raw.order.findUniqueOrThrow({ where: { id: multi } });

    const captured = await force();

    expect(captured).toEqual([
      { orderId: multi, orderNumber: multiRow.orderNumber, reason: "MULTI_DRAFT" },
    ]);
  }, 120_000);

  it("11: force, two plain pending orders: nothing kept out ([]) and the merge happened", async () => {
    await createOrder(10);
    await createOrder(14);

    const captured = await force();

    expect(captured ?? []).toEqual([]);
    expect(await orderIds()).toHaveLength(1);
  }, 120_000);
});
