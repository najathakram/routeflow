/**
 * SA-1042 B9b through ReturnsService on REAL Postgres (WRITTEN, NOT RUN on the MacBook: the DB lane owns it, `npm run
 * local:test:db`). Fixture: product P (pack 10). Order O has line A (2 Cases of 200 = 400 pcs, 90.00) and line B (10 boxes of 10
 * = 100 pcs, 25.00), invoiced on ONE SENT invoice (115.00) as items iA and iB. 500 pieces in all.
 *
 *   R-r1  200 pieces off line A credit 45.00 on A's invoice item; the same 200 pooled credit 46.00 (SA-628b, KEPT).
 *   R-r2  110 pieces on the 100-piece line B: a 400 naming "100 pcs (10 boxes)"; nothing written.
 *   N-r4  one Case on A: ReturnItem.qty 200 with sourceOrderItemId A.
 *   G-r10 a line return of 1 Case, then 2 Cases on A: a 400 (1 Case left).
 *
 * Every tenant is a throwaway `qa-b9b-<run>-<n>` slug approved by `assertTestTenant`, deleted in FK order in afterAll.
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
import { describeDb, requireLocalDatabaseUrl } from "../common/testing/db-spec";

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { assertTestTenant } = require("../../../../scripts/lib/test-tenants.cjs");

const RUN = randomUUID().slice(0, 8);

describeDb(
  "SA-1042 B9b: a standard return names its order line, is capped on it and credited at its price — real Postgres",
  () => {
    let prisma: PrismaService;
    let tenantCtx: TenantContextService;
    let returns: ReturnsService;
    let creditNotes: CreditNotesService;
    const tenantIds: string[] = [];
    let seq = 0;
    let cnSeq = 0;

    beforeAll(async () => {
      requireLocalDatabaseUrl();
      tenantCtx = new TenantContextService();
      prisma = new PrismaService(tenantCtx);
      await prisma.$connect();
      const anyMethod = new Proxy(
        {},
        {
          get: (_t, prop) => (prop === "then" || typeof prop === "symbol" ? undefined : jest.fn()),
        },
      );
      const mod = await Test.createTestingModule({
        providers: [
          CreditNotesService,
          ReturnsService,
          RegulatedLedgerService,
          CommissionEngineService,
          AuditService,
          { provide: PrismaService, useValue: prisma },
          {
            provide: EntitlementsService,
            useValue: { hasFlag: jest.fn().mockResolvedValue(false) },
          },
          { provide: RouteFlowGateway, useValue: anyMethod },
          {
            provide: NumberingService,
            useValue: {
              reserveNext: jest.fn().mockImplementation(async () => `CN-UNIT-${RUN}-${++cnSeq}`),
            },
          },
        ],
      }).compile();
      returns = mod.get(ReturnsService);
      creditNotes = mod.get(CreditNotesService);
    });

    afterAll(async () => {
      const swallow = () => undefined;
      for (const tenantId of tenantIds) {
        const where = { where: { tenantId } };
        await prisma.returnItem.deleteMany(where).catch(swallow);
        await prisma.return.deleteMany(where).catch(swallow);
        await prisma.creditNoteItem.deleteMany(where).catch(swallow);
        await prisma.creditNote.deleteMany(where).catch(swallow);
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
      await prisma?.$disconnect();
    });

    /** O with lines A and B of one product, ONE SENT invoice with items iA and iB. */
    async function seed(label: string) {
      seq += 1;
      const slug = assertTestTenant(`qa-b9b-${RUN}-${seq}-${label}`, "returns-by-line.db.spec.ts");
      const tenant = await prisma.tenant.create({ data: { slug, name: `b9b ${slug}` } });
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
      const order = await prisma.order.create({
        data: {
          tenantId,
          customerId: customer.id,
          orderNumber: `ORD-B9B-${RUN}-${seq}`,
          subtotal: 115,
          tax: 0,
          total: 115,
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
      const invoice = await prisma.invoice.create({
        data: {
          tenantId,
          customerId: customer.id,
          orderId: order.id,
          invoiceNumber: `INV-B9B-${RUN}-${seq}`,
          status: "SENT",
          subtotal: 115,
          taxAmount: 0,
          total: 115,
        },
      });
      const mkItem = (orderItemId: string, over: Record<string, unknown>) =>
        prisma.invoiceItem.create({
          data: {
            tenantId,
            invoiceId: invoice.id,
            orderItemId,
            productId: product.id,
            description: "P",
            ...over,
          } as any,
        });
      const iA = await mkItem(lineA.id, {
        qty: 400,
        unitPrice: 45,
        subtotal: 90,
        boxes: 2,
        pieces: 0,
        unitsPerBox: 200,
      });
      const iB = await mkItem(lineB.id, {
        qty: 100,
        unitPrice: 2.5,
        subtotal: 25,
        boxes: 10,
        pieces: 0,
        unitsPerBox: 10,
      });
      return {
        tenantId,
        userId: user.id,
        orderId: order.id,
        productId: product.id,
        lineA,
        lineB,
        iA,
        iB,
      };
    }
    type Seed = Awaited<ReturnType<typeof seed>>;

    const create = (s: Seed, items: Array<Record<string, unknown>>) =>
      tenantCtx.run(s.tenantId, () =>
        returns.create({ orderId: s.orderId, reason: "DAMAGED", items } as any, s.userId),
      );

    /** Moves a created return to RECEIVED (the refund door's precondition) and mints its credit note. */
    async function refund(s: Seed, returnId: string) {
      await prisma.return.update({ where: { id: returnId }, data: { status: "RECEIVED" } });
      await tenantCtx.run(s.tenantId, () => returns.processRefund(returnId));
      const note = await prisma.creditNote.findFirstOrThrow({
        where: { tenantId: s.tenantId, status: { not: "VOID" } },
      });
      const items = await prisma.creditNoteItem.findMany({ where: { creditNoteId: note.id } });
      return { amount: Number(note.amount), items };
    }

    it("R-r1: 200 pieces off line A credit 45.00 on A's invoice item", async () => {
      const s = await seed("rr1");
      const ret: any = await create(s, [
        { productId: s.productId, orderItemId: s.lineA.id, qty: 200 },
      ]);
      const r = await refund(s, ret.id);
      expect(r.amount).toBe(45);
      expect(r.items.map((i) => i.invoiceItemId)).toEqual([s.iA.id]);
    });

    it("G-r7 (pooled, KEPT): the same 200 pieces without a line key credit the pooled average, 46.00", async () => {
      const s = await seed("pooled");
      const ret: any = await create(s, [{ productId: s.productId, qty: 200 }]);
      expect((await refund(s, ret.id)).amount).toBe(46);
    });

    it("N-r4: one Case on A stores qty 200 and the line key", async () => {
      const s = await seed("nr4");
      const ret: any = await create(s, [
        { productId: s.productId, orderItemId: s.lineA.id, boxes: 1, pieces: 0 },
      ]);
      const item = await prisma.returnItem.findFirstOrThrow({ where: { returnId: ret.id } });
      expect([Number(item.qty), item.sourceOrderItemId]).toEqual([200, s.lineA.id]);
    });

    it("R-r2: 110 pieces on the 100-piece line B is a 400 naming what is left, and writes no return", async () => {
      const s = await seed("rr2");
      await expect(
        create(s, [{ productId: s.productId, orderItemId: s.lineB.id, qty: 110 }]),
      ).rejects.toThrow(/100 pcs \(10 boxes\)/);
      expect(await prisma.return.count({ where: { tenantId: s.tenantId } })).toBe(0);
    });

    it("G-r10: after 1 Case returned on A, 2 more Cases is a 400 (1 Case left) and 1 is accepted", async () => {
      const s = await seed("gr10");
      await create(s, [{ productId: s.productId, orderItemId: s.lineA.id, boxes: 1 }]);
      await expect(
        create(s, [{ productId: s.productId, orderItemId: s.lineA.id, boxes: 2 }]),
      ).rejects.toThrow(/200 pcs \(1 Case\)/);
      await expect(
        create(s, [{ productId: s.productId, orderItemId: s.lineA.id, boxes: 1 }]),
      ).resolves.toBeDefined();
    });
  },
);
