/**
 * SA-1101 §2.5 (RO-9, RO-9b) through ReturnsService on REAL Postgres. A fully refused order closes REFUSED with a
 * $0 live invoice (observed in routes/stop-outcome-refused.db.spec.ts, RO-1). Staff may still record a return on it,
 * which is how the refused goods go back to stock; a CUSTOMER may not. The credit that return earns is OBSERVED, $0
 * expected: anything above $0 is SA-1098's G-6 and goes back to the SA.
 *
 * Throwaway `qa-sa1101r-<run>-<n>` tenants approved by `assertTestTenant`, deleted in FK order in afterAll.
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

describeDb("SA-1101 RO-9: a return on a REFUSED order — real Postgres", () => {
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
      { get: (_t, prop) => (prop === "then" || typeof prop === "symbol" ? undefined : jest.fn()) },
    );
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
            reserveNext: jest.fn().mockImplementation(async () => `CN-SA1101-${RUN}-${++cnSeq}`),
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
      await prisma.stockMovement.deleteMany({ where: { product: { tenantId } } }).catch(swallow);
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

  /** A REFUSED order: one line of 10 at $10, nothing delivered, its live invoice at the post-refusal $0. */
  async function seedRefused(label: string) {
    seq += 1;
    const slug = assertTestTenant(
      `qa-sa1101r-${RUN}-${seq}-${label}`,
      "returns-refused-order.db.spec.ts",
    );
    const tenant = await prisma.tenant.create({ data: { slug, name: `sa1101r ${slug}` } });
    tenantIds.push(tenant.id);
    const tenantId = tenant.id;
    const user = await prisma.user.create({
      data: { email: `${slug}@example.invalid`, username: slug, role: "CUSTOMER", tenantId },
    });
    const customer = await prisma.customer.create({
      data: { userId: user.id, businessName: `c ${label}`, contactName: `c ${label}`, tenantId },
    });
    const product = await prisma.product.create({
      data: { tenantId, name: `P ${slug}`, unit: "each", pricePerUnit: 10 } as any,
    });
    const order = await prisma.order.create({
      data: {
        tenantId,
        customerId: customer.id,
        orderNumber: `ORD-SA1101-${RUN}-${seq}`,
        subtotal: 100,
        tax: 0,
        total: 100,
        status: "REFUSED",
      } as any,
    });
    const line = await prisma.orderItem.create({
      data: {
        tenantId,
        orderId: order.id,
        productId: product.id,
        name: product.name,
        position: 0,
        qty: 10,
        unitPrice: 10,
        subtotal: 100,
        deliveredQty: 0,
      } as any,
    });
    const invoice = await prisma.invoice.create({
      data: {
        tenantId,
        customerId: customer.id,
        orderId: order.id,
        invoiceNumber: `INV-SA1101-${RUN}-${seq}`,
        status: "SENT",
        subtotal: 0,
        taxAmount: 0,
        total: 0,
      },
    });
    await prisma.invoiceItem.create({
      data: {
        tenantId,
        invoiceId: invoice.id,
        orderItemId: line.id,
        productId: product.id,
        description: "P",
        qty: 0,
        unitPrice: 10,
        subtotal: 0,
      } as any,
    });
    return {
      tenantId,
      customerId: customer.id,
      userId: user.id,
      orderId: order.id,
      productId: product.id,
      lineId: line.id,
    };
  }
  type Seed = Awaited<ReturnType<typeof seedRefused>>;

  const create = (s: Seed, role: string) =>
    tenantCtx.run(s.tenantId, () =>
      returns.create(
        {
          orderId: s.orderId,
          reason: "CUSTOMER_REFUSED",
          items: [{ productId: s.productId, orderItemId: s.lineId, qty: 10 }],
        } as any,
        s.userId,
        role,
      ),
    );

  it("RO-9: staff record a return on a REFUSED order; receiving it puts the goods back; the credit is observed", async () => {
    const s = await seedRefused("ro9");
    const ret: any = await create(s, "OPERATOR");
    expect(ret.id).toBeTruthy();
    await tenantCtx.run(s.tenantId, () => returns.approve(ret.id));
    await tenantCtx.run(s.tenantId, () => returns.receive(ret.id, s.userId, { restock: true }));
    const moved = await prisma.stockMovement.findMany({
      where: { productId: s.productId, type: "RETURN" },
    });
    expect(moved.map((m) => Number(m.quantity))).toEqual([10]);

    // OBSERVED (SA-1101 §2.5): the credit this return earns on a $0 refused invoice. $0 expected.
    // Two branches are allowed, and ONLY these two: the refund door answers "nothing was billed" (the observed
    // one), or it mints no credit above $0. A refund that throws for any OTHER reason is a red test, not a $0.
    let note = "credit note minted";
    try {
      await tenantCtx.run(s.tenantId, () => returns.processRefund(ret.id));
    } catch (e) {
      const message = (e as Error).message;
      expect(message).toContain("None of the returned items were billed on this order");
      note = "refund door answered: nothing was billed";
    }
    const notes = await prisma.creditNote.findMany({
      where: { tenantId: s.tenantId, status: { not: "VOID" } },
    });
    const credit = notes.reduce((sum, n) => sum + Number(n.amount), 0);
    console.info(`SA-1101 RO-9 observed credit on a refused-line return: $${credit} (${note})`);
    expect(credit).toBe(0);
  });

  it("RO-9b: a CUSTOMER on the same REFUSED order gets the 400 and nothing is written", async () => {
    const s = await seedRefused("ro9b");
    await expect(create(s, "CUSTOMER")).rejects.toThrow(
      "Returns can only be submitted for delivered orders",
    );
    expect(await prisma.return.count({ where: { tenantId: s.tenantId } })).toBe(0);
  });
});
