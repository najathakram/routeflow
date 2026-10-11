/**
 * #2070 / SA-523, real Postgres: two partial invoices racing for the last 96 pieces of a line.
 *
 * T2 (a raw pg connection) holds the OrderItem row FOR UPDATE. Partials A and B both read
 * `remaining = 96` (plain reads, not blocked). Since SA-706 each creation takes the ORDER row lock as
 * its first statement, so they no longer both reach the bump: A takes the Order, creates its invoice
 * and blocks on T2 at the invoicedQty bump; B is blocked BY A on the Order row (observed via
 * `pg_blocking_pids` with `pg_stat_clear_snapshot()` per poll: one pair "A blocked by T2, B blocked by
 * A"; without the Order lock both would wait on T2 and the pair would not exist). T2 commits without
 * changing anything; A finishes, B then runs on its OWN stale read:
 *   - fixed code (a CAS on the read invoicedQty/qty/status): exactly one 201 and one 409;
 *     invoicedQty = 96; one invoice for the order (the loser's invoice rolled back);
 *   - with the CAS replaced by an unconditional increment: both succeed; invoicedQty = 192; two
 *     invoices (the outcome case goes red). The CAS is ALSO pinned directly, below, by two bumps off
 *     the same stale read, because the Order lock now serialises the service paths ahead of it.
 * Second case (SA-523, recommended): T2 CANCELs the line while A waits ⇒ A gets a 409 and no
 * invoice exists; pre-fix, A bills a cancelled line.
 * No spy and no symbol from partial-invoice-cas.ts.
 *
 * Runs only under `npm run local:test:db` (jest.db.config.js collects `*.db.spec.ts`; RUN_DB_SPECS
 * set, DATABASE_URL pointed at the compose/dbspec Postgres). Tenants are throwaway
 * `qa-2070-<run>-<n>` slugs approved by `assertTestTenant`; `afterAll` deletes what they hold.
 */

// Prevent Jest from traversing ESM-only dependencies (same guard as invoices.service.spec.ts /
// invoice-numbering.db.spec.ts).
jest.mock("./invoice-pdf.service", () => ({
  InvoicePdfService: jest.fn().mockImplementation(() => ({
    getOrGenerate: jest.fn().mockResolvedValue("https://example.com/invoice.pdf"),
  })),
}));
jest.mock("../storage/compress.util", () => ({
  compressDocument: jest.fn(),
}));

import { Test, TestingModule } from "@nestjs/testing";
import { randomUUID } from "crypto";
import { InvoicesService } from "./invoices.service";
import { InvoicePdfService } from "./invoice-pdf.service";
import { PrismaService } from "../prisma/prisma.service";
import { TenantContextService } from "../tenant/tenant-context.service";
import { RouteFlowGateway } from "../gateways/routeflow.gateway";
import { EmailService } from "../email/email.service";
import { SystemConfigService } from "../system-config/system-config.service";
import { RegulatedLedgerService } from "../regulated/regulated-ledger.service";
import { AuthorizationGuardService } from "../authorizations/authorization-guard.service";
import { CreditNotesService } from "../credit-notes/credit-notes.service";
import { MessagingService } from "../messaging/messaging.service";
import { StorageService } from "../storage/storage.service";
import { EntitlementsService } from "../billing/entitlements.service";
import { entitlementAuthorityFromEntitlements } from "../testing/entitlement-authority-provider";
import { CommissionEngineService } from "../sales-agents/commission-engine.service";
import { EstimatesService } from "../estimates/estimates.service";
import { NumberingService } from "../import/numbering.service";
import { describeDb, requireLocalDatabaseUrl } from "../common/testing/db-spec";
import { SellingRestrictionsService } from "../selling-restrictions/selling-restrictions.service";
import { AfterCommit } from "../common/after-commit";

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { assertTestTenant } = require("../../../../scripts/lib/test-tenants.cjs");

import { Client } from "pg";
import { bumpInvoicedQtyCas } from "./partial-invoice-cas";
import { ConflictException } from "@nestjs/common";

const RUN_SUFFIX = randomUUID().slice(0, 8);
let tenantSeq = 0;
function freshTenantSlug(): string {
  tenantSeq += 1;
  return assertTestTenant(
    `qa-2070-${RUN_SUFFIX}-${tenantSeq}`,
    "partial-invoice-cas-2070.db.spec.ts",
  );
}

describeDb("partial invoices: concurrent partials never over-bill a line (#2070, SA-523)", () => {
  let prisma: PrismaService;
  let tenantCtx: TenantContextService;
  let invoicesService: InvoicesService;
  const createdTenantIds: string[] = [];

  const mockGateway = {
    emitInvoiceUpdated: jest.fn(),
    emitOrderCreated: jest.fn(),
    emitOrderStatusChanged: jest.fn(),
    emitLowStock: jest.fn(),
    emitStopCompleted: jest.fn(),
    emitUrgentOrder: jest.fn(),
  };
  const mockEmailService = {
    sendInvoice: jest.fn().mockResolvedValue({ delivered: true, transport: "resend" }),
    isEmailConfigured: jest.fn().mockResolvedValue(true),
  };
  const mockSystemConfig = {
    get: jest.fn().mockResolvedValue(null),
    set: jest.fn().mockResolvedValue(undefined),
  };
  const mockCreditNotes = {
    autoApplyOldestCreditsInTx: jest.fn().mockResolvedValue({ applied: 0, invoiceStatus: null }),
    settleOrderCreditsInTx: jest.fn().mockResolvedValue({ applied: 0, unapplied: 0 }),
    releaseInvoiceCreditsInTx: jest.fn().mockResolvedValue([]),
  };
  const mockMessaging = {
    notify: jest.fn().mockResolvedValue([]),
    notifyEvent: jest.fn().mockResolvedValue(undefined),
  };
  const mockStorage = {
    upload: jest.fn().mockResolvedValue("stored"),
    presignedUrl: jest.fn().mockResolvedValue("https://signed/url"),
    delete: jest.fn().mockResolvedValue(undefined),
  };
  // flag.msrp OFF: applyMsrpSnapshots no-ops.
  const mockEntitlements = { hasFlag: jest.fn().mockResolvedValue(false) };
  const mockCommissionEngine = {
    syncInvoiceCommissionSafe: jest.fn().mockResolvedValue(undefined),
    syncOrderInvoices: jest.fn().mockResolvedValue(undefined),
    removeInvoiceCommission: jest.fn().mockResolvedValue(undefined),
  };

  beforeAll(async () => {
    // Nothing env-dependent may run at collection time (db-lane rule): the real connection is
    // built here, inside a hook, never at module top level.
    requireLocalDatabaseUrl();
    tenantCtx = new TenantContextService();
    prisma = new PrismaService(tenantCtx);
    await prisma.$connect();

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        InvoicesService,
        {
          provide: SellingRestrictionsService,
          useValue: { assertLinesSellable: jest.fn().mockResolvedValue(undefined) },
        },
        EstimatesService,
        NumberingService,
        { provide: PrismaService, useValue: prisma },
        { provide: RouteFlowGateway, useValue: mockGateway },
        { provide: EmailService, useValue: mockEmailService },
        { provide: InvoicePdfService, useValue: { getOrGenerate: jest.fn() } },
        { provide: SystemConfigService, useValue: mockSystemConfig },
        {
          provide: RegulatedLedgerService,
          useValue: {
            writeSaleEntries: jest.fn(),
            reverseInvoiceEntries: jest.fn(),
            syncInvoiceEntries: jest.fn(),
          },
        },
        {
          provide: AuthorizationGuardService,
          useValue: {
            assertAuthorizedOrThrow: jest.fn().mockResolvedValue(undefined),
            checkAuthorized: jest.fn().mockResolvedValue({ blocked: [] }),
          },
        },
        { provide: CreditNotesService, useValue: mockCreditNotes },
        { provide: MessagingService, useValue: mockMessaging },
        { provide: StorageService, useValue: mockStorage },
        { provide: EntitlementsService, useValue: mockEntitlements },
        entitlementAuthorityFromEntitlements, // #2241: EntitlementAuthority
        { provide: CommissionEngineService, useValue: mockCommissionEngine },
      ],
    }).compile();

    invoicesService = module.get(InvoicesService);
  });

  afterAll(async () => {
    for (const tenantId of createdTenantIds) {
      const where = { tenantId };
      // eslint-disable-next-line no-await-in-loop
      await (async () => {
        await prisma.invoiceItem.deleteMany({ where });
        await prisma.invoice.deleteMany({ where });
        await prisma.orderItem.deleteMany({ where: { order: { tenantId } } });
        await prisma.order.deleteMany({ where });
        await prisma.product.deleteMany({ where });
        await prisma.customer.deleteMany({ where });
        await prisma.user.deleteMany({ where });
        await prisma.tenant.deleteMany({ where: { id: tenantId } });
      })().catch(() => undefined);
    }
    await prisma?.$disconnect();
  });

  /** A CONFIRMED order with one 96-piece line, nothing invoiced yet. */
  async function seedLine() {
    const slug = freshTenantSlug();
    const tenant = await prisma.tenant.create({ data: { slug, name: `2070 ${slug}` } });
    createdTenantIds.push(tenant.id);
    const user = await prisma.user.create({
      data: {
        email: `${slug}@example.invalid`,
        username: slug,
        role: "CUSTOMER",
        tenantId: tenant.id,
      },
    });
    const customer = await prisma.customer.create({
      data: {
        userId: user.id,
        businessName: "2070",
        contactName: "2070",
        tenantId: tenant.id,
      } as any,
    });
    const product = await prisma.product.create({
      data: { name: `2070 ${slug}`, unit: "ea", pricePerUnit: 10, tenantId: tenant.id } as any,
    });
    const order = await prisma.order.create({
      data: {
        tenantId: tenant.id,
        customerId: customer.id,
        orderNumber: `ORD-2070-${slug}`,
        status: "CONFIRMED",
        subtotal: 960,
        total: 960,
      } as any,
    });
    const item = await prisma.orderItem.create({
      data: {
        orderId: order.id,
        productId: product.id,
        qty: 96,
        unitPrice: 10,
        subtotal: 960,
        status: "CONFIRMED",
        tenantId: tenant.id,
      } as any,
    });
    return { tenantId: tenant.id, orderId: order.id, orderItemId: item.id };
  }

  /** T2 holds the OrderItem row; `starts` run and must block (`waiters` of them); `during(t2)`; T2 commits. */
  async function holdLine(
    orderItemId: string,
    starts: Array<() => Promise<unknown>>,
    during: (t2: Client) => Promise<void> = async () => undefined,
  ) {
    const t2 = new Client({ connectionString: process.env.DATABASE_URL });
    await t2.connect();
    try {
      await t2.query("BEGIN");
      await t2.query(`SELECT id FROM "OrderItem" WHERE id = $1 FOR UPDATE`, [orderItemId]);
      const pid = (await t2.query("SELECT pg_backend_pid() AS pid")).rows[0].pid;
      const results = starts.map((s) =>
        s().then(
          (v) => ({ ok: true as const, v }),
          (e) => ({ ok: false as const, e }),
        ),
      );
      let waiting = 0;
      for (let i = 0; i < 400 && waiting < starts.length; i++) {
        const q = await t2.query(
          `SELECT pg_stat_clear_snapshot(), (SELECT count(*)::int FROM pg_stat_activity
             WHERE $1 = ANY(pg_blocking_pids(pid))) AS n`,
          [pid],
        );
        waiting = q.rows[0].n;
        if (waiting < starts.length) await new Promise((x) => setTimeout(x, 25));
      }
      await during(t2);
      await t2.query("COMMIT");
      return { waiting, results: await Promise.all(results) };
    } finally {
      await t2.end().catch(() => undefined);
    }
  }

  /**
   * SA-706 Order-first serialization: like `holdLine`, but the two creations do NOT both reach the bump. The
   * first takes the Order row, creates its invoice and blocks on T2 (the OrderItem bump); the second is
   * blocked BY THE FIRST on the Order row. Waits for exactly that chain (bounded 3 s, inside the 5 s tx
   * timeout, never a silent poll timeout) and reports it: `chain` = pairs (A blocked by T2, B blocked by A),
   * `waiting` = backends blocked by T2 (1 when the lock-first order holds; 2 and chain 0 without it).
   */
  async function holdLineChain(orderItemId: string, starts: Array<() => Promise<unknown>>) {
    const t2 = new Client({ connectionString: process.env.DATABASE_URL });
    await t2.connect();
    try {
      await t2.query("BEGIN");
      await t2.query(`SELECT id FROM "OrderItem" WHERE id = $1 FOR UPDATE`, [orderItemId]);
      const pid = (await t2.query("SELECT pg_backend_pid() AS pid")).rows[0].pid;
      const results = starts.map((s) =>
        s().then(
          (v) => ({ ok: true as const, v }),
          (e) => ({ ok: false as const, e }),
        ),
      );
      let chain = 0;
      for (let i = 0; i < 120 && chain < 1; i++) {
        const q = await t2.query(
          `SELECT pg_stat_clear_snapshot(), (SELECT count(*)::int FROM pg_stat_activity b
             JOIN pg_stat_activity a ON a.pid = ANY(pg_blocking_pids(b.pid))
             WHERE $1 = ANY(pg_blocking_pids(a.pid))) AS n`,
          [pid],
        );
        chain = q.rows[0].n;
        if (chain < 1) await new Promise((x) => setTimeout(x, 25));
      }
      const waiting = (
        await t2.query(
          `SELECT count(*)::int AS n FROM pg_stat_activity WHERE $1 = ANY(pg_blocking_pids(pid))`,
          [pid],
        )
      ).rows[0].n;
      await t2.query("COMMIT");
      return { waiting, chain, results: await Promise.all(results) };
    } finally {
      await t2.end().catch(() => undefined);
    }
  }

  const partial = (s: { tenantId: string; orderId: string; orderItemId: string }) => () =>
    tenantCtx.run(s.tenantId, () =>
      invoicesService.createPartialFromOrder(s.orderId, {
        items: [{ orderItemId: s.orderItemId, qty: 96 }],
      } as any),
    );

  it("SA-706 Order-first serialization: the second partial is blocked BY THE FIRST on the Order row, not by T2", async () => {
    const s = await seedLine();
    const { waiting, chain, results } = await holdLineChain(s.orderItemId, [
      partial(s),
      partial(s),
    ]);
    // A blocked by T2 and B blocked by A: one pair. Without the Order lock: waiting 2, chain 0.
    expect(chain).toBe(1);
    expect(waiting).toBe(1); // only A reached the bump
    // Neither creation was a deadlock victim (a bare 40P01, never an HttpException).
    for (const r of results) {
      if (!r.ok) expect(String((r.e as Error)?.message)).not.toMatch(/40P01|deadlock detected/i);
    }
  });

  it("two partials for the last 96 pieces: exactly one 201 + one 409; invoicedQty 96; one invoice", async () => {
    const s = await seedLine();
    const { chain, results } = await holdLineChain(s.orderItemId, [partial(s), partial(s)]);
    expect(chain).toBe(1); // the scenario really ran (A on T2, B behind A)

    const ok = results.filter((r) => r.ok);
    const refused = results.filter((r) => !r.ok) as Array<{ ok: false; e: any }>;
    expect(ok).toHaveLength(1);
    expect(refused).toHaveLength(1);
    expect(refused[0].e).toBeInstanceOf(ConflictException);

    const line = await prisma.orderItem.findUniqueOrThrow({ where: { id: s.orderItemId } });
    expect(Number(line.invoicedQty)).toBe(96); // CAS replaced by an increment: 192
    expect(await prisma.invoice.count({ where: { orderId: s.orderId } })).toBe(1); // ... 2
  });

  it("the invoicedQty CAS itself (SA-523): two bumps off the SAME stale read - the second is refused 409, invoicedQty stays 96", async () => {
    const s = await seedLine();
    const stale = await prisma.orderItem.findUniqueOrThrow({ where: { id: s.orderItemId } });
    const bump = () =>
      tenantCtx.run(s.tenantId, () =>
        prisma.tenantTransaction((tx: any) =>
          bumpInvoicedQtyCas(
            tx,
            [{ orderItemId: s.orderItemId, qty: 96 }],
            new Map([[s.orderItemId, stale]]),
          ),
        ),
      );
    await bump();
    await expect(bump()).rejects.toBeInstanceOf(ConflictException);
    const line = await prisma.orderItem.findUniqueOrThrow({ where: { id: s.orderItemId } });
    expect(Number(line.invoicedQty)).toBe(96); // an unconditional increment: 192, no refusal
  });

  it("the line is CANCELLED while the partial waits: 409, nothing billed, no invoice", async () => {
    const s = await seedLine();
    const { waiting, results } = await holdLine(s.orderItemId, [partial(s)], async (t2) => {
      await t2.query(`UPDATE "OrderItem" SET status = 'CANCELLED' WHERE id = $1`, [s.orderItemId]);
    });
    expect(waiting).toBe(1);
    expect(results[0].ok).toBe(false);
    expect((results[0] as { e: unknown }).e).toBeInstanceOf(ConflictException);
    const line = await prisma.orderItem.findUniqueOrThrow({ where: { id: s.orderItemId } });
    expect(Number(line.invoicedQty)).toBe(0); // pre-fix: 96 on a cancelled line
    expect(await prisma.invoice.count({ where: { orderId: s.orderId } })).toBe(0);
  });

  // #2645 (4): a multi-SIBLING partial. Lines are bumped in orderItemId order, so the first sibling
  // is bumped before the partial blocks on the second; T2 then moves the second's invoicedQty, its
  // CAS misses, and the whole partial rolls back — the FIRST sibling's bump included, no invoice.
  it("#2645: the second sibling's CAS misses ⇒ 409 ORDER_LINE_CHANGED, the first sibling's bump rolled back, no invoice", async () => {
    const s = await seedLine();
    const second = await prisma.orderItem.create({
      data: {
        orderId: s.orderId,
        productId: (await prisma.orderItem.findUniqueOrThrow({ where: { id: s.orderItemId } }))
          .productId,
        qty: 96,
        unitPrice: 10,
        subtotal: 960,
        status: "CONFIRMED",
        tenantId: s.tenantId,
      } as any,
    });
    const [first, later] = [s.orderItemId, second.id].sort();
    const both = () =>
      tenantCtx.run(s.tenantId, () =>
        invoicesService.createPartialFromOrder(s.orderId, {
          // Caller order deliberately reversed: the helper sorts.
          items: [
            { orderItemId: later, qty: 10 },
            { orderItemId: first, qty: 10 },
          ],
        } as any),
      );
    const { waiting, results } = await holdLine(later, [both], async (t2) => {
      await t2.query(`UPDATE "OrderItem" SET "invoicedQty" = 1 WHERE id = $1`, [later]);
    });
    expect(waiting).toBe(1);
    expect(results[0].ok).toBe(false);
    const e = (results[0] as { e: any }).e;
    expect(e).toBeInstanceOf(ConflictException);
    expect(e.getResponse()).toMatchObject({ code: "ORDER_LINE_CHANGED" });

    const firstRow = await prisma.orderItem.findUniqueOrThrow({ where: { id: first } });
    const laterRow = await prisma.orderItem.findUniqueOrThrow({ where: { id: later } });
    expect(Number(firstRow.invoicedQty)).toBe(0); // its bump rolled back with the partial
    expect(Number(laterRow.invoicedQty)).toBe(1); // T2's write only
    expect(await prisma.invoice.count({ where: { orderId: s.orderId } })).toBe(0);
  });

  // #2645 / SA-523d: the CAS pins the whole billing basis, so a price or category-tax edit that lands
  // while the partial waits is the same retriable 409 (nothing billed) — never an invoice priced from
  // the stale read. An identical re-save (same values) does not trip it.
  const partialOf =
    (s: { tenantId: string; orderId: string; orderItemId: string }, qty: number) => () =>
      tenantCtx.run(s.tenantId, () =>
        invoicesService.createPartialFromOrder(s.orderId, {
          items: [{ orderItemId: s.orderItemId, qty }],
        } as any),
      );

  it.each([
    ["a unitPrice edit", `"unitPrice" = 11`],
    ["a category-tax edit", `"categoryTaxAmount" = 1.23`],
  ])(
    "#2645: %s under the held row ⇒ 409 ORDER_LINE_CHANGED, nothing billed, no invoice",
    async (_n, set) => {
      const s = await seedLine();
      const { waiting, results } = await holdLine(s.orderItemId, [partialOf(s, 10)], async (t2) => {
        await t2.query(`UPDATE "OrderItem" SET ${set} WHERE id = $1`, [s.orderItemId]);
      });
      expect(waiting).toBe(1);
      expect(results[0].ok).toBe(false);
      const e = (results[0] as { e: any }).e;
      expect(e).toBeInstanceOf(ConflictException);
      expect(e.getResponse()).toMatchObject({ code: "ORDER_LINE_CHANGED" });
      const line = await prisma.orderItem.findUniqueOrThrow({ where: { id: s.orderItemId } });
      expect(Number(line.invoicedQty)).toBe(0); // pre-fix: 10, billed at the stale price
      expect(await prisma.invoice.count({ where: { orderId: s.orderId } })).toBe(0);
    },
  );

  it("#2645: an IDENTICAL re-save under the held row does not trip the CAS — the partial bills", async () => {
    const s = await seedLine();
    const { waiting, results } = await holdLine(s.orderItemId, [partialOf(s, 10)], async (t2) => {
      await t2.query(
        `UPDATE "OrderItem" SET "unitPrice" = "unitPrice", subtotal = subtotal,
           "categoryTaxAmount" = "categoryTaxAmount", notes = notes WHERE id = $1`,
        [s.orderItemId],
      );
    });
    expect(waiting).toBe(1);
    if (!results[0].ok) throw (results[0] as { e: unknown }).e;
    const line = await prisma.orderItem.findUniqueOrThrow({ where: { id: s.orderItemId } });
    expect(Number(line.invoicedQty)).toBe(10);
    expect(await prisma.invoice.count({ where: { orderId: s.orderId } })).toBe(1);
  });
});
