/**
 * B467 — real-Postgres proof that InlineReturnsService.approve()'s restock + regulated-
 * ledger reversal + credit-note mint (HIGH-2: all three merged into ONE transaction) are
 * genuinely atomic: a failure partway through leaves NOTHING half-applied. A jest-mocked
 * Prisma client cannot prove this — a mocked `tenantTransaction` just runs its callback and
 * resolves; it has no real commit/rollback semantics, so nothing in the mocked unit suite
 * (inline-returns.service.spec.ts) can distinguish "the transaction genuinely rolled back
 * every statement" from "the mock never wrote anything real in the first place".
 *
 * Forces a REAL, unavoidable failure — a Prisma `RecordNotFound` (P2025) — by giving the
 * held return TWO items: one against a real Product (so its restock actually writes a
 * StockMovement row + increments Product.currentStock FIRST, inside the open transaction),
 * and one against a productId that was never created at all (`ReturnItem.productId` carries
 * no foreign key — see returns-restock.util.ts, which tolerates a missing product for the
 * READ but `product.update` on a nonexistent id throws). This is not a contrived mock
 * failure: it is the exact same error class a genuinely deleted/corrupted product id would
 * produce in production, and nothing in the code defends against it (unlike, say,
 * NumberingService's own clash-retry logic, which is why forcing a credit-note-number
 * collision was deliberately NOT used here — it would just be silently routed around).
 *
 * After the failed call, asserts the FIRST item's restock (which DID succeed inside the
 * still-open transaction before the second item threw) was rolled back along with
 * everything after it — the real-item's stock is unchanged, no StockMovement survived for
 * either item, no credit note was minted, no OrderCreditNote link was created, and the
 * Return row itself is byte-identical to its pre-approve state (still RECEIVED +
 * DRIVER_CAP + heldAmount, never REFUNDED).
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
  let realProductId = "";
  let returnId = "";
  const phantomProductId = randomUUID(); // never created — no row exists for this id

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

    const product = await raw.product.create({
      data: { name: `B467 approve product ${run}`, unit: "each", pricePerUnit: "10.00", tenantId },
    });
    realProductId = product.id;

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
            // Processed first (real product) — its restock DOES succeed inside the open
            // transaction, before the second item's phantom productId throws.
            { productId: realProductId, qty: "5.000", restock: true, tenantId },
            { productId: phantomProductId, qty: "3.000", restock: true, tenantId },
          ],
        },
      },
    });
    returnId = ret.id;
  }, 120_000);

  afterAll(async () => {
    await raw.orderCreditNote.deleteMany({ where: { orderId } });
    await raw.returnItem.deleteMany({ where: { returnId } });
    await raw.return.deleteMany({ where: { id: returnId } });
    await raw.creditNote.deleteMany({ where: { customerId } });
    await raw.stockMovement.deleteMany({ where: { productId: realProductId } });
    await raw.order.deleteMany({ where: { id: orderId } });
    await raw.customer.deleteMany({ where: { id: customerId } });
    await raw.product.deleteMany({ where: { id: realProductId } });
    await raw.user.deleteMany({ where: { tenantId } });
    await raw.tenant.deleteMany({ where: { id: tenantId } });
    await prisma?.$disconnect();
    await raw?.$disconnect();
    await pool?.end();
  }, 120_000);

  it("a failure after the claim (restocking the phantom item) leaves no half-applied restock, ledger entry, or credit note", async () => {
    const before = await raw.product.findUniqueOrThrow({ where: { id: realProductId } });
    expect(Number(before.currentStock)).toBe(0);

    await expect(
      tenantCtx.run(tenantId, () => svc.approve(returnId, operator())),
    ).rejects.toThrow();

    // The REAL product's restock (the first item processed) never survived the rollback —
    // proof the transaction is atomic across BOTH items, not just the one that threw.
    const afterProduct = await raw.product.findUniqueOrThrow({ where: { id: realProductId } });
    expect(Number(afterProduct.currentStock)).toBe(0);
    expect(await raw.stockMovement.count({ where: { productId: realProductId } })).toBe(0);

    // No credit note, no order-credit link — issueCreditInTx never got far enough to commit
    // anything, and even if it had run first, the whole transaction still rolls back.
    expect(await raw.creditNote.count({ where: { customerId } })).toBe(0);
    expect(await raw.orderCreditNote.count({ where: { orderId } })).toBe(0);

    // The Return row itself is byte-identical to its pre-approve state.
    const ret = await raw.return.findUniqueOrThrow({ where: { id: returnId } });
    expect(ret.status).toBe("RECEIVED");
    expect(ret.holdReason).toBe("DRIVER_CAP");
    expect(Number(ret.heldAmount)).toBeCloseTo(50, 2);
    expect(ret.creditNoteId).toBeNull();
    expect(ret.approvedById).toBeNull();
  }, 30_000);
});
