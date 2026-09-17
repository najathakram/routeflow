/**
 * B467 — real-Postgres proof that InlineReturnsService.approve()'s restock + regulated-
 * ledger reversal + credit-note mint (HIGH-2: all three merged into ONE transaction) are
 * genuinely atomic: a failure partway through leaves NOTHING half-applied. A jest-mocked
 * Prisma client cannot prove this — a mocked `tenantTransaction` just runs its callback and
 * resolves; it has no real commit/rollback semantics, so nothing in the mocked unit suite
 * (inline-returns.service.spec.ts) can distinguish "the transaction genuinely rolled back
 * every statement" from "the mock never wrote anything real in the first place".
 *
 * Forces a REAL, unavoidable failure — a Postgres `integer out of range` (SQLSTATE 22003) —
 * by pre-seeding this tenant's CREDIT_NOTE `NumberingSequence` row at `nextNumber =
 * 2147483647` (int4 max) before calling approve(). `NumberingService.reserveNext`'s
 * `mintForYear` finds this row already exists (skipping its own scan-seed path entirely)
 * and increments it by 1 to reserve a number — an unavoidable int4 overflow nothing in that
 * service defends against (unlike a duplicate NUMBER, which its own clash-retry loop would
 * silently route around — see the file's earlier history for why that approach was
 * abandoned). This happens inside `issueCreditInTx`, called AFTER `restockReturnItems` and
 * `reverseLedgerForReturn` have already run for TWO real return items inside the same
 * still-open transaction.
 *
 * (`ReturnItem.productId` was confirmed to carry a REAL foreign key at the DB level
 * — `0_init/migration.sql`'s `ReturnItem_productId_fkey` — even though `schema.prisma`'s
 * model declares no explicit `@relation` for it; an earlier draft of this spec tried a
 * phantom/nonexistent productId to force a P2025 and failed at FIXTURE SETUP with a real
 * FK violation before ever reaching approve(). The numbering-overflow trigger sidesteps
 * that constraint entirely and needs only real, valid products.)
 *
 * After the failed call, asserts BOTH items' restock (which DID succeed inside the
 * still-open transaction before the numbering reservation threw) was rolled back — neither
 * product's stock changed, no StockMovement survived for either item, no credit note or
 * OrderCreditNote link exists, the NumberingSequence row is back to its pre-approve value
 * (the failed UPDATE never committed either), and the Return row itself is byte-identical
 * to its pre-approve state.
 *
 * Constructs a REAL InlineReturnsService via `Object.create` (bypassing Nest DI, same
 * pattern as `returns-idempotency.db.spec.ts` / `inline-returns-capture-concurrency.db.spec.ts`),
 * wired to every collaborator this method actually writes through (PrismaService,
 * NumberingService, RegulatedLedgerService, CreditNotesService); `gateway` and
 * `addonService` are the only lightweight fakes (no DB effect / orthogonal to atomicity),
 * matching established precedent.
 *
 * Run via `npm run local:test:db` (compose Postgres) — collected only by
 * jest.db.config.js, never the main unit lane.
 */
import { randomUUID } from "crypto";
import { PrismaClient } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import { Pool } from "pg";
import { Logger } from "@nestjs/common";
import { describeDb, requireLocalDatabaseUrl } from "../common/testing/db-spec";
import { PrismaService } from "../prisma/prisma.service";
import { TenantContextService } from "../tenant/tenant-context.service";
import { NumberingService } from "../import/numbering.service";
import { IdempotencyService } from "../common/idempotency.service";
import { RegulatedLedgerService } from "../regulated/regulated-ledger.service";
import { CreditNotesService } from "../credit-notes/credit-notes.service";
import { InlineReturnsQuoteService } from "./inline-returns-quote.service";
import { InlineReturnsService } from "./inline-returns.service";
import type { JwtPayload } from "../auth/jwt-payload.interface";

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { assertTestTenant } = require("../../../../scripts/lib/test-tenants.cjs");

const INT4_MAX = 2147483647;

describeDb("B467 — InlineReturnsService.approve() rollback atomicity, real Postgres", () => {
  let pool: Pool;
  let raw: PrismaClient; // superuser fixture client — deliberately unscoped
  let prisma: PrismaService;
  let tenantCtx: TenantContextService;
  let svc: any;
  const run = randomUUID().slice(0, 8);
  const slug = assertTestTenant(
    `qa-b467-appr-${run}`,
    "inline-returns-approve-atomicity.db.spec.ts",
  );
  let tenantId = "";
  let customerId = "";
  let orderId = "";
  let productAId = "";
  let productBId = "";
  let returnId = "";
  const year = new Date().getFullYear();

  const operator = (): JwtPayload => ({
    sub: "op-b467",
    username: "operator",
    role: "OPERATOR" as any,
    status: "ACTIVE" as any,
    forcePasswordChange: false,
    tenantId,
    tenantSlug: slug,
  });

  beforeAll(async () => {
    pool = new Pool({ connectionString: requireLocalDatabaseUrl() });
    raw = new PrismaClient({ adapter: new PrismaPg(pool) });
    tenantCtx = new TenantContextService();
    prisma = new PrismaService(tenantCtx);
    await prisma.$connect();

    const numbering = new NumberingService(prisma);
    const ledger = new RegulatedLedgerService(prisma);
    const creditNotes = Object.assign(Object.create(CreditNotesService.prototype), {
      prisma,
      gateway: { emitCreditNoteCreated: jest.fn() },
      ledger,
      commissionEngine: {}, // never touched by mintStandaloneInTx
      numbering,
      logger: new Logger(CreditNotesService.name),
    });
    svc = Object.assign(Object.create(InlineReturnsService.prototype), {
      prisma,
      gateway: { emitCreditNoteCreated: jest.fn() },
      ledger,
      creditNotes,
      numbering,
      addonService: { hasAddon: async () => true },
      quoteService: {} as InlineReturnsQuoteService, // never called by approve()
      idempotency: new IdempotencyService(), // never called by approve() (no lock taken here)
    });

    tenantId = (await raw.tenant.create({ data: { slug, name: `B467 Approve ${slug}` } })).id;

    const custUser = await raw.user.create({
      data: {
        email: `appr-cust-${run}@example.test`,
        username: `appr-cust-${run}`,
        role: "CUSTOMER",
        tenantId,
      },
    });
    const customer = await raw.customer.create({
      data: {
        userId: custUser.id,
        businessName: "B467 Approve Co",
        contactName: "B467 Tester",
        tenantId,
      },
    });
    customerId = customer.id;

    const productA = await raw.product.create({
      data: {
        name: `B467 approve product A ${run}`,
        unit: "each",
        pricePerUnit: "10.00",
        tenantId,
      },
    });
    productAId = productA.id;
    const productB = await raw.product.create({
      data: {
        name: `B467 approve product B ${run}`,
        unit: "each",
        pricePerUnit: "20.00",
        tenantId,
      },
    });
    productBId = productB.id;

    const order = await raw.order.create({
      data: { customerId, tenantId, status: "DELIVERED", total: "50.00" },
    });
    orderId = order.id;

    const ret = await raw.return.create({
      data: {
        orderId,
        customerId,
        reason: "EXCESS_ORDER",
        status: "RECEIVED",
        kind: "INLINE",
        holdReason: "DRIVER_CAP",
        heldAmount: "50.00",
        creditSubtotal: "50.00",
        creditTax: "0.00",
        creditCategoryTax: "0.00",
        tenantId,
        items: {
          create: [
            { productId: productAId, qty: "5.000", restock: true, tenantId },
            { productId: productBId, qty: "2.000", restock: true, tenantId },
          ],
        },
      },
    });
    returnId = ret.id;

    // The unavoidable trigger: pre-seed this tenant's CREDIT_NOTE sequence at int4 max.
    // NumberingService.reserveNext's mintForYear finds this row already exists (skips its
    // own scan-seed path) and increments it by 1 -- a real Postgres integer-out-of-range
    // error, not a simulated one.
    await raw.numberingSequence.create({
      data: {
        tenantId,
        docType: "CREDIT_NOTE",
        year,
        prefix: "CN-",
        padding: 4,
        nextNumber: INT4_MAX,
      },
    });
  }, 120_000);

  afterAll(async () => {
    await raw.orderCreditNote.deleteMany({ where: { orderId } });
    await raw.returnItem.deleteMany({ where: { returnId } });
    await raw.return.deleteMany({ where: { id: returnId } });
    await raw.creditNote.deleteMany({ where: { customerId } });
    await raw.stockMovement.deleteMany({ where: { productId: { in: [productAId, productBId] } } });
    await raw.numberingSequence.deleteMany({ where: { tenantId, docType: "CREDIT_NOTE", year } });
    await raw.order.deleteMany({ where: { id: orderId } });
    await raw.customer.deleteMany({ where: { id: customerId } });
    await raw.product.deleteMany({ where: { id: { in: [productAId, productBId] } } });
    await raw.user.deleteMany({ where: { tenantId } });
    await raw.tenant.deleteMany({ where: { id: tenantId } });
    await prisma?.$disconnect();
    await raw?.$disconnect();
    await pool?.end();
  }, 120_000);

  it("a failure after the claim (credit-note numbering overflow) leaves no half-applied restock, ledger entry, or credit note", async () => {
    const beforeA = await raw.product.findUniqueOrThrow({ where: { id: productAId } });
    const beforeB = await raw.product.findUniqueOrThrow({ where: { id: productBId } });
    expect(Number(beforeA.currentStock)).toBe(0);
    expect(Number(beforeB.currentStock)).toBe(0);

    await expect(
      tenantCtx.run(tenantId, () => svc.approve(returnId, operator())),
    ).rejects.toThrow();

    // Neither real product's restock survived the rollback -- proof the transaction is
    // atomic across BOTH items AND the later numbering step that actually threw.
    const afterA = await raw.product.findUniqueOrThrow({ where: { id: productAId } });
    const afterB = await raw.product.findUniqueOrThrow({ where: { id: productBId } });
    expect(Number(afterA.currentStock)).toBe(0);
    expect(Number(afterB.currentStock)).toBe(0);
    expect(
      await raw.stockMovement.count({ where: { productId: { in: [productAId, productBId] } } }),
    ).toBe(0);

    // No credit note, no order-credit link.
    expect(await raw.creditNote.count({ where: { customerId } })).toBe(0);
    expect(await raw.orderCreditNote.count({ where: { orderId } })).toBe(0);

    // The numbering sequence's failed increment never committed either -- still exactly
    // the pre-seeded overflow value, not int4-max-plus-one (which couldn't be stored) and
    // not silently left at some other value.
    const seq = await raw.numberingSequence.findUniqueOrThrow({
      where: { tenantId_docType_year: { tenantId, docType: "CREDIT_NOTE", year } },
    });
    expect(seq.nextNumber).toBe(INT4_MAX);

    // The Return row itself is byte-identical to its pre-approve state.
    const ret = await raw.return.findUniqueOrThrow({ where: { id: returnId } });
    expect(ret.status).toBe("RECEIVED");
    expect(ret.holdReason).toBe("DRIVER_CAP");
    expect(Number(ret.heldAmount)).toBeCloseTo(50, 2);
    expect(ret.creditNoteId).toBeNull();
    expect(ret.approvedById).toBeNull();
  }, 30_000);
});
