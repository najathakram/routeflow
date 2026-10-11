/**
 * SA-773: the real services the refundable-remainder DB specs drive (CreditNotesService, ReturnsService, an InlineReturnsService
 * built the way inline-returns-refund.db.spec.ts builds it), wired to the real PrismaService with a numbering stub that hands
 * out unique credit note numbers. Outside src: not part of the build, not walked by the source scanners.
 */
import { Test } from "@nestjs/testing";
import { PrismaService } from "../src/prisma/prisma.service";
import { CreditNotesService } from "../src/credit-notes/credit-notes.service";
import { ReturnsService } from "../src/returns/returns.service";
import { RegulatedLedgerService } from "../src/regulated/regulated-ledger.service";
import { CommissionEngineService } from "../src/sales-agents/commission-engine.service";
import { AuditService } from "../src/audit/audit.service";
import { EntitlementsService } from "../src/billing/entitlements.service";
import { RouteFlowGateway } from "../src/gateways/routeflow.gateway";
import { NumberingService } from "../src/import/numbering.service";
import { IdempotencyService } from "../src/common/idempotency.service";
import { EncryptionService } from "../src/common/encryption.service";
import { SystemConfigService } from "../src/system-config/system-config.service";
import { InlineReturnsQuoteService } from "../src/returns/inline-returns-quote.service";
import { InlineReturnsService } from "../src/returns/inline-returns.service";

export async function buildRefundServices(prisma: PrismaService, tag: string) {
  const anyMethod = new Proxy(
    {},
    { get: (_t, prop) => (prop === "then" || typeof prop === "symbol" ? undefined : jest.fn()) },
  );
  let seq = 0;
  const numbering = {
    reserveNext: jest.fn().mockImplementation(async () => `CN-${tag}-${++seq}`),
  };
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
      { provide: NumberingService, useValue: numbering },
    ],
  }).compile();
  const creditNotes = mod.get(CreditNotesService);
  const returns = mod.get(ReturnsService);
  const systemConfig = new SystemConfigService(
    prisma,
    new EncryptionService({ get: () => undefined } as any),
  );
  const inline: any = Object.assign(Object.create(InlineReturnsService.prototype), {
    prisma,
    gateway: anyMethod,
    ledger: mod.get(RegulatedLedgerService),
    creditNotes,
    numbering,
    addonService: { hasAddon: async () => true },
    quoteService: new InlineReturnsQuoteService(prisma, systemConfig),
    idempotency: new IdempotencyService(),
  });
  return { creditNotes, returns, inline };
}
