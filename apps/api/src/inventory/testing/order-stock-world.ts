/**
 * Shared fixture for the W1 order-stock db specs (O5, O6, O7, D6): a throwaway `qa-*` test tenant, a
 * REAL OrdersService (Object.create, no Nest DI, as order-cancel-tx.db.spec.ts and b1050-delivered-edit
 * .db.spec.ts do) over a REAL connected PrismaService, and ledger-consistent stock fixtures:
 * a product opens with N pieces (counter N + one OPENING movement), and `bookOrder` seeds an order the
 * way create() leaves it - lines in, counter down by the quantity, one SALE movement with stockAfter.
 * Every spec ends with `expectLedgerConsistent` (X1). Lives under `testing/`, never in the build.
 */
import { randomUUID } from "crypto";
import { Logger } from "@nestjs/common";
import { PrismaService } from "../../prisma/prisma.service";
import { TenantContextService } from "../../tenant/tenant-context.service";
import { CreditNotesService } from "../../credit-notes/credit-notes.service";
import { InvoicesService } from "../../invoices/invoices.service";
import { OrdersService } from "../../orders/orders.service";
import { INVOICE_EDIT_STUBS } from "../../orders/testing/invoice-edit-stubs";
import { requireLocalDatabaseUrl } from "../../common/testing/db-spec";
import { endLedgerHelperPool, seedOpeningRow } from "./ledger-consistency";
import { Pool } from "pg";

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { assertTestTenant } = require("../../../../../scripts/lib/test-tenants.cjs");

export interface BookedLine {
  productId: string;
  qty: number;
}

export async function buildOrderStockWorld(label: string, specFile: string) {
  const run = randomUUID().slice(0, 8);
  const slug = assertTestTenant(`qa-${label}-${run}`, specFile);
  const url = requireLocalDatabaseUrl();
  const pool = new Pool({ connectionString: url });
  const tenantCtx = new TenantContextService();
  const prisma = new PrismaService(tenantCtx);
  await prisma.$connect();

  const anyMethod = new Proxy(
    {},
    { get: (_t, prop) => (prop === "then" || typeof prop === "symbol" ? undefined : jest.fn()) },
  );
  const quiet = new Proxy(
    {},
    {
      get: (_t, prop) =>
        prop === "then" || typeof prop === "symbol" ? undefined : async () => undefined,
    },
  );
  const creditNotes = new CreditNotesService(
    prisma,
    anyMethod as any,
    anyMethod as any,
    { syncInvoiceCommissionSafe: async () => undefined } as any,
    anyMethod as any,
  );
  const invoices = Object.assign(Object.create(InvoicesService.prototype), {
    prisma,
    creditNotes,
    ledger: anyMethod,
    gateway: anyMethod,
    commissionEngine: anyMethod,
    logger: new Logger(`${label}-invoices`),
    ...INVOICE_EDIT_STUBS,
    revertLinkedInvoicesForOrderEdit: async () => undefined,
    resyncOrderInvoicesForEdit: async () => [],
    reconcileOrderDraftInvoice: async () => undefined,
  });
  const orders: any = Object.assign(Object.create(OrdersService.prototype), {
    prisma,
    creditNotes,
    invoicesService: invoices,
    gateway: anyMethod,
    ledger: anyMethod,
    commissionEngine: anyMethod,
    authGuard: { assertAuthorizedOrThrow: async () => undefined },
    sellingRestrictions: {
      getPolicy: async () => ({ enabled: false, addressPrecedence: "BILLING_FIRST" }),
      assertLinesSellable: async () => undefined,
    },
    promotionsService: { activeForCatalog: async () => [] },
    entitlements: { hasFlag: async () => true },
    systemConfig: { get: async () => null, getAll: async () => ({}) },
    notifications: quiet,
    messaging: quiet,
    tenantCtx,
    inlineReturns: {},
    logger: new Logger(`${label}-orders`),
  });

  const tenantId = (await prisma.tenant.create({ data: { slug, name: `${label} ${slug}` } })).id;
  const user = await prisma.user.create({
    data: { email: `${slug}@example.invalid`, username: slug, role: "OPERATOR", tenantId },
  });
  const customer = await prisma.customer.create({
    data: { userId: user.id, businessName: `c ${label}`, contactName: `c ${label}`, tenantId },
  });
  const jwt = {
    sub: user.id,
    username: slug,
    role: "OPERATOR" as any,
    status: "ACTIVE" as any,
    forcePasswordChange: false,
    tenantId,
    tenantSlug: slug,
  };
  const productIds: string[] = [];
  const orderIds: string[] = [];
  let seq = 0;

  /** A product that opened with `opening` pieces: counter = opening, one OPENING movement. */
  async function product(tag: string, opening: number): Promise<string> {
    const p = await prisma.product.create({
      data: {
        tenantId,
        name: `${tag} ${slug}`,
        unit: "each",
        pricePerUnit: 5,
        currentStock: opening,
      },
    });
    productIds.push(p.id);
    await seedOpeningRow(pool as any, tenantId, p.id, opening);
    return p.id;
  }

  /**
   * An order in `status` with live lines, booked the way create() leaves a live order: the counter is
   * already down by each line's qty and one SALE movement (notes CREATE, stockAfter) says so.
   * `cancelled: true` also marks the lines CANCELLED and credits the qty back (a F07 office cancel).
   */
  async function bookOrder(opts: { status: string; lines: BookedLine[]; cancelled?: boolean }) {
    seq += 1;
    const order = await prisma.order.create({
      data: {
        tenantId,
        customerId: customer.id,
        orderNumber: `ORD-${label.toUpperCase()}-${run}-${seq}`,
        subtotal: 0,
        tax: 0,
        total: 0,
        status: opts.status,
      } as any,
    });
    orderIds.push(order.id);
    const items = [];
    for (const l of opts.lines) {
      items.push(
        await prisma.orderItem.create({
          data: {
            tenantId,
            orderId: order.id,
            productId: l.productId,
            name: `line ${l.productId.slice(0, 4)}`,
            qty: l.qty,
            unitPrice: 5,
            subtotal: l.qty * 5,
            ...(opts.cancelled ? { status: "CANCELLED" } : {}),
          } as any,
        }),
      );
      // create() booked it: counter -qty, one SALE row. A cancelled order was then credited back: +qty, one CANCEL row.
      const afterSale = Number(await stockOf(l.productId)) - l.qty;
      await prisma.product.update({
        where: { id: l.productId },
        data: { currentStock: afterSale },
      });
      await prisma.stockMovement.create({
        data: {
          tenantId,
          productId: l.productId,
          type: "SALE",
          quantity: -l.qty,
          stockAfter: afterSale,
          notes: "CREATE",
          reference: order.id,
          effectiveAt: new Date(Date.now() - 30 * 60_000),
          createdAt: new Date(Date.now() - 30 * 60_000),
        },
      });
      if (opts.cancelled) {
        await prisma.product.update({
          where: { id: l.productId },
          data: { currentStock: afterSale + l.qty },
        });
        await prisma.stockMovement.create({
          data: {
            tenantId,
            productId: l.productId,
            type: "SALE",
            quantity: l.qty,
            stockAfter: afterSale + l.qty,
            notes: "CANCEL",
            reference: order.id,
            effectiveAt: new Date(Date.now() - 20 * 60_000),
            createdAt: new Date(Date.now() - 20 * 60_000),
          },
        });
      }
    }
    return { order, items };
  }

  async function stockOf(productId: string): Promise<number> {
    return Number(
      (await prisma.product.findUniqueOrThrow({ where: { id: productId } })).currentStock,
    );
  }

  const inTenant = <T>(fn: () => Promise<T>): Promise<T> => tenantCtx.run(tenantId, fn);

  async function cleanup(): Promise<void> {
    const swallow = () => undefined;
    const w = { where: { tenantId } };
    await prisma.stockMovement.deleteMany(w).catch(swallow);
    await prisma.orderRevision?.deleteMany?.(w as any).catch?.(swallow);
    await prisma.deliveryMutation?.deleteMany?.(w as any).catch?.(swallow);
    await prisma.orderItem.deleteMany(w).catch(swallow);
    await prisma.order.deleteMany(w).catch(swallow);
    await prisma.product.deleteMany(w).catch(swallow);
    await prisma.customer.deleteMany(w).catch(swallow);
    await prisma.auditLog.deleteMany(w).catch(swallow);
    await prisma.user.deleteMany(w).catch(swallow);
    await prisma.tenant.delete({ where: { id: tenantId } }).catch(swallow);
    await endLedgerHelperPool();
    await prisma.$disconnect();
    await pool.end();
  }

  return {
    slug,
    tenantId,
    prisma,
    pool,
    orders,
    jwt,
    product,
    bookOrder,
    stockOf,
    inTenant,
    productIds,
    orderIds,
    cleanup,
    movements: (productId: string) =>
      prisma.stockMovement.findMany({
        where: { productId },
        orderBy: [{ createdAt: "asc" }, { id: "asc" }],
      }),
  };
}
export type OrderStockWorld = Awaited<ReturnType<typeof buildOrderStockWorld>>;
