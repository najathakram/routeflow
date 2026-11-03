/**
 * SA-1093 Rule 4, rows C-1..3: a return's cancel after a Boxes answer takes out the restock in today's pieces. The factor
 * comes from the return's own movement, so a return made after the answer cancels at its own quantity.
 * SA-1093 A-1, rows C-4: a standard return received after the answer restocks in today's pieces.
 *
 * Throwaway `qa-retpack-<run>-<n>` tenants (approved by `assertTestTenant`). Runs only under jest.db.config.js.
 */
import { randomUUID } from "crypto";
import { Test } from "@nestjs/testing";
import { AuditService } from "../audit/audit.service";
import { EntitlementsService } from "../billing/entitlements.service";
import { EncryptionService } from "../common/encryption.service";
import { IdempotencyService } from "../common/idempotency.service";
import {
  describeDb,
  requireLocalDatabaseUrl,
  waitForBlockedSession,
} from "../common/testing/db-spec";
import { CreditNotesService } from "../credit-notes/credit-notes.service";
import { RouteFlowGateway } from "../gateways/routeflow.gateway";
import { NumberingService } from "../import/numbering.service";
import { PrismaService } from "../prisma/prisma.service";
import { applyPackIntroduction } from "../products/pack-intro-apply";
import { RegulatedLedgerService } from "../regulated/regulated-ledger.service";
import { SalesFactsService } from "../sales-facts/sales-facts.service";
import { CommissionEngineService } from "../sales-agents/commission-engine.service";
import { SystemConfigService } from "../system-config/system-config.service";
import { TenantContextService } from "../tenant/tenant-context.service";
import { InlineReturnsQuoteService } from "./inline-returns-quote.service";
import { InlineReturnsService } from "./inline-returns.service";
import { bookRestockMovement } from "./returns-restock.util";
import { ReturnsService } from "./returns.service";

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { assertTestTenant } = require("../../../../scripts/lib/test-tenants.cjs");

const RUN = randomUUID().slice(0, 8);

describeDb("SA-1093 Rule 4: a return's cancel after a Boxes answer", () => {
  let prisma: PrismaService;
  let tenantCtx: TenantContextService;
  let returns: any;
  let inline: any;
  const tenantIds: string[] = [];
  let seq = 0;
  let numSeq = 0;

  beforeAll(async () => {
    requireLocalDatabaseUrl();
    tenantCtx = new TenantContextService();
    prisma = new PrismaService(tenantCtx);
    await prisma.$connect();
    const anyMethod = new Proxy(
      {},
      { get: (_t, prop) => (prop === "then" || typeof prop === "symbol" ? undefined : jest.fn()) },
    );
    const numbering = {
      reserveNext: jest.fn().mockImplementation(async () => `N-RETPACK-${RUN}-${++numSeq}`),
    };
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
        { provide: NumberingService, useValue: numbering },
      ],
    }).compile();
    returns = mod.get(ReturnsService);
    inline = Object.assign(Object.create(InlineReturnsService.prototype), {
      prisma,
      gateway: anyMethod,
      ledger: mod.get(RegulatedLedgerService),
      creditNotes: mod.get(CreditNotesService),
      numbering,
      addonService: { hasAddon: async () => true },
      quoteService: new InlineReturnsQuoteService(
        prisma,
        new SystemConfigService(prisma, new EncryptionService({ get: () => undefined } as any)),
      ),
      idempotency: new IdempotencyService(),
    });
  }, 120_000);

  afterAll(async () => {
    const swallow = () => undefined; // a failed cleanup must never mask a test's result
    for (const tenantId of tenantIds) {
      const where = { where: { tenantId } };
      await prisma.returnParkedRestock.deleteMany(where).catch(swallow);
      await prisma.returnItem.deleteMany(where).catch(swallow);
      await prisma.return.deleteMany(where).catch(swallow);
      await prisma.orderCreditNote.deleteMany(where).catch(swallow);
      await prisma.creditNoteItem.deleteMany(where).catch(swallow);
      await prisma.creditNote.deleteMany(where).catch(swallow);
      await prisma.invoiceItem.deleteMany(where).catch(swallow);
      await prisma.invoice.deleteMany(where).catch(swallow);
      await prisma.orderItem.deleteMany(where).catch(swallow);
      await prisma.order.deleteMany(where).catch(swallow);
      await prisma.stockMovement.deleteMany({ where: { product: { tenantId } } }).catch(swallow);
      await prisma.product.deleteMany(where).catch(swallow);
      await prisma.customer.deleteMany(where).catch(swallow);
      await prisma.user.deleteMany(where).catch(swallow);
      await prisma.auditLog.deleteMany(where).catch(swallow);
      await prisma.tenant.delete({ where: { id: tenantId } }).catch(swallow);
    }
    await prisma?.$disconnect();
  });

  /** One delivered sale of 10 pieces of a product with no pack and no stock. */
  async function seed(label: string) {
    seq += 1;
    const slug = assertTestTenant(
      `qa-retpack-${RUN}-${seq}-${label}`,
      "return-cancel-after-pack.db.spec.ts",
    );
    const { id: tenantId } = await prisma.tenant.create({ data: { slug, name: `ret ${slug}` } });
    tenantIds.push(tenantId);
    const user = await prisma.user.create({
      data: { email: `${slug}@example.invalid`, username: slug, role: "CUSTOMER", tenantId },
    });
    const customer = await prisma.customer.create({
      data: { userId: user.id, businessName: label, contactName: label, tenantId } as any,
    });
    const product = await prisma.product.create({
      data: {
        tenantId,
        name: `Widget ${slug}`,
        unit: "each",
        pricePerUnit: 10,
        currentStock: 0,
      } as any,
    });
    const order = await prisma.order.create({
      data: {
        tenantId,
        customerId: customer.id,
        orderNumber: `ORD-RETPACK-${RUN}-${seq}`,
        subtotal: 100,
        tax: 0,
        total: 100,
        status: "DELIVERED",
      } as any,
    });
    await prisma.orderItem.create({
      data: {
        tenantId,
        orderId: order.id,
        productId: product.id,
        name: product.name,
        qty: 10,
        unitPrice: 10,
        subtotal: 100,
      } as any,
    });
    // The invoice is what makes the pieces "sold": without it the capture restocks nothing (SA-1060).
    const invoice = await prisma.invoice.create({
      data: {
        tenantId,
        customerId: customer.id,
        orderId: order.id,
        invoiceNumber: `INV-RETPACK-${RUN}-${seq}`,
        status: "SENT",
        subtotal: 100,
        taxAmount: 0,
        total: 100,
      },
    });
    await prisma.invoiceItem.create({
      data: {
        tenantId,
        invoiceId: invoice.id,
        productId: product.id,
        description: "Widget",
        qty: 10,
        unitPrice: 10,
        subtotal: 100,
      },
    });
    return {
      tenantId,
      userId: user.id,
      customerId: customer.id,
      productId: product.id,
      orderId: order.id,
    };
  }
  type World = Awaited<ReturnType<typeof seed>>;

  const inTenant = (w: World, fn: () => Promise<any>): Promise<any> =>
    tenantCtx.run(w.tenantId, fn) as Promise<any>;
  const staff = (w: World) => ({
    sub: w.userId,
    username: "operator",
    role: "OPERATOR" as any,
    status: "ACTIVE" as any,
    forcePasswordChange: false,
    tenantId: w.tenantId,
    tenantSlug: "x",
  });
  const boxes = (w: World, to: number, whileOpen?: () => Promise<void>) =>
    inTenant(w, () =>
      prisma.tenantTransaction(async (tx) => {
        const data: Record<string, unknown> = { unitsPerBox: to };
        await applyPackIntroduction(tx as any, {
          tenantId: w.tenantId,
          productId: w.productId,
          from: null,
          to,
          reading: "box",
          data,
          actorId: null,
        });
        await tx.product.update({ where: { id: w.productId }, data });
        await whileOpen?.();
      }),
    );
  const stock = async (w: World) =>
    Number((await prisma.product.findUniqueOrThrow({ where: { id: w.productId } })).currentStock);
  const cancelRow = async (w: World) => {
    const rows = await prisma.stockMovement.findMany({
      where: { productId: w.productId, type: "RETURN", quantity: { lt: 0 } },
    });
    expect(rows).toHaveLength(1);
    return Number(rows[0].quantity);
  };

  let keySeq = 0;
  const inlineReturn = (w: World, pieces: number) =>
    inTenant(w, () =>
      inline.capture(
        {
          customerId: w.customerId,
          orderId: w.orderId,
          items: [{ productId: w.productId, qty: pieces, boxes: 0, pieces, restock: true }],
          returnKey: `retpack-${RUN}-${++keySeq}`,
        },
        staff(w),
      ),
    );
  const standardReturn = (w: World, qty: number) =>
    inTenant(w, async () => {
      const created = await returns.create(
        {
          orderId: w.orderId,
          reason: "EXCESS_ORDER",
          items: [{ productId: w.productId, qty, restock: true }],
        },
        w.userId,
        "CUSTOMER",
      );
      await returns.approve(created.id);
      await returns.receive(created.id, w.userId, { restock: true });
      return created;
    });

  it("C-1: an inline return of 3, then Boxes x24: the cancel takes out 72", async () => {
    const w = await seed("c1");
    const ret = await inlineReturn(w, 3);
    expect(await stock(w)).toBe(3);
    await boxes(w, 24);
    expect(await stock(w)).toBe(72);

    await inTenant(w, () => inline.cancel(ret.id, staff(w)));

    expect(await cancelRow(w)).toBe(-72);
    expect(await stock(w)).toBe(0);
  }, 60_000);

  it("C-1: two answers multiply", async () => {
    const w = await seed("c1two");
    const ret = await inlineReturn(w, 3);
    await boxes(w, 2);
    await boxes(w, 3);
    expect(await stock(w)).toBe(18);

    await inTenant(w, () => inline.cancel(ret.id, staff(w)));

    expect(await cancelRow(w)).toBe(-18);
  }, 60_000);

  it("C-2: a standard return of 3, then Boxes x24: the cancel takes out 72", async () => {
    const w = await seed("c2");
    const ret = await standardReturn(w, 3);
    expect(await stock(w)).toBe(3);
    await boxes(w, 24);

    await inTenant(w, () => returns.cancel(ret.id, staff(w)));

    expect(await cancelRow(w)).toBe(-72);
    expect(await stock(w)).toBe(0);
  }, 60_000);

  it("C-2: each restock row counts from its own day", async () => {
    const w = await seed("c2rows");
    const ret = await standardReturn(w, 3);
    await boxes(w, 24);
    await inTenant(w, () =>
      prisma.tenantTransaction((tx) =>
        bookRestockMovement(tx as any, {
          returnId: ret.id,
          productId: w.productId,
          pieces: 5 as any,
          userId: null,
        }),
      ),
    );
    expect(await stock(w)).toBe(77);

    await inTenant(w, () => returns.cancel(ret.id, staff(w)));

    expect(await cancelRow(w)).toBe(-77);
    expect(await stock(w)).toBe(0);
  }, 60_000);

  describe("C-5 (SA-1093 G5): a cancel that arrives while the answer is open waits for it", () => {
    const answerWhile = async (w: World, cancel: () => Promise<unknown>) => {
      let cancelling: Promise<unknown> | undefined;
      await boxes(w, 24, async () => {
        cancelling = cancel();
        await waitForBlockedSession(prisma);
      });
      await cancelling;
    };

    it("C-5a: a standard return of 3 takes out 72, back to 0", async () => {
      const w = await seed("c5a");
      const ret = await standardReturn(w, 3);

      await answerWhile(w, () => inTenant(w, () => returns.cancel(ret.id, staff(w))));

      expect(await cancelRow(w)).toBe(-72);
      expect(await stock(w)).toBe(0);
    }, 60_000);

    it("C-5b: an inline return of 3 takes out 72, back to 0", async () => {
      const w = await seed("c5b");
      const ret = await inlineReturn(w, 3);

      await answerWhile(w, () => inTenant(w, () => inline.cancel(ret.id, staff(w))));

      expect(await cancelRow(w)).toBe(-72);
      expect(await stock(w)).toBe(0);
    }, 60_000);
  });

  it("C-3: a return made after Boxes cancels at its own quantity", async () => {
    const inlineWorld = await seed("c3inline");
    await boxes(inlineWorld, 24);
    const made = await inlineReturn(inlineWorld, 3);
    expect(await stock(inlineWorld)).toBe(3);
    await inTenant(inlineWorld, () => inline.cancel(made.id, staff(inlineWorld)));
    expect(await cancelRow(inlineWorld)).toBe(-3);

    const standardWorld = await seed("c3standard");
    await boxes(standardWorld, 24);
    const ret = await standardReturn(standardWorld, 3);
    await inTenant(standardWorld, () => returns.cancel(ret.id, staff(standardWorld)));
    expect(await stock(standardWorld)).toBe(0);
  }, 60_000);

  it("a Pieces answer changes nothing", async () => {
    const w = await seed("pieces");
    const ret = await inlineReturn(w, 3);
    await inTenant(w, () =>
      prisma.tenantTransaction(async (tx) => {
        const data: Record<string, unknown> = { unitsPerBox: 24 };
        await applyPackIntroduction(tx as any, {
          tenantId: w.tenantId,
          productId: w.productId,
          from: null,
          to: 24,
          reading: "piece",
          data,
          actorId: null,
        });
        await tx.product.update({ where: { id: w.productId }, data });
      }),
    );
    expect(await stock(w)).toBe(3);

    await inTenant(w, () => inline.cancel(ret.id, staff(w)));

    expect(await cancelRow(w)).toBe(-3);
  }, 60_000);

  describe("C-4 (SA-1093 A-1): a standard return of 3 received after the answer", () => {
    const SPLIT = { boxes: 0, pieces: 10 };
    const LABEL = { unitLabel: "Case", unitsPerBox: 1 };

    const sold = (w: World, shape: Record<string, unknown>) =>
      prisma.orderItem.updateMany({ where: { orderId: w.orderId }, data: shape as any });
    const stocked = (w: World, data: Record<string, unknown>) =>
      prisma.product.update({ where: { id: w.productId }, data: data as any });
    const newLine = async (w: World, shape: Record<string, unknown>) => {
      const product = await prisma.product.findUniqueOrThrow({ where: { id: w.productId } });
      await prisma.orderItem.create({
        data: {
          tenantId: w.tenantId,
          orderId: w.orderId,
          productId: w.productId,
          name: product.name,
          qty: 10,
          unitPrice: 10,
          subtotal: 100,
          ...shape,
        } as any,
      });
    };
    const parks = (w: World) =>
      prisma.returnParkedRestock.findMany({ where: { productId: w.productId } });
    const restockRow = async (w: World) => {
      const rows = await prisma.stockMovement.findMany({
        where: { productId: w.productId, type: "RETURN", quantity: { gt: 0 } },
      });
      expect(rows).toHaveLength(1);
      return [Number(rows[0].quantity), Number(rows[0].unitCost)];
    };
    /** Stock 5 goes to 120 at x24, on a line sold before the answer. */
    const beforeBoxes = async (label: string, shape: Record<string, unknown>) => {
      const w = await seed(label);
      await sold(w, shape);
      await stocked(w, { currentStock: 5, averageCost: 2.4 });
      await boxes(w, 24);
      expect(await stock(w)).toBe(120);
      return w;
    };

    it("C-4a: a box-split line sold before goes 120 to 192, at the converted average", async () => {
      const w = await beforeBoxes("c4a", SPLIT);

      await standardReturn(w, 3);

      expect(await stock(w)).toBe(192);
      expect(await restockRow(w)).toEqual([72, 0.1]);
      expect(await parks(w)).toHaveLength(0);
    }, 60_000);

    it("C-4b: a labelled line with a snapshot of 1, sold before, goes 120 to 192", async () => {
      const w = await beforeBoxes("c4b", LABEL);

      await standardReturn(w, 3);

      expect(await stock(w)).toBe(192);
      expect(await parks(w)).toHaveLength(0);
    }, 60_000);

    it("C-4c: two answers multiply: 30 goes to 48", async () => {
      const w = await seed("c4c");
      await sold(w, SPLIT);
      await stocked(w, { currentStock: 5 });
      await boxes(w, 2);
      await boxes(w, 3);
      expect(await stock(w)).toBe(30);

      await standardReturn(w, 3);

      expect(await stock(w)).toBe(48);
    }, 60_000);

    it("C-4d: one line before and one after on the same order park, and stock doesn't move", async () => {
      const w = await beforeBoxes("c4d", SPLIT);
      await newLine(w, SPLIT);

      await standardReturn(w, 3);

      expect(await stock(w)).toBe(120);
      const parked = await parks(w);
      expect(parked).toHaveLength(1);
      expect(parked[0].reason).toBe("the product is on order lines with different packs");
    }, 60_000);

    it("C-4e: a line sold after the answer adds its own 3", async () => {
      const w = await seed("c4e");
      await prisma.orderItem.deleteMany({ where: { orderId: w.orderId } });
      await stocked(w, { currentStock: 5 });
      await boxes(w, 24);
      await newLine(w, SPLIT);

      await standardReturn(w, 3);

      expect(await stock(w)).toBe(123);
      expect(await parks(w)).toHaveLength(0);
    }, 60_000);

    it("C-4f: a Pieces answer adds 3", async () => {
      const w = await seed("c4f");
      await sold(w, SPLIT);
      await stocked(w, { currentStock: 120 });
      await inTenant(w, () =>
        prisma.tenantTransaction(async (tx) => {
          const data: Record<string, unknown> = { unitsPerBox: 24 };
          await applyPackIntroduction(tx as any, {
            tenantId: w.tenantId,
            productId: w.productId,
            from: null,
            to: 24,
            reading: "piece",
            data,
            actorId: null,
          });
          await tx.product.update({ where: { id: w.productId }, data });
        }),
      );
      expect(await stock(w)).toBe(120);

      await standardReturn(w, 3);

      expect(await stock(w)).toBe(123);
    }, 60_000);

    it("C-4g: its cancel goes back to 120, because the row is dated after the answer", async () => {
      const w = await beforeBoxes("c4g", SPLIT);
      const ret = await standardReturn(w, 3);
      const [restocked] = await restockRow(w);

      await inTenant(w, () => returns.cancel(ret.id, staff(w)));

      expect(await cancelRow(w)).toBe(-restocked);
      expect(await stock(w)).toBe(120);
    }, 60_000);

    it("C-4h: sales facts still read the return's 3", async () => {
      const w = await beforeBoxes("c4h", SPLIT);
      const ret = await standardReturn(w, 3);
      const refundedAt = new Date();
      await prisma.return.update({
        where: { id: ret.id },
        data: { refundMethod: "EXTERNAL_REFUND", refundedAt } as any,
      });

      const events = await inTenant(w, () =>
        new SalesFactsService(prisma).productCreditEvents(w.tenantId, w.productId, {
          gte: new Date(refundedAt.getTime() - 60_000),
          lt: new Date(refundedAt.getTime() + 60_000),
        }),
      );

      expect(events.returned.map((r: { qty: number | null }) => r.qty)).toEqual([3]);
    }, 60_000);

    // A return's create blocks behind the answer too, so these rows run it first.
    it("C-4i: a receive that arrives while the answer is open waits for it: 120 goes to 192", async () => {
      const w = await seed("c4i");
      await sold(w, SPLIT);
      await stocked(w, { currentStock: 5, averageCost: 2.4 });
      const ret = await inTenant(w, async () => {
        const created = await returns.create(
          {
            orderId: w.orderId,
            reason: "EXCESS_ORDER",
            items: [{ productId: w.productId, qty: 3, restock: true }],
          },
          w.userId,
          "CUSTOMER",
        );
        await returns.approve(created.id);
        return created;
      });

      let receiving: Promise<unknown> | undefined;
      await boxes(w, 24, async () => {
        receiving = inTenant(w, () => returns.receive(ret.id, w.userId, { restock: true }));
        await waitForBlockedSession(prisma);
      });
      await receiving;

      expect(await stock(w)).toBe(192);
      expect(await restockRow(w)).toEqual([72, 0.1]);
      expect(await parks(w)).toHaveLength(0);
    }, 60_000);

    it("guard: a second product's line dated after the answer has no vote", async () => {
      const w = await beforeBoxes("c4other", SPLIT);
      const other = await prisma.product.create({
        data: { tenantId: w.tenantId, name: `Other ${w.tenantId}`, unit: "each", pricePerUnit: 10 },
      });
      await prisma.orderItem.create({
        data: {
          tenantId: w.tenantId,
          orderId: w.orderId,
          productId: other.id,
          name: other.name,
          qty: 10,
          unitPrice: 10,
          subtotal: 100,
          ...SPLIT,
        } as any,
      });

      await standardReturn(w, 3);

      expect(await stock(w)).toBe(192);
      expect(await parks(w)).toHaveLength(0);
    }, 60_000);

    it("guard: a cancelled line dated after the answer has no vote", async () => {
      const w = await beforeBoxes("c4cancelled", SPLIT);
      await newLine(w, { ...SPLIT, status: "CANCELLED" });

      await standardReturn(w, 3);

      expect(await stock(w)).toBe(192);
      expect(await parks(w)).toHaveLength(0);
    }, 60_000);

    it("guard: a line dated at the answer's own instant counts as after it", async () => {
      const w = await beforeBoxes("c4instant", SPLIT);
      const intro = await prisma.auditLog.findFirstOrThrow({
        where: { entityType: "Product", entityId: w.productId },
        orderBy: { createdAt: "desc" },
      });
      await prisma.orderItem.updateMany({
        where: { orderId: w.orderId },
        data: { createdAt: intro.createdAt },
      });

      await standardReturn(w, 3);

      expect(await stock(w)).toBe(123);
      expect(await parks(w)).toHaveLength(0);
    }, 60_000);

    it("guard: a plain line sold before still parks", async () => {
      const w = await beforeBoxes("c4plain", {});

      await standardReturn(w, 3);

      expect(await stock(w)).toBe(120);
      expect(await parks(w)).toHaveLength(1);
    }, 60_000);

    it("guard: a line's own pack multiplies with the answer: 1 box of 3 at x8 is 24", async () => {
      const w = await seed("c4basis");
      await sold(w, { qty: 2, unitsPerBox: 3 });
      const line = await prisma.orderItem.findFirstOrThrow({ where: { orderId: w.orderId } });
      await prisma.invoiceItem.updateMany({
        where: { tenantId: w.tenantId, productId: w.productId },
        data: { orderItemId: line.id, qty: 6, boxes: 2, pieces: 0, unitsPerBox: 3 } as any,
      });
      await stocked(w, { currentStock: 5 });
      await boxes(w, 8);
      expect(await stock(w)).toBe(40);

      await standardReturn(w, 1);

      expect(await parks(w)).toHaveLength(0);
      expect(await stock(w)).toBe(64);
    }, 60_000);
  });
});
