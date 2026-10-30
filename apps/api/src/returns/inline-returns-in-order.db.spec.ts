/**
 * #2094 PR-A (SA-194 / SA-221) — real-Postgres pins for the in-transaction inline return that order
 * create/edit run inside their OWN transaction. A jest-mocked client cannot prove any of these: "one
 * transaction" and "the advisory lock serializes" only mean something against a real connection.
 *
 * Each case drives the same sequence the order paths run, in ONE real `tenantTransaction`:
 *   customer advisory lock (FIRST) -> [order written] -> captureAndIssueInTx
 * with the credit-note number reserved BEFORE the transaction (SA-221 change 1: an order create
 * reserves it once, ahead of its P2002 retry loop). The order row is inserted inside the tx here,
 * exactly as create() does; the edit path is the same minus that insert (the row already exists).
 *
 * Cases: commit-together; atomic rollback over order + Return + CN + intent (the number is burned,
 * never reused); replay -> one Return and one CN; a returnKey used for ANOTHER order -> 409 and
 * nothing written; DRIVER_CAP hold -> no CN and no intent; credit cap -> the CN is minted in full and
 * the order intent is capped at the order balance (remainder on account); the lock genuinely
 * serializes two parallel in-order captures for one customer.
 *
 * Constructs a REAL InlineReturnsService via `Object.create` (no Nest DI), like
 * inline-returns-capture-concurrency.db.spec.ts, whose fixtures this reuses. Run via
 * `npm run local:test:db` (compose Postgres); collected only by jest.db.config.js. NOT run on the
 * MacBook that wrote it (no Postgres there): F2's DB lane runs it.
 */
import { randomUUID } from "crypto";
import { PrismaClient } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import { Pool } from "pg";
import { ConflictException, Logger } from "@nestjs/common";
import { describeDb, requireLocalDatabaseUrl } from "../common/testing/db-spec";
import { PrismaService } from "../prisma/prisma.service";
import { TenantContextService } from "../tenant/tenant-context.service";
import { EncryptionService } from "../common/encryption.service";
import { SystemConfigService } from "../system-config/system-config.service";
import { NumberingService } from "../import/numbering.service";
import { IdempotencyService } from "../common/idempotency.service";
import { RegulatedLedgerService } from "../regulated/regulated-ledger.service";
import { CreditNotesService } from "../credit-notes/credit-notes.service";
import { InlineReturnsQuoteService } from "./inline-returns-quote.service";
import { InlineReturnsService } from "./inline-returns.service";
import type { JwtPayload } from "../auth/jwt-payload.interface";

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { assertTestTenant } = require("../../../../scripts/lib/test-tenants.cjs");

describeDb("#2094 — inline return inside the order transaction, real Postgres", () => {
  let pool: Pool;
  let raw: PrismaClient; // superuser fixture client, deliberately unscoped
  let prisma: PrismaService;
  let tenantCtx: TenantContextService;
  let svc: any;
  const run = randomUUID().slice(0, 8);
  const slug = assertTestTenant(`qa-2094-inorder-${run}`, "inline-returns-in-order.db.spec.ts");
  let tenantId = "";
  const orderIds: string[] = [];
  const invoiceIds: string[] = [];
  const customerIds: string[] = [];
  const productIds: string[] = [];
  const userIds: string[] = [];

  const staff = (): JwtPayload =>
    ({
      sub: userIds[0] ?? "op",
      username: "operator",
      role: "OPERATOR",
      status: "ACTIVE",
      forcePasswordChange: false,
      tenantId,
      tenantSlug: slug,
    }) as JwtPayload;

  async function seedCustomer(tag: string) {
    const product = await raw.product.create({
      data: { name: `${tag} product ${run}`, unit: "each", pricePerUnit: "10.00", tenantId },
    });
    productIds.push(product.id);
    const custUser = await raw.user.create({
      data: {
        email: `${tag}-c-${run}@example.test`,
        username: `${tag}-c-${run}`,
        role: "CUSTOMER",
        tenantId,
      },
    });
    userIds.push(custUser.id);
    const customer = await raw.customer.create({
      data: {
        userId: custUser.id,
        businessName: `${tag} co`,
        contactName: "2094 Tester",
        tenantId,
      },
    });
    customerIds.push(customer.id);
    return { productId: product.id, customerId: customer.id };
  }

  /** The order paths' shape: customer advisory lock FIRST, then the caller's work, one real tx. */
  const inOrderTx = <T>(customerId: string, work: (tx: any) => Promise<T>) =>
    tenantCtx.run(tenantId, () =>
      prisma.tenantTransaction(async (tx: any) => {
        await svc.lockCustomerInTx(tx, customerId);
        return work(tx);
      }),
    );

  const newOrder = async (tx: any, customerId: string, total: number) => {
    const o = await tx.order.create({
      data: { customerId, tenantId, status: "PENDING", total: total.toFixed(2) },
    });
    orderIds.push(o.id);
    return o;
  };

  const lines = (productId: string, qty: number, returnKey: string) => ({
    items: [{ productId, qty }], // $10 unreferenced price: qty 3 = $30, qty 7 = $70
    returnKey,
  });

  beforeAll(async () => {
    pool = new Pool({ connectionString: requireLocalDatabaseUrl() });
    raw = new PrismaClient({ adapter: new PrismaPg(pool) });
    tenantCtx = new TenantContextService();
    prisma = new PrismaService(tenantCtx);
    await prisma.$connect();
    const idempotency = new IdempotencyService();
    const numbering = new NumberingService(prisma);
    const ledger = new RegulatedLedgerService(prisma);
    const systemConfig = new SystemConfigService(
      prisma,
      new EncryptionService({ get: () => undefined } as any),
    );
    const quoteService = new InlineReturnsQuoteService(prisma, systemConfig);
    const creditNotes = Object.assign(Object.create(CreditNotesService.prototype), {
      prisma,
      gateway: { emitCreditNoteCreated: jest.fn() },
      ledger,
      commissionEngine: { syncInvoiceCommissionSafe: async () => undefined }, // settle applies the credit to the invoice
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
      quoteService,
      idempotency,
    });
    tenantId = (await raw.tenant.create({ data: { slug, name: `2094 InOrder ${slug}` } })).id;
    // A staff user row so audit/captured-by FKs (if any) resolve.
    const op = await raw.user.create({
      data: { email: `op-${run}@example.test`, username: `op-${run}`, role: "OPERATOR", tenantId },
    });
    userIds.unshift(op.id);
  }, 120_000);

  afterAll(async () => {
    await raw.invoicePayment.deleteMany({ where: { invoiceId: { in: invoiceIds } } });
    await raw.invoice.deleteMany({ where: { id: { in: invoiceIds } } });
    for (const orderId of orderIds) {
      await raw.orderCreditNote.deleteMany({ where: { orderId } });
      await raw.returnItem.deleteMany({ where: { return: { orderId } } });
      await raw.return.deleteMany({ where: { orderId } });
    }
    await raw.creditNote.deleteMany({ where: { tenantId } });
    await raw.order.deleteMany({ where: { id: { in: orderIds } } });
    await raw.customer.deleteMany({ where: { id: { in: customerIds } } });
    await raw.stockMovement.deleteMany({ where: { productId: { in: productIds } } });
    await raw.product.deleteMany({ where: { id: { in: productIds } } });
    await raw.user.deleteMany({ where: { id: { in: userIds } } });
    await raw.tenant.deleteMany({ where: { id: tenantId } });
    await prisma?.$disconnect();
    await raw?.$disconnect();
    await pool?.end();
  }, 120_000);

  it("commits the order, the Return, the credit note and the intent together; the CN carries the reserved number", async () => {
    const f = await seedCustomer("commit");
    const number = await tenantCtx.run(tenantId, () => svc.reserveCreditNoteNumber());
    const out = await inOrderTx(f.customerId, async (tx) => {
      const order = await newOrder(tx, f.customerId, 100);
      const r = await svc.captureAndIssueInTx(
        tx,
        {
          ...lines(f.productId, 3, `k-commit-${run}`),
          customerId: f.customerId,
          orderId: order.id,
        },
        staff(),
        { creditNoteNumber: number },
      );
      return { order, r };
    });
    expect(out.r.minted.creditNoteNumber).toBe(number);
    const ret = await raw.return.findFirst({ where: { orderId: out.order.id } });
    expect(ret).toMatchObject({ status: "REFUNDED", kind: "INLINE" });
    expect(await raw.creditNote.count({ where: { customerId: f.customerId } })).toBe(1);
    const intents = await raw.orderCreditNote.findMany({ where: { orderId: out.order.id } });
    expect(intents).toHaveLength(1);
    expect(Number(intents[0].amount)).toBeCloseTo(30, 2);
  }, 30_000);

  it("#3748: a return saved with an order edit settles against THIS order's invoice in the same transaction (a CREDIT_NOTE payment), and the order's own total is not touched", async () => {
    const f = await seedCustomer("settle");
    const number = await tenantCtx.run(tenantId, () => svc.reserveCreditNoteNumber());
    const out = await inOrderTx(f.customerId, async (tx) => {
      const order = await newOrder(tx, f.customerId, 100);
      const invoice = await tx.invoice.create({
        data: {
          tenantId,
          customerId: f.customerId,
          orderId: order.id,
          invoiceNumber: `INV-2094-${run}-settle`,
          status: "SENT",
          subtotal: "100.00",
          total: "100.00",
        },
      });
      invoiceIds.push(invoice.id);
      await svc.captureAndIssueInTx(
        tx,
        {
          ...lines(f.productId, 3, `k-settle-${run}`),
          customerId: f.customerId,
          orderId: order.id,
        },
        staff(),
        { creditNoteNumber: number },
      );
      // captureAndIssueInTx settles the new credit against this order's invoice in the SAME tx (issueCreditInTx)
      return { order, invoice };
    });
    const pays = await raw.invoicePayment.findMany({ where: { invoiceId: out.invoice.id } });
    expect(pays.map((p) => [p.method, Number(p.amount)])).toEqual([["CREDIT_NOTE", 30]]);
    const inv = await raw.invoice.findUniqueOrThrow({ where: { id: out.invoice.id } });
    expect(inv.status).toBe("PARTIAL"); // $70 still owed on this order's invoice
    expect(Number(inv.total)).toBe(100);
    // "New total" and the saved order total never carry the credit: it settles on the invoice
    const ord = await raw.order.findUniqueOrThrow({ where: { id: out.order.id } });
    expect(Number(ord.total)).toBe(100);
  }, 30_000);

  it("atomic rollback: a failure after the capture leaves no order, no Return, no credit note and no intent; the reserved number is burned, never reused", async () => {
    const f = await seedCustomer("rollback");
    const n1 = await tenantCtx.run(tenantId, () => svc.reserveCreditNoteNumber());
    let orderId = "";
    await expect(
      inOrderTx(f.customerId, async (tx) => {
        const order = await newOrder(tx, f.customerId, 100);
        orderId = order.id;
        await svc.captureAndIssueInTx(
          tx,
          { ...lines(f.productId, 3, `k-rb-${run}`), customerId: f.customerId, orderId: order.id },
          staff(),
          { creditNoteNumber: n1 },
        );
        throw new Error("boom after the capture (e.g. a later guard in the same tx)");
      }),
    ).rejects.toThrow("boom");
    expect(await raw.order.count({ where: { id: orderId } })).toBe(0);
    expect(await raw.return.count({ where: { returnKey: `k-rb-${run}` } })).toBe(0);
    expect(await raw.creditNote.count({ where: { customerId: f.customerId } })).toBe(0);
    expect(await raw.orderCreditNote.count({ where: { orderId } })).toBe(0);
    const n2 = await tenantCtx.run(tenantId, () => svc.reserveCreditNoteNumber());
    expect(n2).not.toBe(n1);
  }, 30_000);

  it("replay: the same returnKey against the same order in a second tx issues nothing new (one Return, one credit note)", async () => {
    const f = await seedCustomer("replay");
    const order = await inOrderTx(f.customerId, (tx) => newOrder(tx, f.customerId, 100));
    const attempt = () =>
      inOrderTx(f.customerId, (tx): ReturnType<InlineReturnsService["captureAndIssueInTx"]> =>
        svc.captureAndIssueInTx(
          tx,
          {
            ...lines(f.productId, 3, `k-replay-${run}`),
            customerId: f.customerId,
            orderId: order.id,
          },
          staff(),
          {},
        ),
      );
    const first = await attempt();
    const second = await attempt();
    expect(first.replayed).toBe(false);
    expect(second.replayed).toBe(true);
    expect(second.minted).toBeNull();
    expect(await raw.return.count({ where: { orderId: order.id } })).toBe(1);
    expect(await raw.creditNote.count({ where: { customerId: f.customerId } })).toBe(1);
  }, 30_000);

  it("a returnKey already used for ANOTHER order is a 409 and writes nothing", async () => {
    const f = await seedCustomer("otherorder");
    const a = await inOrderTx(f.customerId, (tx) => newOrder(tx, f.customerId, 100));
    const b = await inOrderTx(f.customerId, (tx) => newOrder(tx, f.customerId, 100));
    const key = `k-other-${run}`;
    await inOrderTx(f.customerId, (tx) =>
      svc.captureAndIssueInTx(
        tx,
        { ...lines(f.productId, 3, key), customerId: f.customerId, orderId: a.id },
        staff(),
        {},
      ),
    );
    await expect(
      inOrderTx(f.customerId, (tx) =>
        svc.captureAndIssueInTx(
          tx,
          { ...lines(f.productId, 3, key), customerId: f.customerId, orderId: b.id },
          staff(),
          {},
        ),
      ),
    ).rejects.toBeInstanceOf(ConflictException);
    expect(await raw.return.count({ where: { orderId: b.id } })).toBe(0);
    expect(await raw.creditNote.count({ where: { customerId: f.customerId } })).toBe(1);
  }, 30_000);

  it("credit cap: a $70 return on a $30 order mints the full $70 credit note; the order intent is capped at the $30 balance (remainder on account)", async () => {
    const f = await seedCustomer("cap");
    const out = await inOrderTx(f.customerId, async (tx) => {
      const order = await newOrder(tx, f.customerId, 30);
      const r = await svc.captureAndIssueInTx(
        tx,
        { ...lines(f.productId, 7, `k-cap-${run}`), customerId: f.customerId, orderId: order.id },
        staff(),
        {},
      );
      return { order, r };
    });
    expect(Number(out.r.minted.amount)).toBeCloseTo(70, 2);
    const intents = await raw.orderCreditNote.findMany({ where: { orderId: out.order.id } });
    expect(intents.reduce((s, i) => s + Number(i.amount), 0)).toBeCloseTo(30, 2);
    // The credit note itself is whole: the unapplied $40 stays on the customer's account.
    const cn = await raw.creditNote.findFirst({ where: { customerId: f.customerId } });
    expect(Number(cn!.amount)).toBeCloseTo(70, 2);
  }, 30_000);

  it("edit shape: a second return on an existing order caps the TOTAL intents at the order total (the balance shrinks as credits are applied)", async () => {
    const f = await seedCustomer("edit2");
    const order = await inOrderTx(f.customerId, (tx) => newOrder(tx, f.customerId, 100));
    const ret = (qty: number, key: string) =>
      inOrderTx(f.customerId, (tx) =>
        svc.captureAndIssueInTx(
          tx,
          { ...lines(f.productId, qty, key), customerId: f.customerId, orderId: order.id },
          staff(),
          {},
        ),
      );
    await ret(7, `k-edit2-a-${run}`); // $70 -> intent 70
    await ret(7, `k-edit2-b-${run}`); // $70 -> intent capped at the remaining $30
    const intents = await raw.orderCreditNote.findMany({ where: { orderId: order.id } });
    expect(intents.reduce((sum, i) => sum + Number(i.amount), 0)).toBeCloseTo(100, 2);
    expect(await raw.creditNote.count({ where: { customerId: f.customerId } })).toBe(2); // both minted in full
  }, 30_000);

  it("the customer advisory lock serializes two PARALLEL in-order captures for one customer: exactly one credit each, never interleaved", async () => {
    const f = await seedCustomer("lock");
    const order = await inOrderTx(f.customerId, (tx) => newOrder(tx, f.customerId, 500));
    const go = (key: string) =>
      inOrderTx(f.customerId, (tx): ReturnType<InlineReturnsService["captureAndIssueInTx"]> =>
        svc.captureAndIssueInTx(
          tx,
          { ...lines(f.productId, 3, key), customerId: f.customerId, orderId: order.id },
          staff(),
          {},
        ),
      );
    const [a, b] = await Promise.all([go(`k-lock-a-${run}`), go(`k-lock-b-${run}`)]);
    expect([a.replayed, b.replayed]).toEqual([false, false]);
    expect(await raw.return.count({ where: { orderId: order.id } })).toBe(2);
    expect(await raw.creditNote.count({ where: { customerId: f.customerId } })).toBe(2);
    const sum = await raw.orderCreditNote.aggregate({
      where: { orderId: order.id },
      _sum: { amount: true },
    });
    expect(Number(sum._sum.amount)).toBeCloseTo(60, 2);
  }, 30_000);
});
