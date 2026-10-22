/**
 * DB twin for SA-824 (row 661 step 1): a customer payment submitted twice with the same
 * `Idempotency-Key` records ONE payment set, against real Postgres.
 *
 * WHY THE DB LANE: the guarantee is a transaction/race shape. The claim is the first statement of
 * the writer's own transaction (`INSERT ... ON CONFLICT ("tenantId","key") DO NOTHING RETURNING
 * id`), and only Postgres can show that a concurrent duplicate WAITS on the unique index for the
 * first transaction and then sees its committed row. This drives the REAL InvoicesService through
 * TWO PrismaService instances (two pools, so two connections), with the winner held open inside
 * its money transaction (the SA-818 `inTx` seam) while the duplicate is in flight.
 *
 *  - T1 (MUST b): concurrent same-key submits on two connections give exactly one payment set; the
 *    loser waits for the winner's commit, then returns the winner's result (`replayed: true`).
 *  - T2 (MUST d): a throw after the claim commits no key and no money; a retry with the same key
 *    records exactly once.
 *  - T3 (MUST g): the same key in two tenants records two independent payments.
 *
 * SA-824 race ruling 6 (POST /invoices/payments/by-key/:key/resolve, `PaymentKeyStatusService.resolve` on
 * connection B while connection A holds an UNCOMMITTED claim of the same key):
 *  - R1: B's resolve WAITS; A commits -> "found" with A's payment group; exactly one payment set.
 *  - R2: B's resolve WAITS; A rolls back -> "tombstoned"; 0 payments; the row is TOMBSTONED.
 *  - R3: resolve, then the late original POST -> 409 PAYMENT_KEY_RESOLVED and 0 payments.
 *  - R4: resolve twice -> "tombstoned" both times, one row, one audit row each (sha256, never the raw key).
 *  - R5: A holds a raw claim past the 5 s lock_timeout -> B's resolve is 409 PAYMENT_KEY_IN_FLIGHT, writes
 *        nothing.
 *  - R6: another tenant's key: GET is 404 from tenant B, B's resolve tombstones only B's own namespace and
 *        A's COMPLETED row (all columns, byte for byte) and its GET are untouched.
 *  - R7: window (ii): an UNCOMMITTED tombstone on connection B while connection A's POST claims the key -> A
 *        WAITS, then is refused 409 PAYMENT_KEY_RESOLVED after B commits; 0 payments.
 *  - R8: a resolve on A conflicts with B's UNCOMMITTED tombstone; B rolls back -> A inserts its OWN
 *        tombstone -> "tombstoned".
 *  - R9: tenant X holds key K COMPLETED; tenant Y resolves K -> tombstoned; X's row is deep-equal before and
 *        after; X's same-key, same-body POST replays its own result (no new payment, no 409); Y's tombstone
 *        exists only under Y's tenantId.
 *
 * SAFETY: throwaway `qa-sa824-<run>-<n>-<label>` tenants only (`assertTestTenant`); `afterAll`
 * deletes exactly what this run created.
 */

jest.mock("./invoice-pdf.service", () => ({
  InvoicePdfService: jest.fn().mockImplementation(() => ({
    getOrGenerate: jest.fn().mockResolvedValue("https://example.com/invoice.pdf"),
  })),
}));
jest.mock("../storage/compress.util", () => ({
  compressDocument: jest.fn(),
}));

import { Test } from "@nestjs/testing";
import { ConflictException, NotFoundException } from "@nestjs/common";
import { createHash, randomUUID } from "crypto";
import { PaymentKeyStatusService } from "./payment-key-status.service";
import { AuditService } from "../audit/audit.service";
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
import { EntitlementAuthority } from "../billing/entitlement-authority.service";
import { CommissionEngineService } from "../sales-agents/commission-engine.service";
import { NumberingService } from "../import/numbering.service";
import { SellingRestrictionsService } from "../selling-restrictions/selling-restrictions.service";
import { describeDb, requireLocalDatabaseUrl } from "../common/testing/db-spec";

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { assertTestTenant } = require("../../../../scripts/lib/test-tenants.cjs");

const RUN_SUFFIX = randomUUID().slice(0, 8);
let tenantSeq = 0;
function freshTenantSlug(label: string): string {
  tenantSeq += 1;
  return assertTestTenant(
    `qa-sa824-${RUN_SUFFIX}-${tenantSeq}-${label}`,
    "payment-idempotency.db.spec.ts",
  );
}

/** One InvoicesService on its OWN PrismaService (its own pool = its own connections). */
async function buildInvoices(prisma: PrismaService, tenantCtx: TenantContextService) {
  const module = await Test.createTestingModule({
    providers: [
      InvoicesService,
      NumberingService,
      {
        provide: SellingRestrictionsService,
        useValue: { assertLinesSellable: jest.fn().mockResolvedValue(undefined) },
      },
      { provide: PrismaService, useValue: prisma },
      { provide: TenantContextService, useValue: tenantCtx },
      { provide: RouteFlowGateway, useValue: { emitInvoiceUpdated: jest.fn() } },
      { provide: EmailService, useValue: { sendInvoice: jest.fn(), isEmailConfigured: jest.fn() } },
      { provide: InvoicePdfService, useValue: { getOrGenerate: jest.fn() } },
      {
        provide: SystemConfigService,
        useValue: { get: jest.fn().mockResolvedValue(null), set: jest.fn() },
      },
      {
        provide: RegulatedLedgerService,
        useValue: { writeSaleEntries: jest.fn(), reverseInvoiceEntries: jest.fn() },
      },
      {
        provide: AuthorizationGuardService,
        useValue: {
          assertAuthorizedOrThrow: jest.fn().mockResolvedValue(undefined),
          checkAuthorized: jest.fn().mockResolvedValue({ blocked: [] }),
        },
      },
      {
        provide: CreditNotesService,
        useValue: {
          autoApplyOldestCreditsInTx: jest
            .fn()
            .mockResolvedValue({ applied: 0, invoiceStatus: null }),
          releaseInvoiceCreditsInTx: jest.fn().mockResolvedValue([]),
        },
      },
      {
        provide: MessagingService,
        useValue: { notify: jest.fn().mockResolvedValue([]), notifyEvent: jest.fn() },
      },
      { provide: StorageService, useValue: {} },
      { provide: EntitlementAuthority, useValue: { can: jest.fn().mockResolvedValue(false) } },
      { provide: EntitlementsService, useValue: { hasFlag: jest.fn().mockResolvedValue(false) } },
      {
        provide: CommissionEngineService,
        useValue: { syncInvoiceCommissionSafe: jest.fn().mockResolvedValue(undefined) },
      },
    ],
  }).compile();
  return module.get(InvoicesService);
}

describeDb(
  "SA-824 payment Idempotency-Key claims inside the money transaction — real Postgres",
  () => {
    let tenantCtx: TenantContextService;
    let prismaA: PrismaService;
    let prismaB: PrismaService;
    let invoicesA: InvoicesService;
    let invoicesB: InvoicesService;
    /** The resolve / by-key service on connection B (its own pool), auditing through B. */
    let statusB: PaymentKeyStatusService;
    /** The same service on connection A (R8). */
    let statusA: PaymentKeyStatusService;
    const createdTenantIds: string[] = [];

    beforeAll(async () => {
      requireLocalDatabaseUrl();
      tenantCtx = new TenantContextService();
      prismaA = new PrismaService(tenantCtx);
      prismaB = new PrismaService(tenantCtx);
      await prismaA.$connect();
      await prismaB.$connect();
      invoicesA = await buildInvoices(prismaA, tenantCtx);
      invoicesB = await buildInvoices(prismaB, tenantCtx);
      statusB = new PaymentKeyStatusService(prismaB, new AuditService(prismaB));
      statusA = new PaymentKeyStatusService(prismaA, new AuditService(prismaA));
    });

    afterAll(async () => {
      for (const tenantId of createdTenantIds) {
        // eslint-disable-next-line no-await-in-loop
        await cleanupTenant(tenantId).catch(() => undefined);
      }
      await prismaA?.$disconnect();
      await prismaB?.$disconnect();
    });

    async function cleanupTenant(tenantId: string): Promise<void> {
      await prismaA.auditLog.deleteMany({ where: { tenantId } });
      await prismaA.paymentIdempotencyKey.deleteMany({ where: { tenantId } });
      await prismaA.advancePayment.deleteMany({ where: { tenantId } });
      await prismaA.invoicePayment.deleteMany({ where: { invoice: { tenantId } } });
      await prismaA.invoice.deleteMany({ where: { tenantId } });
      await prismaA.paymentCounter.deleteMany({ where: { id: tenantId } });
      await prismaA.customer.deleteMany({ where: { tenantId } });
      await prismaA.user.deleteMany({ where: { tenantId } });
      await prismaA.tenant.delete({ where: { id: tenantId } });
    }

    async function seed(label: string) {
      const slug = freshTenantSlug(label);
      const tenant = await prismaA.tenant.create({ data: { slug, name: `SA824 ${slug}` } });
      createdTenantIds.push(tenant.id);
      const user = await prismaA.user.create({
        data: {
          email: `${tenant.id}@example.invalid`,
          username: tenant.id,
          role: "CUSTOMER",
          tenantId: tenant.id,
        },
      });
      const customer = await prismaA.customer.create({
        data: {
          userId: user.id,
          businessName: "SA824 customer",
          contactName: "SA824 contact",
          tenantId: tenant.id,
        },
      });
      const invoice = await prismaA.invoice.create({
        data: {
          tenantId: tenant.id,
          customerId: customer.id,
          invoiceNumber: `INV-SEED-${randomUUID().slice(0, 8)}`,
          status: "SENT",
          subtotal: 1000,
          total: 1000,
        },
      });
      const dto = {
        customerId: customer.id,
        totalAmount: 300,
        method: "CASH",
        reference: "receipt 7",
        paidAt: "2026-10-20",
        allocations: [{ invoiceId: invoice.id, amount: 300 }],
      } as any;
      const asTenant = <T>(fn: () => Promise<T>) => tenantCtx.run(tenant.id, fn);
      const state = async () => ({
        payments: await prismaA.invoicePayment.findMany({ where: { invoiceId: invoice.id } }),
        keys: await prismaA.paymentIdempotencyKey.findMany({ where: { tenantId: tenant.id } }),
      });
      return { tenant, dto, asTenant, state };
    }

    it("T1 (b) two connections, same key, concurrent: exactly one payment set; the loser waits for the winner's commit and replays its result", async () => {
      const { dto, asTenant, state } = await seed("t1");
      const key = `race-${randomUUID()}`;
      let winnerInTx!: () => void;
      const winnerHoldsKey = new Promise<void>((r) => (winnerInTx = r));
      let releasedAt = 0;

      // A claims and writes, then holds its transaction open for 800ms inside the money tx.
      const winner = asTenant(() =>
        invoicesA.recordStandalonePayment(dto, {
          idempotencyKey: key,
          inTx: async () => {
            winnerInTx();
            await new Promise((r) => setTimeout(r, 800));
            releasedAt = Date.now();
          },
        }),
      );
      await winnerHoldsKey;
      // B starts while A's claim is uncommitted: its pre-read sees nothing, its claim WAITS on the index.
      let loserDoneAt = 0;
      const loser = asTenant(() =>
        invoicesB.recordStandalonePayment(dto, { idempotencyKey: key }).then((r) => {
          loserDoneAt = Date.now(); // the loser's OWN resolve time, not the Promise.all's
          return r;
        }),
      );

      const [w, l]: any[] = await Promise.all([winner, loser]);

      expect(w.replayed).toBeUndefined();
      expect(l.replayed).toBe(true);
      expect(l.paymentGroupId).toBe(w.paymentGroupId);
      expect(releasedAt).toBeGreaterThan(0);
      expect(loserDoneAt).toBeGreaterThanOrEqual(releasedAt); // it waited for the winner's commit
      const after = await state();
      expect(after.payments).toHaveLength(1);
      expect(after.payments[0].paymentGroupId).toBe(w.paymentGroupId);
      expect(after.keys).toHaveLength(1);
      expect(after.keys[0]).toMatchObject({
        scope: "STANDALONE_PAYMENT",
        paymentGroupId: w.paymentGroupId,
      });
    }, 60_000);

    it("T2 (d) a throw after the claim commits no key and no money; the same-key retry records once", async () => {
      const { dto, asTenant, state } = await seed("t2");
      const key = `fail-${randomUUID()}`;

      await expect(
        asTenant(() =>
          invoicesA.recordStandalonePayment(dto, {
            idempotencyKey: key,
            inTx: async () => {
              throw new Error("injected failure after the claim");
            },
          }),
        ),
      ).rejects.toThrow("injected failure after the claim");
      const afterFailure = await state();
      expect({ payments: afterFailure.payments.length, keys: afterFailure.keys.length }).toEqual({
        payments: 0,
        keys: 0,
      });

      const retry: any = await asTenant(() =>
        invoicesB.recordStandalonePayment(dto, { idempotencyKey: key }),
      );
      expect(retry.replayed).toBeUndefined();
      const afterRetry = await state();
      expect({ payments: afterRetry.payments.length, keys: afterRetry.keys.length }).toEqual({
        payments: 1,
        keys: 1,
      });
    }, 60_000);

    it("T3 (g) the same key in two tenants records two independent payments", async () => {
      const one = await seed("t3a");
      const two = await seed("t3b");
      const key = `shared-${randomUUID()}`;

      const a: any = await one.asTenant(() =>
        invoicesA.recordStandalonePayment(one.dto, { idempotencyKey: key }),
      );
      const b: any = await two.asTenant(() =>
        invoicesB.recordStandalonePayment(two.dto, { idempotencyKey: key }),
      );

      expect(b.replayed).toBeUndefined();
      expect(b.paymentGroupId).not.toBe(a.paymentGroupId);
      expect((await one.state()).payments).toHaveLength(1);
      expect((await two.state()).payments).toHaveLength(1);
    }, 60_000);
    const actor = { sub: null, impersonatedBy: null };
    const keyHash = (k: string) => createHash("sha256").update(k).digest("hex");
    const codeOf = (e: unknown) => (e as ConflictException).getResponse?.() as { code?: string };

    /** A's money transaction held open (uncommitted claim) until `release(outcome)`. */
    function holdOnA(
      seeded: Awaited<ReturnType<typeof seed>>,
      key: string,
    ): {
      held: Promise<void>;
      release: (outcome: "commit" | "rollback") => void;
      done: Promise<unknown>;
    } {
      let inTx!: () => void;
      const held = new Promise<void>((r) => (inTx = r));
      let release!: (o: "commit" | "rollback") => void;
      const gate = new Promise<"commit" | "rollback">((r) => (release = r));
      const done = seeded
        .asTenant(() =>
          invoicesA.recordStandalonePayment(seeded.dto, {
            idempotencyKey: key,
            inTx: async () => {
              inTx();
              if ((await gate) === "rollback") throw new Error("A rolls back");
            },
          }),
        )
        .catch((e: unknown) => e);
      return { held, release, done };
    }

    it("R1 resolve on B WAITS behind A's uncommitted claim; A commits -> found, one payment set", async () => {
      const seeded = await seed("r1");
      const key = `r1-${randomUUID()}`;
      const a = holdOnA(seeded, key);
      await a.held;
      let resolvedAt = 0;
      const resolving = seeded
        .asTenant(() => statusB.resolve(key, actor))
        .then((r) => ((resolvedAt = Date.now()), r));
      await new Promise((r) => setTimeout(r, 700)); // B is now blocked on the unique index
      expect(resolvedAt).toBe(0);
      const releasedAt = Date.now();
      a.release("commit");
      const [w, out]: any[] = await Promise.all([a.done, resolving]);

      expect(out.state).toBe("found");
      expect(out.paymentGroupId).toBe(w.paymentGroupId);
      expect(resolvedAt).toBeGreaterThanOrEqual(releasedAt);
      const after = await seeded.state();
      expect(after.payments).toHaveLength(1);
      expect(after.keys.map((k: any) => k.state)).toEqual(["COMPLETED"]);
      expect(out).toEqual(await seeded.asTenant(() => statusB.byKey(key)));
    }, 60_000);

    it("R2 resolve on B WAITS; A rolls back -> tombstoned, 0 payments, the row is TOMBSTONED", async () => {
      const seeded = await seed("r2");
      const key = `r2-${randomUUID()}`;
      const a = holdOnA(seeded, key);
      await a.held;
      const resolving = seeded.asTenant(() => statusB.resolve(key, actor));
      await new Promise((r) => setTimeout(r, 700));
      a.release("rollback");
      const [aErr, out] = await Promise.all([a.done, resolving]);

      expect((aErr as Error).message).toBe("A rolls back");
      expect(out).toEqual({ state: "tombstoned" });
      const after = await seeded.state();
      expect(after.payments).toHaveLength(0);
      expect(after.keys.map((k: any) => k.state)).toEqual(["TOMBSTONED"]);
    }, 60_000);

    it("R3 resolve, then the late original POST: 409 PAYMENT_KEY_RESOLVED and 0 payments", async () => {
      const seeded = await seed("r3");
      const key = `r3-${randomUUID()}`;
      expect(await seeded.asTenant(() => statusB.resolve(key, actor))).toEqual({
        state: "tombstoned",
      });
      const late = await seeded
        .asTenant(() => invoicesA.recordStandalonePayment(seeded.dto, { idempotencyKey: key }))
        .catch((e: unknown) => e);
      expect(late).toBeInstanceOf(ConflictException);
      expect(codeOf(late).code).toBe("PAYMENT_KEY_RESOLVED");
      expect((await seeded.state()).payments).toHaveLength(0);
    }, 60_000);

    it("R4 resolve twice: tombstoned both times, one row, one audit row each with the sha256 (never the raw key)", async () => {
      const seeded = await seed("r4");
      const key = `r4-${randomUUID()}`;
      for (let i = 0; i < 2; i += 1) {
        // eslint-disable-next-line no-await-in-loop
        expect(await seeded.asTenant(() => statusB.resolve(key, actor))).toEqual({
          state: "tombstoned",
        });
      }
      expect((await seeded.state()).keys).toHaveLength(1);
      const audits = await prismaA.auditLog.findMany({
        where: { tenantId: seeded.tenant.id, action: "payment-key.resolve" },
      });
      expect(audits).toHaveLength(2);
      for (const row of audits) {
        expect(row.entityId).toBe(keyHash(key));
        expect(JSON.stringify(row)).not.toContain(key);
      }
    }, 60_000);

    it("R5 a claim held past the 5 s lock_timeout: B's resolve is 409 PAYMENT_KEY_IN_FLIGHT and writes nothing", async () => {
      const seeded = await seed("r5");
      const key = `r5-${randomUUID()}`;
      let claimed!: () => void;
      const held = new Promise<void>((r) => (claimed = r));
      const holder = prismaA
        .$transaction(
          async (tx) => {
            await tx.$executeRaw`
              INSERT INTO "PaymentIdempotencyKey" ("id", "tenantId", "key", "scope", "requestHash", "state", "result")
              VALUES (${randomUUID()}, ${seeded.tenant.id}, ${key}, 'STANDALONE_PAYMENT'::"PaymentIdempotencyScope", 'h', 'CLAIMED'::"PaymentIdempotencyState", '{}'::jsonb)`;
            claimed();
            await new Promise((r) => setTimeout(r, 7_000));
            throw new Error("holder rolls back");
          },
          { timeout: 20_000 },
        )
        .catch((e: unknown) => e);
      await held;
      const err = await seeded.asTenant(() => statusB.resolve(key, actor)).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(ConflictException);
      expect(codeOf(err).code).toBe("PAYMENT_KEY_IN_FLIGHT");
      await holder;
      expect((await seeded.state()).keys).toHaveLength(0);
      const audits = await prismaA.auditLog.count({
        where: { tenantId: seeded.tenant.id, action: "payment-key.resolve" },
      });
      expect(audits).toBe(0);
    }, 60_000);

    it("R6 another tenant's key: 404 from B, B's resolve tombstones only B's namespace, A's row untouched", async () => {
      const one = await seed("r6a");
      const two = await seed("r6b");
      const key = `r6-${randomUUID()}`;
      const paid: any = await one.asTenant(() =>
        invoicesA.recordStandalonePayment(one.dto, { idempotencyKey: key }),
      );
      const fullRow = (tenantId: string) =>
        prismaA.paymentIdempotencyKey.findFirstOrThrow({ where: { tenantId, key } });
      const aBefore = await fullRow(one.tenant.id); // every column: state, scope, requestHash, result, timestamps
      const get = await two.asTenant(() => statusB.byKey(key)).catch((e: unknown) => e);
      expect(get).toBeInstanceOf(NotFoundException);
      expect(await two.asTenant(() => statusB.resolve(key, actor))).toEqual({
        state: "tombstoned",
      });

      const aRows = (await one.state()).keys;
      expect(aRows.map((k: any) => k.state)).toEqual(["COMPLETED"]);
      expect(await fullRow(one.tenant.id)).toEqual(aBefore); // byte-unchanged after B's resolve
      expect((await two.state()).keys.map((k: any) => k.state)).toEqual(["TOMBSTONED"]);
      const stillFound: any = await one.asTenant(() => statusB.byKey(key));
      expect(stillFound.state).toBe("found");
      expect(stillFound.paymentGroupId).toBe(paid.paymentGroupId);
      expect((await one.state()).payments).toHaveLength(1);
    }, 60_000);

    /** An UNCOMMITTED tombstone for (tenantId, key) on connection B, held until `release(outcome)`. */
    function holdTombstoneOnB(tenantId: string, key: string) {
      const id = randomUUID();
      let claimed!: () => void;
      const held = new Promise<void>((r) => (claimed = r));
      let release!: (o: "commit" | "rollback") => void;
      const gate = new Promise<"commit" | "rollback">((r) => (release = r));
      const done = prismaB
        .$transaction(
          async (tx) => {
            await tx.$executeRaw`
              INSERT INTO "PaymentIdempotencyKey" ("id", "tenantId", "key", "state", "result")
              VALUES (${id}, ${tenantId}, ${key}, 'TOMBSTONED'::"PaymentIdempotencyState", '{}'::jsonb)`;
            claimed();
            if ((await gate) === "rollback") throw new Error("B rolls back");
          },
          { timeout: 20_000 },
        )
        .catch((e: unknown) => e);
      return { id, held, release, done };
    }

    it("R7 window (ii): B holds an UNCOMMITTED tombstone; A's POST waits, then 409 PAYMENT_KEY_RESOLVED; 0 payments", async () => {
      const seeded = await seed("r7");
      const key = `r7-${randomUUID()}`;
      const b = holdTombstoneOnB(seeded.tenant.id, key);
      await b.held;
      let postDoneAt = 0;
      const posting = seeded
        .asTenant(() => invoicesA.recordStandalonePayment(seeded.dto, { idempotencyKey: key }))
        .catch((e: unknown) => e)
        .then((r) => ((postDoneAt = Date.now()), r));
      await new Promise((r) => setTimeout(r, 700)); // A's claim is blocked on the unique index
      expect(postDoneAt).toBe(0);
      const committedAt = Date.now();
      b.release("commit");
      const [, late] = await Promise.all([b.done, posting]);

      expect(late).toBeInstanceOf(ConflictException);
      expect(codeOf(late).code).toBe("PAYMENT_KEY_RESOLVED");
      expect(postDoneAt).toBeGreaterThanOrEqual(committedAt);
      const after = await seeded.state();
      expect(after.payments).toHaveLength(0);
      expect(after.keys.map((k: any) => k.state)).toEqual(["TOMBSTONED"]);
    }, 60_000);

    it("R8 a resolve on A conflicts with B's UNCOMMITTED tombstone; B rolls back -> A inserts its own -> tombstoned", async () => {
      const seeded = await seed("r8");
      const key = `r8-${randomUUID()}`;
      const b = holdTombstoneOnB(seeded.tenant.id, key);
      await b.held;
      let resolvedAt = 0;
      const resolving = seeded
        .asTenant(() => statusA.resolve(key, actor))
        .then((r) => ((resolvedAt = Date.now()), r));
      await new Promise((r) => setTimeout(r, 700));
      expect(resolvedAt).toBe(0); // blocked behind B's uncommitted tombstone
      b.release("rollback");
      const [bErr, out] = await Promise.all([b.done, resolving]);

      expect((bErr as Error).message).toBe("B rolls back");
      expect(out).toEqual({ state: "tombstoned" });
      const rows = (await seeded.state()).keys;
      expect(rows).toHaveLength(1);
      expect(rows[0].state).toBe("TOMBSTONED");
      expect(rows[0].id).not.toBe(b.id); // A's OWN tombstone, not the rolled-back one
    }, 60_000);

    it("R9 cross-tenant: Y's resolve leaves X's COMPLETED row deep-equal, X's same-body POST replays, Y's tombstone is Y's only", async () => {
      const x = await seed("r9x");
      const y = await seed("r9y");
      const key = `r9-${randomUUID()}`;
      const paid: any = await x.asTenant(() =>
        invoicesA.recordStandalonePayment(x.dto, { idempotencyKey: key }),
      );
      const fullRow = (tenantId: string) =>
        prismaA.paymentIdempotencyKey.findFirstOrThrow({ where: { tenantId, key } });
      const xBefore = await fullRow(x.tenant.id);
      const paymentsBefore = (await x.state()).payments.length;

      expect(await y.asTenant(() => statusB.resolve(key, actor))).toEqual({ state: "tombstoned" });
      expect(await fullRow(x.tenant.id)).toEqual(xBefore);

      const replay: any = await x
        .asTenant(() => invoicesB.recordStandalonePayment(x.dto, { idempotencyKey: key }))
        .catch((e: unknown) => e);
      expect(replay).not.toBeInstanceOf(ConflictException);
      expect(replay.replayed).toBe(true);
      expect(replay.paymentGroupId).toBe(paid.paymentGroupId);
      expect((await x.state()).payments).toHaveLength(paymentsBefore);

      const tombstones = await prismaA.paymentIdempotencyKey.findMany({
        where: { key, state: "TOMBSTONED" },
      });
      expect(tombstones.map((t: any) => t.tenantId)).toEqual([y.tenant.id]);
    }, 60_000);
  },
);
