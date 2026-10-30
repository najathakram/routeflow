/**
 * SA-1042 A-1 x SA-840 (B704) through ReturnsService on REAL Postgres: selection first (which billed lines a returned GROUP is
 * priced against: B9b-2), then pricing (what the invoice CHARGED on that slice: `refundableLineShare`, net after the discount
 * share plus the tax share). Run with `npm run local:test:db` (fresh `rf_dbspec_*` database).
 *
 * Fixture: product P, ONE taxed SENT invoice (10% on every line, no discount): line A = 2 Cases of 200 pcs, 90.00 net (tax 9.00);
 * line B = 100 pcs, 25.00 net (tax 2.50). Invoice tax 11.50, total 126.50. 500 pieces of one product at two different prices.
 *
 *   R-C   a return that names the CHEAPER line B (50 pcs) credits that line's net share plus its tax share, 12.50 + 1.25 =
 *         13.75: never the pooled average (11.50 + 1.15 = 12.65) and never untaxed (12.50). The dearer line A (200 pcs) credits
 *         45.00 + 4.50 = 49.50 (pooled 46.00 + 4.60 = 50.60, untaxed 45.00).
 *   G-C   a return naming no line is the pooled slice (SA-628b average + SA-840 tax): 200 pcs credit 46.00 + 4.60 = 50.60.
 *
 * Every tenant is a throwaway `qa-b704-<run>-<n>` slug approved by `assertTestTenant`, deleted in FK order in afterAll.
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
  "SA-1042 A-1 x SA-840: a line-named return is priced on its own line's net and tax — real Postgres",
  () => {
    let prisma: PrismaService;
    let tenantCtx: TenantContextService;
    let returns: ReturnsService;
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
              reserveNext: jest.fn().mockImplementation(async () => `CN-TAX-${RUN}-${++cnSeq}`),
            },
          },
        ],
      }).compile();
      returns = mod.get(ReturnsService);
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

    async function seed(label: string) {
      seq += 1;
      const slug = assertTestTenant(
        `qa-b704-${RUN}-${seq}-${label}`,
        "returns-by-line-tax.db.spec.ts",
      );
      const tenant = await prisma.tenant.create({ data: { slug, name: `b704 ${slug}` } });
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
          orderNumber: `ORD-B704-${RUN}-${seq}`,
          subtotal: 115,
          tax: 11.5,
          total: 126.5,
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
          invoiceNumber: `INV-B704-${RUN}-${seq}`,
          status: "SENT",
          subtotal: 115,
          taxAmount: 11.5,
          discount: 0,
          total: 126.5,
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
            taxRate: 0.1,
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

    it("R-C: 50 pcs off the CHEAPER line B credit its net 12.50 plus its tax 1.25 = 13.75 on B's invoice item", async () => {
      const s = await seed("rc-b");
      const ret: any = await create(s, [
        { productId: s.productId, orderItemId: s.lineB.id, qty: 50 },
      ]);
      const r = await refund(s, ret.id);
      expect(r.amount).toBe(13.75); // never the pooled 12.65, never untaxed 12.50
      expect(r.items.map((i) => [i.invoiceItemId, Number(i.amount)])).toEqual([[s.iB.id, 12.5]]);
    });

    it("R-C: 200 pcs off the dearer line A credit 45.00 + 4.50 = 49.50 on A's invoice item", async () => {
      const s = await seed("rc-a");
      const ret: any = await create(s, [
        { productId: s.productId, orderItemId: s.lineA.id, qty: 200 },
      ]);
      const r = await refund(s, ret.id);
      expect(r.amount).toBe(49.5); // never the pooled 50.60, never untaxed 45.00
      expect(r.items.map((i) => [i.invoiceItemId, Number(i.amount)])).toEqual([[s.iA.id, 45]]);
    });

    it("G-C (pooled, KEPT): the same 200 pcs naming no line credit the pooled slice, 46.00 + 4.60 = 50.60", async () => {
      const s = await seed("pooled");
      const ret: any = await create(s, [{ productId: s.productId, qty: 200 }]);
      expect((await refund(s, ret.id)).amount).toBe(50.6);
    });
  },
);
