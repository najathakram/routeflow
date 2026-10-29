/**
 * SA-1042 A-3 (I-177) on REAL Postgres: a typed (itemised) credit note on an order with 2+ invoices is checked per line against
 * the LINE-NAMED return lumps (the pinned part of the order pool), not only per product against the pool. Run with
 * `npm run local:test:db` (fresh `rf_dbspec_*` database).
 *
 * Fixture: product P, two same-priced lines: A = 200 pcs, 50.00 on the LATER invoice (total 190.00, so a lump has room), B =
 * 200 pcs, 50.00 on an EARLIER invoice. P as a whole has 100.00 and 400 pcs; the line check alone sees only A's own credits.
 *
 *   R-r22  a line-named return of all of A (200 pcs) is refunded on the 2+-invoice path (one 50.00 lump on A's invoice), then a
 *          typed credit note for A's full 50.00 lands on A's invoice item: CREDIT_NOTE_OVER_HEADROOM, nothing written. Before
 *          the fix the per-line check did not see the lump and the product check passed on B's 50.00 of room.
 *   G-r23  the same with a POOLED prior lump (the return names no line): as on master, the typed credit is accepted (B960 KEPT:
 *          a pooled lump's line attribution is a line-order artefact, bound per product only).
 *   G-r24  a typed credit of 50.00 on B's item after the line-named return of A is accepted (the pin binds A's line only).
 *
 * Every tenant is a throwaway `qa-a3-<run>-<n>` slug approved by `assertTestTenant`, deleted in FK order in afterAll.
 */
import { randomUUID } from "crypto";
import { Test } from "@nestjs/testing";
import { PrismaService } from "../prisma/prisma.service";
import { TenantContextService } from "../tenant/tenant-context.service";
import { CreditNotesService } from "./credit-notes.service";
import { ReturnsService } from "../returns/returns.service";
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
  "SA-1042 A-3: a typed credit is bound per line against the line-named return lumps — real Postgres",
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
              reserveNext: jest.fn().mockImplementation(async () => `CN-A3-${RUN}-${++cnSeq}`),
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

    async function seed(label: string) {
      seq += 1;
      const slug = assertTestTenant(
        `qa-a3-${RUN}-${seq}-${label}`,
        "typed-credit-pinned-lump.db.spec.ts",
      );
      const tenant = await prisma.tenant.create({ data: { slug, name: `a3 ${slug}` } });
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
          pricePerUnit: 0.25,
          unitsPerBox: 10,
        } as any,
      });
      const order = await prisma.order.create({
        data: {
          tenantId,
          customerId: customer.id,
          orderNumber: `ORD-A3-${RUN}-${seq}`,
          subtotal: 100,
          tax: 0,
          total: 100,
          status: "DELIVERED",
        } as any,
      });
      const lineShape = {
        qty: 200,
        unitPrice: 0.25,
        subtotal: 50,
        boxes: 20,
        pieces: 0,
        unitsPerBox: 10,
      };
      const mkLine = (position: number) =>
        prisma.orderItem.create({
          data: {
            tenantId,
            orderId: order.id,
            productId: product.id,
            name: product.name,
            position,
            ...lineShape,
          } as any,
        });
      const lineA = await mkLine(0);
      const lineB = await mkLine(1);
      // A's invoice is the LATER one (190.00 total, so a refund lump has room); B's is earlier
      const [idLater, idEarlier] = [randomUUID(), randomUUID()].sort();
      const invoiceA = await prisma.invoice.create({
        data: {
          id: idLater,
          tenantId,
          customerId: customer.id,
          orderId: order.id,
          invoiceNumber: `INV-A3-${RUN}-${seq}`,
          status: "SENT",
          subtotal: 50,
          taxAmount: 0,
          discount: 0,
          total: 190,
        },
      });
      const invoiceB = await prisma.invoice.create({
        data: {
          id: idEarlier,
          tenantId,
          customerId: customer.id,
          orderId: order.id,
          invoiceNumber: `INV-A3-${RUN}-${seq}-B`,
          status: "SENT",
          subtotal: 50,
          taxAmount: 0,
          discount: 0,
          total: 50,
          createdAt: new Date(Date.now() - 3_600_000),
        },
      });
      const mkItem = (orderItemId: string, invoiceId: string) =>
        prisma.invoiceItem.create({
          data: {
            tenantId,
            invoiceId,
            orderItemId,
            productId: product.id,
            description: "P",
            ...lineShape,
          } as any,
        });
      const iA = await mkItem(lineA.id, invoiceA.id);
      const iB = await mkItem(lineB.id, invoiceB.id);
      return {
        tenantId,
        customerId: customer.id,
        userId: user.id,
        orderId: order.id,
        productId: product.id,
        lineA,
        lineB,
        invoiceA,
        invoiceB,
        iA,
        iB,
      };
    }
    type Seed = Awaited<ReturnType<typeof seed>>;

    /** Returns 200 pcs of P (naming `lineId`, or no line) and refunds them: the 2+-invoice path's one 50.00 lump. */
    async function refundLump(s: Seed, lineId: string | null) {
      const ret: any = await tenantCtx.run(s.tenantId, () =>
        returns.create(
          {
            orderId: s.orderId,
            reason: "DAMAGED",
            items: [
              { productId: s.productId, ...(lineId ? { orderItemId: lineId } : {}), qty: 200 },
            ],
          } as any,
          s.userId,
        ),
      );
      await prisma.return.update({ where: { id: ret.id }, data: { status: "RECEIVED" } });
      await tenantCtx.run(s.tenantId, () => returns.processRefund(ret.id));
      return prisma.creditNote.findFirstOrThrow({
        where: { tenantId: s.tenantId, status: { not: "VOID" } },
      });
    }

    /** A typed credit note of `amount` on `invoiceId`'s item `itemId`; the error (or null) it answered. */
    const typedCredit = (s: Seed, invoiceId: string, itemId: string, amount: number) =>
      tenantCtx
        .run(s.tenantId, () =>
          creditNotes.create({
            customerId: s.customerId,
            invoiceId,
            amount,
            reason: "a3 typed credit",
            items: [{ invoiceItemId: itemId, amount }],
          } as any),
        )
        .then(() => null)
        .catch((e: any) => e);

    const noteCount = (s: Seed) =>
      prisma.creditNote.count({ where: { tenantId: s.tenantId, status: { not: "VOID" } } });

    it("R-r22: a typed credit for A's full 50.00 after A was refunded by a line-named return is CREDIT_NOTE_OVER_HEADROOM, nothing written", async () => {
      const s = await seed("rr22");
      const lump = await refundLump(s, s.lineA.id);
      expect(Number(lump.amount)).toBe(50);
      expect(await noteCount(s)).toBe(1);
      const err = await typedCredit(s, s.invoiceA.id, s.iA.id, 50);
      expect({ code: err?.getResponse?.()?.code ?? null, notes: await noteCount(s) }).toEqual({
        code: "CREDIT_NOTE_OVER_HEADROOM",
        notes: 1,
      });
    });

    it("G-r23 (pooled prior lump, KEPT): the same typed credit after a return naming no line is accepted, as on master", async () => {
      const s = await seed("gr23");
      await refundLump(s, null);
      const err = await typedCredit(s, s.invoiceA.id, s.iA.id, 50);
      expect({ code: err?.getResponse?.()?.code ?? null, notes: await noteCount(s) }).toEqual({
        code: null,
        notes: 2,
      });
    });

    it("G-r24: after the line-named return of A, a typed credit for B's full 50.00 on B's own item is accepted", async () => {
      const s = await seed("gr24");
      await refundLump(s, s.lineA.id);
      const err = await typedCredit(s, s.invoiceB.id, s.iB.id, 50);
      expect({ code: err?.getResponse?.()?.code ?? null, notes: await noteCount(s) }).toEqual({
        code: null,
        notes: 2,
      });
    });
  },
);
