/**
 * SA-840 A-2 DB-lane fixture (review-b's MULTI fixture, with EXPLICIT invoice ids so the id order is chosen, not drawn).
 * Imported only by `*.db.spec.ts` files; it is a helper, not a spec.
 *
 * Product P (unit price 2.50 a piece, pack 10), ONE order, two PAID invoices:
 *   line A = 400 pcs, 90.00 net, 10% tax (9.00)     on invoice A, total  99.00
 *   line B = 100 pcs, 25.00 net,  8% tax (2.00)     on invoice B, total  27.00
 * `older` names the invoice with the earlier `createdAt` (the pricer's fill order puts its line first); `smallerId` names the invoice
 * whose id sorts first. A one-shot pooled 150 pcs on the pricer's fill (B, then A) is 25.00 + 11.25 net, 2.00 + 1.125 tax: 39.38.
 *
 * Every tenant is a throwaway `qa-sa840-<run>-<n>` slug approved by `assertTestTenant`, deleted in FK order by `cleanup`.
 */
import { randomUUID } from "crypto";
import { Test } from "@nestjs/testing";
import { PrismaService } from "../prisma/prisma.service";
import { TenantContextService } from "../tenant/tenant-context.service";
import { CreditNotesService } from "../credit-notes/credit-notes.service";
import { ReturnsService } from "./returns.service";
import { RegulatedLedgerService } from "../regulated/regulated-ledger.service";
import { CommissionEngineService } from "../sales-agents/commission-engine.service";
import { AuditService } from "../audit/audit.service";
import { EntitlementsService } from "../billing/entitlements.service";
import { RouteFlowGateway } from "../gateways/routeflow.gateway";
import { NumberingService } from "../import/numbering.service";
import { requireLocalDatabaseUrl } from "../common/testing/db-spec";

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { assertTestTenant } = require("../../../../scripts/lib/test-tenants.cjs");

export type Side = "A" | "B";
export type RefundResult =
  | { amount: number }
  | { refused: { status: number | undefined; code: string | undefined; message: string } };
export interface MultiOpts {
  /** the invoice created EARLIER (its line is first in the pricer's fill order) */
  older: Side;
  /** the invoice whose id sorts first (the order the pool replayed in before A-2) */
  smallerId: Side;
}
/** The one-shot figure for 150 pcs on the fill B (100 pcs) then A (50 pcs): the bound review-b measured. */
export const ONE_SHOT_150 = 39.38;

export async function buildHarness(tag: string) {
  const run = randomUUID().slice(0, 8);
  requireLocalDatabaseUrl();
  const tenantCtx = new TenantContextService();
  const prisma = new PrismaService(tenantCtx);
  await prisma.$connect();
  const anyMethod = new Proxy(
    {},
    { get: (_t, prop) => (prop === "then" || typeof prop === "symbol" ? undefined : jest.fn()) },
  );
  let cnSeq = 0;
  const mod = await Test.createTestingModule({
    providers: [
      CreditNotesService,
      ReturnsService,
      RegulatedLedgerService,
      CommissionEngineService,
      AuditService,
      { provide: PrismaService, useValue: prisma },
      { provide: EntitlementsService, useValue: { hasFlag: jest.fn().mockResolvedValue(false) } },
      { provide: RouteFlowGateway, useValue: anyMethod },
      {
        provide: NumberingService,
        useValue: {
          reserveNext: jest.fn().mockImplementation(async () => `CN-840-${run}-${++cnSeq}`),
        },
      },
    ],
  }).compile();
  const returns = mod.get(ReturnsService);
  const tenantIds: string[] = [];
  let seq = 0;

  async function cleanup() {
    const swallow = () => undefined;
    for (const tenantId of tenantIds) {
      const where = { where: { tenantId } };
      await prisma.returnItem.deleteMany(where).catch(swallow);
      await prisma.return.deleteMany(where).catch(swallow);
      await prisma.creditNoteItem.deleteMany(where).catch(swallow);
      await prisma.orderCreditNote.deleteMany(where).catch(swallow);
      await prisma.creditNote.deleteMany(where).catch(swallow);
      await prisma.invoicePayment.deleteMany(where).catch(swallow);
      await prisma.invoiceItem.deleteMany(where).catch(swallow);
      await prisma.invoice.deleteMany(where).catch(swallow);
      await prisma.orderItem.deleteMany(where).catch(swallow);
      await prisma.order.deleteMany(where).catch(swallow);
      await prisma.product.deleteMany(where).catch(swallow);
      await prisma.customer.deleteMany(where).catch(swallow);
      await prisma.user.deleteMany(where).catch(swallow);
      await prisma.auditLog.deleteMany(where).catch(swallow);
      await prisma.tenant.delete({ where: { id: tenantId } }).catch(swallow);
    }
    await prisma.$disconnect();
  }

  /** `invoices: 2` is the MULTI order; `invoices: 1` is SINGLE (both lines on ONE invoice, 10% on each, as the R-C fixture). */
  async function seed(
    label: string,
    opts: MultiOpts & { invoices?: 1 | 2 } = { older: "B", smallerId: "B" },
  ) {
    seq += 1;
    const slug = assertTestTenant(
      `qa-sa840-${run}-${seq}-${tag}-${label}`,
      "sa840-multi-fixture.ts",
    );
    const tenant = await prisma.tenant.create({ data: { slug, name: `sa840 ${slug}` } });
    tenantIds.push(tenant.id);
    const tenantId = tenant.id;
    const user = await prisma.user.create({
      data: { email: `${slug}@example.invalid`, username: slug, role: "CUSTOMER", tenantId },
    });
    const customer = await prisma.customer.create({
      data: { userId: user.id, businessName: `c ${label}`, contactName: `c ${label}`, tenantId },
    });
    const product = await prisma.product.create({
      data: {
        tenantId,
        name: `P ${slug}`,
        unit: "each",
        pricePerUnit: 2.5,
        unitsPerBox: 10,
      } as any,
    });
    const single = opts.invoices === 1;
    const order = await prisma.order.create({
      data: {
        tenantId,
        customerId: customer.id,
        orderNumber: `ORD-840-${run}-${seq}`,
        subtotal: 115,
        tax: single ? 11.5 : 11,
        total: single ? 126.5 : 126,
        status: "DELIVERED",
      } as any,
    });
    const mkLine = (position: number, over: Record<string, unknown>) =>
      prisma.orderItem.create({
        data: {
          tenantId,
          orderId: order.id,
          productId: product.id,
          name: product.name,
          position,
          ...over,
        } as any,
      });
    const lineA = await mkLine(0, {
      qty: 400,
      unitPrice: 45,
      subtotal: 90,
      boxes: 2,
      pieces: 0,
      unitsPerBox: 200,
      unitLabel: "Case",
    });
    const lineB = await mkLine(1, {
      qty: 100,
      unitPrice: 2.5,
      subtotal: 25,
      boxes: 10,
      pieces: 0,
      unitsPerBox: 10,
    });
    // explicit ids: `...01` sorts before `...02`; explicit createdAt: the older invoice is an hour earlier
    const idOf = (side: Side) =>
      `${run}-0000-4000-8000-${String(seq).padStart(9, "0")}${side === opts.smallerId ? "01" : "02"}`;
    const createdAtOf = (side: Side) =>
      new Date(Date.now() - (side === opts.older ? 7_200_000 : 3_600_000));
    const mkInvoice = async (side: Side | "ONE", subtotal: number, tax: number) => {
      const key: Side = side === "ONE" ? "B" : side;
      const invoice = await prisma.invoice.create({
        data: {
          id: idOf(key),
          createdAt: createdAtOf(key),
          tenantId,
          customerId: customer.id,
          orderId: order.id,
          invoiceNumber: `INV-840-${run}-${seq}-${key}`,
          status: "PAID",
          subtotal,
          taxAmount: tax,
          discount: 0,
          total: subtotal + tax,
        },
      });
      await prisma.invoicePayment.create({
        data: {
          tenantId,
          invoiceId: invoice.id,
          amount: subtotal + tax,
          method: "CASH",
          status: "PAID",
        },
      });
      return invoice;
    };
    const mkItem = (invoiceId: string, orderItemId: string, over: Record<string, unknown>) =>
      prisma.invoiceItem.create({
        data: {
          tenantId,
          invoiceId,
          orderItemId,
          productId: product.id,
          description: "P",
          ...over,
        } as any,
      });
    const shapeA = { qty: 400, unitPrice: 45, subtotal: 90, boxes: 2, pieces: 0, unitsPerBox: 200 };
    const shapeB = {
      qty: 100,
      unitPrice: 2.5,
      subtotal: 25,
      boxes: 10,
      pieces: 0,
      unitsPerBox: 10,
    };
    let invA;
    let invB;
    let iA;
    let iB;
    if (single) {
      invA = invB = await mkInvoice("ONE", 115, 11.5);
      iA = await mkItem(invA.id, lineA.id, { ...shapeA, taxRate: 0.1 });
      iB = await mkItem(invA.id, lineB.id, { ...shapeB, taxRate: 0.1 });
    } else {
      invA = await mkInvoice("A", 90, 9);
      invB = await mkInvoice("B", 25, 2);
      iA = await mkItem(invA.id, lineA.id, { ...shapeA, taxRate: 0.1 });
      iB = await mkItem(invB.id, lineB.id, { ...shapeB, taxRate: 0.08 });
    }
    return {
      tenantId,
      userId: user.id,
      orderId: order.id,
      productId: product.id,
      lineA,
      lineB,
      iA,
      iB,
      invA,
      invB,
    };
  }
  type Seed = Awaited<ReturnType<typeof seed>>;

  const actor = (s: Seed) => ({ sub: s.userId, role: "OPERATOR" }) as any;
  const create = (s: Seed, items: Array<Record<string, unknown>>) =>
    tenantCtx.run(s.tenantId, () =>
      returns.create({ orderId: s.orderId, reason: "DAMAGED", items } as any, s.userId),
    ) as Promise<{ id: string }>;
  /** A pooled return of `qty` pieces (no line named), or a line-named one. */
  const pooled = (s: Seed, qty: number) => create(s, [{ productId: s.productId, qty }]);
  const onLine = (s: Seed, side: Side, qty: number) =>
    create(s, [
      { productId: s.productId, orderItemId: (side === "A" ? s.lineA : s.lineB).id, qty },
    ]);

  /** RECEIVED, then processRefund. Resolves { amount } on success or { refused } with the error's code / message. */
  async function refund(
    s: Seed,
    returnId: string,
    method: "CREDIT_NOTE" | "EXTERNAL_REFUND" = "CREDIT_NOTE",
  ): Promise<RefundResult> {
    await prisma.return.update({ where: { id: returnId }, data: { status: "RECEIVED" } });
    try {
      await tenantCtx.run(s.tenantId, () =>
        returns.processRefund(returnId, { method } as any, actor(s)),
      );
    } catch (err: any) {
      const body = typeof err?.getResponse === "function" ? err.getResponse() : undefined;
      return {
        refused: {
          status: err?.getStatus?.() as number | undefined,
          code: body?.code as string | undefined,
          message: String(err?.message ?? err),
        },
      };
    }
    const row = await prisma.return.findUniqueOrThrow({ where: { id: returnId } });
    return { amount: Number(row.refundAmount) };
  }
  const returnRow = (id: string) => prisma.return.findUniqueOrThrow({ where: { id } });
  const creditNoteCount = (s: Seed) =>
    prisma.creditNote.count({ where: { tenantId: s.tenantId, status: { not: "VOID" } } });
  const estimateOf = (s: Seed, returnId: string) =>
    tenantCtx.run(s.tenantId, () => returns.findOne(returnId)) as Promise<{
      refundEstimate: number;
    }>;
  const round2 = (n: number) => Math.round(n * 100) / 100;

  return {
    prisma,
    tenantCtx,
    returns,
    seed,
    pooled,
    onLine,
    refund,
    returnRow,
    creditNoteCount,
    estimateOf,
    round2,
    cleanup,
  };
}
export type Harness = Awaited<ReturnType<typeof buildHarness>>;
