/**
 * SA-392 (#2201): applyToInvoice, voidWithReversal and unapplyFromInvoice run their Serializable
 * transaction UNDER the house `retryOnTxConflict` (common/tx-retry.ts). create() keeps its own
 * MAX_CN_TX_ATTEMPTS loop and is deliberately not pinned here.
 *
 * Two pins per site:
 * - source order: inside the method, `retryOnTxConflict(` opens before `this.prisma.tenantTransaction(`;
 * - behaviour: a P2034 on attempt 1 re-runs the transaction, and an HttpException never does.
 */
import { readFileSync } from "fs";
import { join } from "path";
import { Test } from "@nestjs/testing";
import { BadRequestException } from "@nestjs/common";
import { CreditNotesService } from "./credit-notes.service";
import { PrismaService } from "../prisma/prisma.service";
import { RouteFlowGateway } from "../gateways/routeflow.gateway";
import { RegulatedLedgerService } from "../regulated/regulated-ledger.service";
import { CommissionEngineService } from "../sales-agents/commission-engine.service";
import { NumberingService } from "../import/numbering.service";
import { createMockPrisma } from "../testing/prisma-mock";

const SOURCE = readFileSync(join(__dirname, "credit-notes.service.ts"), "utf8");
const ENGINE = readFileSync(
  join(__dirname, "..", "sales-agents", "commission-engine.service.ts"),
  "utf8",
);

/** A method's text, from its `[private ]async name(` signature to the next class-level member. */
function methodSource(name: string, source = SOURCE): string {
  const m = new RegExp(`\\n {2}(?:private )?async ${name}\\(`).exec(source);
  if (!m) throw new Error(`method ${name} not found`);
  const start = m.index + 1;
  const next = source.slice(start + 1).search(/\n {2}(?:async |private |\/\*\*)/);
  return next < 0 ? source.slice(start) : source.slice(start, start + 1 + next);
}

type Site = [string, (s: CreditNotesService) => Promise<unknown>];
const SITES: Site[] = [
  ["applyToInvoice", (s) => s.applyToInvoice("cn-1", "inv-1")],
  ["voidWithReversal", (s) => s.voidWithReversal("cn-1", null)],
  ["unapplyFromInvoice", (s) => s.unapplyFromInvoice("cn-1", "inv-1")],
];

describe("credit-note Serializable txs run under retryOnTxConflict (SA-392, #2201)", () => {
  let service: CreditNotesService;
  let prisma: ReturnType<typeof createMockPrisma>;

  beforeEach(async () => {
    prisma = createMockPrisma();
    const mod = await Test.createTestingModule({
      providers: [
        CreditNotesService,
        { provide: PrismaService, useValue: prisma },
        {
          provide: RouteFlowGateway,
          useValue: { emitCreditNoteCreated: jest.fn(), emitCreditNoteVoided: jest.fn() },
        },
        {
          provide: RegulatedLedgerService,
          useValue: {
            reverseCreditNoteEntries: jest.fn().mockResolvedValue(undefined),
            unreverseCreditNoteEntries: jest.fn().mockResolvedValue(undefined),
          },
        },
        {
          provide: CommissionEngineService,
          useValue: {
            syncInvoiceCommissionSafe: jest.fn().mockResolvedValue(undefined),
            syncOrderInvoices: jest.fn().mockResolvedValue(undefined),
            removeInvoiceCommission: jest.fn().mockResolvedValue(undefined),
          },
        },
        { provide: NumberingService, useValue: { reserveNext: jest.fn() } },
      ],
    }).compile();
    service = mod.get(CreditNotesService);
  });

  it.each(SITES)("%s: retryOnTxConflict( opens before the tenantTransaction(", (name) => {
    const body = methodSource(name);
    const retry = body.indexOf("retryOnTxConflict(");
    const tx = body.indexOf("this.prisma.tenantTransaction(");
    expect(retry).toBeGreaterThan(-1);
    expect(tx).toBeGreaterThan(retry);
    // Exactly one Serializable tx per site, and it is the wrapped one.
    expect(body.split("this.prisma.tenantTransaction(").length - 1).toBe(1);
  });

  // SA-394(d) / SA-214 (advisory → Return → Order → Invoice → other): on the applyToInvoice path the
  // caller's Invoice row lock (the implicit lock of its UPDATE; a payment path takes no Order lock)
  // precedes the engine's B73 lock, which is on "CommissionAccrual" only ("other").
  it("SA-214 order: applyCreditInTx locks the Invoice (UPDATE) before the commission sync", () => {
    const body = methodSource("applyCreditInTx");
    const invoiceLock = body.indexOf("tx.invoice.update(");
    const sync = body.indexOf("syncInvoiceCommissionSafe(");
    expect(invoiceLock).toBeGreaterThan(-1);
    expect(sync).toBeGreaterThan(invoiceLock);
  });

  it("SA-214 order: the engine's B73 lock is on CommissionAccrual only, and it locks no Order/Invoice row", () => {
    const body = methodSource("runSync", ENGINE);
    const locks = body.match(/FOR UPDATE/g) ?? [];
    expect(locks).toHaveLength(1);
    expect(body).toMatch(
      /SELECT id FROM "CommissionAccrual" WHERE "invoiceId" = \$\{invoiceId\} FOR UPDATE/,
    );
    expect(body).not.toMatch(/\b(?:invoice|order)\.(?:update|updateMany|upsert)\(/);
  });

  it.each(SITES)("%s: a P2034 on attempt 1 re-runs the whole tx", async (_name, call) => {
    const p2034 = Object.assign(new Error("write conflict"), { code: "P2034" });
    const done = { value: "ok", creditNote: { id: "cn-1", amount: 0 } }; // creditNote: voidWithReversal reads it for the socket event
    prisma.tenantTransaction
      .mockImplementationOnce(() => Promise.reject(p2034))
      .mockImplementationOnce(() => Promise.resolve(done));

    await expect(call(service)).resolves.toBeDefined();
    expect(prisma.tenantTransaction).toHaveBeenCalledTimes(2);
  });

  it.each(SITES)("%s: an HttpException is never retried", async (_name, call) => {
    const rejection = new BadRequestException("Credit note is not available for application");
    prisma.tenantTransaction.mockImplementation(() => Promise.reject(rejection));

    await expect(call(service)).rejects.toBe(rejection);
    expect(prisma.tenantTransaction).toHaveBeenCalledTimes(1);
  });
});
