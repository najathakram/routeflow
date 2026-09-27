/**
 * #2201 / SA-392 / SA-393 / SA-394 — real-Postgres pins for the commission sync inside a CALLER
 * transaction. Runs only under `npm run local:test:db` (jest.db.config.js), serially. Every tenant
 * is a throwaway `qa-2201-<run>-<n>` slug approved by `assertTestTenant`, deleted in afterAll.
 *
 * Real providers: PrismaService, CreditNotesService, CommissionEngineService, RegulatedLedgerService
 * and AuditService are the production classes against Postgres. Only three are stubbed, none of them
 * under test: the `flag.sales_agents` entitlement (always on here; resolving it needs the global
 * plan catalog), the socket gateway, and numbering (never reached by applyToInvoice).
 *
 * Failures are injected by Postgres itself, not by a JS stub: a per-run BEFORE INSERT trigger on
 * "CommissionAccrual" (scoped to one tenant through a control table) raises a genuine SQLSTATE,
 * either 40001 on the first insert only (a sequence survives the rollback, so attempt 2 passes) or
 * 23505 on every insert. The driver adapter therefore surfaces each error in its own real shape.
 *
 * Before the fix, the engine's "caller tx?" test looked for a missing `$transaction`. Prisma 7's tx
 * client HAS one, so the sync ran in its OWN transaction: it never saw the caller's uncommitted
 * credit (base 100, not 60), and a conflict was never rethrown (no retry).
 */

import { randomUUID } from "crypto";
import { Test } from "@nestjs/testing";
import { PrismaService, isTxClient } from "../prisma/prisma.service";
import { TenantContextService } from "../tenant/tenant-context.service";
import { CommissionEngineService } from "./commission-engine.service";
import { CreditNotesService } from "../credit-notes/credit-notes.service";
import { RegulatedLedgerService } from "../regulated/regulated-ledger.service";
import { AuditService } from "../audit/audit.service";
import { EntitlementsService } from "../billing/entitlements.service";
import { RouteFlowGateway } from "../gateways/routeflow.gateway";
import { NumberingService } from "../import/numbering.service";
import { retryOnTxConflict } from "../common/tx-retry";
import { describeDb, requireLocalDatabaseUrl } from "../common/testing/db-spec";

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { assertTestTenant } = require("../../../../scripts/lib/test-tenants.cjs");

const RUN = randomUUID().slice(0, 8);
const CTL = `t2201_ctl_${RUN}`;
const SEQ = `t2201_seq_${RUN}`;
const FN = `t2201_fn_${RUN}`;
const TRG = `t2201_trg_${RUN}`;

describeDb("commission sync inside a caller tx — real Postgres (#2201, SA-392/393/394)", () => {
  let prisma: PrismaService;
  let tenantCtx: TenantContextService;
  let engine: CommissionEngineService;
  let creditNotes: CreditNotesService;
  const tenantIds: string[] = [];
  let seq = 0;

  beforeAll(async () => {
    requireLocalDatabaseUrl();
    tenantCtx = new TenantContextService();
    prisma = new PrismaService(tenantCtx);
    await prisma.$connect();

    const mod = await Test.createTestingModule({
      providers: [
        CreditNotesService,
        CommissionEngineService,
        RegulatedLedgerService,
        AuditService,
        { provide: PrismaService, useValue: prisma },
        { provide: EntitlementsService, useValue: { hasFlag: jest.fn().mockResolvedValue(true) } },
        {
          provide: RouteFlowGateway,
          useValue: { emitCreditNoteCreated: jest.fn(), emitCreditNoteVoided: jest.fn() },
        },
        { provide: NumberingService, useValue: { reserveNext: jest.fn() } },
      ],
    }).compile();
    engine = mod.get(CommissionEngineService);
    creditNotes = mod.get(CreditNotesService);

    await prisma.$executeRawUnsafe(
      `CREATE TABLE "${CTL}" (tenant_id text PRIMARY KEY, mode text NOT NULL, fire_at bigint)`,
    );
    await prisma.$executeRawUnsafe(`CREATE SEQUENCE "${SEQ}"`);
    await prisma.$executeRawUnsafe(`
      CREATE FUNCTION "${FN}"() RETURNS trigger AS $$
      DECLARE m text; f bigint;
      BEGIN
        SELECT mode, fire_at INTO m, f FROM "${CTL}" WHERE tenant_id = NEW."tenantId";
        -- Nested so only a conflict_once tenant's inserts ever consume the sequence.
        IF m = 'conflict_once' THEN
          IF nextval('"${SEQ}"') = f THEN
            RAISE EXCEPTION '#2201 forced serialization failure' USING ERRCODE = '40001';
          END IF;
        ELSIF m = 'unique' THEN
          RAISE EXCEPTION '#2201 forced unique violation' USING ERRCODE = '23505';
        END IF;
        RETURN NEW;
      END $$ LANGUAGE plpgsql`);
    await prisma.$executeRawUnsafe(
      `CREATE TRIGGER "${TRG}" BEFORE INSERT ON "CommissionAccrual" FOR EACH ROW EXECUTE FUNCTION "${FN}"()`,
    );
  });

  afterAll(async () => {
    // Best-effort throughout: a failed cleanup must never mask a test's own result.
    const swallow = () => undefined;
    await prisma
      .$executeRawUnsafe(`DROP TRIGGER IF EXISTS "${TRG}" ON "CommissionAccrual"`)
      .catch(swallow);
    await prisma.$executeRawUnsafe(`DROP FUNCTION IF EXISTS "${FN}"()`).catch(swallow);
    await prisma.$executeRawUnsafe(`DROP SEQUENCE IF EXISTS "${SEQ}"`).catch(swallow);
    await prisma.$executeRawUnsafe(`DROP TABLE IF EXISTS "${CTL}"`).catch(swallow);
    for (const tenantId of tenantIds) {
      const where = { where: { tenantId } };
      await prisma.commissionAccrual.deleteMany(where).catch(swallow);
      await prisma.invoicePayment.deleteMany(where).catch(swallow);
      await prisma.creditNote.deleteMany(where).catch(swallow);
      await prisma.invoice.deleteMany(where).catch(swallow);
      await prisma.agentAssignment.deleteMany(where).catch(swallow);
      await prisma.salesAgentRate.deleteMany(where).catch(swallow);
      await prisma.salesAgent.deleteMany(where).catch(swallow);
      await prisma.customer.deleteMany(where).catch(swallow);
      await prisma.user.deleteMany(where).catch(swallow);
      await prisma.auditLog.deleteMany(where).catch(swallow);
      await prisma.tenant.delete({ where: { id: tenantId } }).catch(swallow);
    }
    await prisma?.$disconnect();
  });

  /** A tenant with an agent (10%) covering one customer, a SENT invoice of 100, and a credit of 40. */
  async function seed(label: string) {
    seq += 1;
    const slug = assertTestTenant(
      `qa-2201-${RUN}-${seq}-${label}`,
      "commission-sync-conflict.db.spec.ts",
    );
    const tenant = await prisma.tenant.create({ data: { slug, name: `#2201 ${slug}` } });
    tenantIds.push(tenant.id);
    const tenantId = tenant.id;
    const user = await prisma.user.create({
      data: { email: `${slug}@example.invalid`, username: slug, role: "CUSTOMER", tenantId },
    });
    const customer = await prisma.customer.create({
      data: { userId: user.id, businessName: `c ${label}`, contactName: `c ${label}`, tenantId },
    });
    const since = new Date("2020-01-01T00:00:00.000Z");
    const agent = await prisma.salesAgent.create({ data: { name: `agent ${label}`, tenantId } });
    await prisma.salesAgentRate.create({
      data: { agentId: agent.id, ratePct: 10, effectiveFrom: since, tenantId },
    });
    await prisma.agentAssignment.create({
      data: { customerId: customer.id, agentId: agent.id, effectiveFrom: since, tenantId },
    });
    const invoice = await prisma.invoice.create({
      data: {
        tenantId,
        customerId: customer.id,
        invoiceNumber: `INV-2201-${RUN}-${seq}`,
        status: "SENT",
        subtotal: 100,
        taxAmount: 0,
        total: 100,
      },
    });
    const cn = await prisma.creditNote.create({
      data: {
        tenantId,
        customerId: customer.id,
        creditNoteNumber: `CN-2201-${RUN}-${seq}`,
        amount: 40,
        status: "ISSUED",
      },
    });
    return { tenantId, invoice, cn };
  }

  /**
   * Arms the trigger for one tenant. For conflict_once, `fire_at` is the sequence's NEXT value, so
   * exactly this tenant's next CommissionAccrual insert raises 40001 and the one after passes
   * (the sequence is non-transactional, so the rolled-back attempt still advanced it). Returns fire_at.
   */
  const setMode = async (tenantId: string, mode: "conflict_once" | "unique"): Promise<number> => {
    const [row] = await prisma.$queryRawUnsafe<{ fire_at: bigint | null }[]>(
      `INSERT INTO "${CTL}" (tenant_id, mode, fire_at)
       VALUES ($1, $2, CASE WHEN $2 = 'conflict_once'
                            THEN (SELECT CASE WHEN is_called THEN last_value + 1 ELSE last_value END
                                    FROM "${SEQ}")
                       END)
       RETURNING fire_at`,
      tenantId,
      mode,
    );
    return Number(row?.fire_at ?? 0);
  };
  const seqLastValue = async () => {
    const [{ last_value }] = await prisma.$queryRawUnsafe<{ last_value: bigint }[]>(
      `SELECT last_value FROM "${SEQ}"`,
    );
    return Number(last_value);
  };
  const inTenant = <T>(tenantId: string, fn: () => Promise<T>) => tenantCtx.run(tenantId, fn);
  const counts = async (tenantId: string) => ({
    accruals: await prisma.commissionAccrual.findMany({ where: { tenantId } }),
    creditPayments: await prisma.invoicePayment.findMany({
      where: { tenantId, method: "CREDIT_NOTE" },
    }),
    creditNotes: await prisma.creditNote.findMany({ where: { tenantId } }),
    ledgerRows: await prisma.regulatedSalesLedger.count({ where: { tenantId } }),
  });
  const syncFailureLogs = (spy: jest.SpyInstance) =>
    spy.mock.calls.filter((c) => String(c[0]).startsWith("Commission sync failed for invoice"));

  describe("SA-394 isTxClient on real Prisma 7 clients (no fakes)", () => {
    it("a tenantTransaction tx and a raw $transaction tx are tx clients; prisma and forTenant() are not", async () => {
      const { tenantId } = await seed("detect");
      const viaTenantTx = await inTenant(tenantId, () =>
        prisma.tenantTransaction(async (tx: any) => isTxClient(tx)),
      );
      const viaRawTx = await prisma.$transaction(async (tx: any) => isTxClient(tx));
      expect(viaTenantTx).toBe(true);
      expect(viaRawTx).toBe(true);
      expect(isTxClient(prisma)).toBe(false);
      // forTenant() reads the tenant from context; inside it, it is the `$extends`ed client.
      const extended = await inTenant(tenantId, async () => prisma.forTenant());
      expect(extended).not.toBe(prisma);
      expect(isTxClient(extended)).toBe(false);
      // The trap the old test fell into: the real tx client DOES expose $transaction.
      await prisma.$transaction(async (tx: any) => {
        expect(typeof tx.$transaction).toBe("function");
      });
    });
  });

  it("(d) control: applyToInvoice's sync joins the caller tx, RELEASEs, and books from the UNCOMMITTED credit", async () => {
    const { tenantId, invoice, cn } = await seed("control");

    await inTenant(tenantId, () => creditNotes.applyToInvoice(cn.id, invoice.id));

    const c = await counts(tenantId);
    expect(c.creditPayments.map((p) => Number(p.amount))).toEqual([40]);
    expect(c.accruals).toHaveLength(1);
    // Base = goods 100 − credit principal 40 = 60 — only visible INSIDE the caller's tx, where
    // the credit payment is still uncommitted. A sync on its own connection would read base 100.
    expect(Number(c.accruals[0].baseAmount)).toBe(60);
    expect(Number(c.accruals[0].accruedAmount)).toBe(6);
  });

  it("(b) + SA-392: a real 40001 in the sync makes retryOnTxConflict re-run applyToInvoice; credit and commission land once", async () => {
    const { tenantId, invoice, cn } = await seed("conflict");
    const fireAt = await setMode(tenantId, "conflict_once");

    await inTenant(tenantId, () => creditNotes.applyToInvoice(cn.id, invoice.id));

    // attempt 1 raised at fireAt, attempt 2 passed at fireAt + 1: the tx re-ran
    expect(await seqLastValue()).toBe(fireAt + 1);
    const c = await counts(tenantId);
    expect(c.creditPayments.map((p) => Number(p.amount))).toEqual([40]); // applied once
    expect(c.accruals).toHaveLength(1); // commission synced once
    expect(Number(c.accruals[0].baseAmount)).toBe(60);
    expect(c.creditNotes).toHaveLength(1); // no orphan credit note
    expect(Number(c.creditNotes[0].amountUsed)).toBe(40);
    expect(c.ledgerRows).toBe(0); // no orphan ledger rows (nothing regulated here)
  });

  it("(a) a real 23505 in the sync rolls back to the savepoint: the caller's later statement runs, COMMIT persists the credit, no commission row, one error log", async () => {
    const { tenantId, invoice, cn } = await seed("unique");
    await setMode(tenantId, "unique");
    const logSpy = jest.spyOn((engine as any).logger, "error");
    logSpy.mockClear();

    // applyToInvoice reads the invoice back AFTER the sync (its later statement) and returns it.
    const result: any = await inTenant(tenantId, () =>
      creditNotes.applyToInvoice(cn.id, invoice.id),
    );

    expect(result?.id).toBe(invoice.id);
    const c = await counts(tenantId);
    expect(c.creditPayments.map((p) => Number(p.amount))).toEqual([40]);
    expect(c.accruals).toHaveLength(0);
    expect(syncFailureLogs(logSpy)).toHaveLength(1);
    logSpy.mockRestore();
  });

  it("(c) no caller tx: the sync opens its own tx, and a failure there is swallowed and logged", async () => {
    const { tenantId, invoice } = await seed("nocaller");
    await setMode(tenantId, "unique");
    const logSpy = jest.spyOn((engine as any).logger, "error");
    logSpy.mockClear();

    await expect(
      inTenant(tenantId, () => engine.syncInvoiceCommissionSafe(invoice.id)),
    ).resolves.toBeUndefined();

    expect((await counts(tenantId)).accruals).toHaveLength(0);
    expect(syncFailureLogs(logSpy)).toHaveLength(1);
    logSpy.mockRestore();
  });

  it("mechanism: a real trigger-raised 40001 in the REAL sync re-runs the caller's Serializable tx under retryOnTxConflict; its write and the accrual persist once", async () => {
    const { tenantId, invoice } = await seed("mechanism");
    const marker = `qa-2201-${RUN}-mech-row`;
    const fireAt = await setMode(tenantId, "conflict_once");
    let attempts = 0;
    await retryOnTxConflict("#2201 pin", () =>
      inTenant(tenantId, () =>
        prisma.tenantTransaction(
          async (tx: any) => {
            attempts += 1;
            await tx.auditLog.create({
              data: { action: "T2201_MECH", entityType: "test", entityId: marker },
            });
            // Last statement: where a swallowed conflict turned COMMIT into a silent ROLLBACK.
            // No spy: the production sync runs, and its CommissionAccrual insert hits the trigger.
            await engine.syncInvoiceCommissionSafe(invoice.id, tx);
          },
          { isolationLevel: "Serializable" },
        ),
      ),
    );
    expect(attempts).toBe(2);
    expect(await seqLastValue()).toBe(fireAt + 1);
    expect(await prisma.auditLog.count({ where: { tenantId, entityId: marker } })).toBe(1);
    expect(await prisma.commissionAccrual.count({ where: { tenantId } })).toBe(1);
  });
});
