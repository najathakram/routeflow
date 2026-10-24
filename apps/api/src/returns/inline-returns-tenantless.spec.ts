/**
 * Row 59 (B1211 hunt follow-up, SA-758 CR-1): the inline refund and store-credit-instead endpoints refuse a TENANTLESS
 * session. A SUPER_ADMIN without a tenant context passes `canRefundRole`, `assertGranted` returns early for it, and the
 * raw row locks would then run without a tenant predicate: it could resolve any tenant's return by id. A money write
 * needs a tenant: 403 REFUND_NOT_ALLOWED before any read.
 */
import { Test } from "@nestjs/testing";
import { ForbiddenException } from "@nestjs/common";
import { InlineReturnsService } from "./inline-returns.service";
import { InlineReturnsQuoteService } from "./inline-returns-quote.service";
import { PrismaService } from "../prisma/prisma.service";
import { RouteFlowGateway } from "../gateways/routeflow.gateway";
import { RegulatedLedgerService } from "../regulated/regulated-ledger.service";
import { CreditNotesService } from "../credit-notes/credit-notes.service";
import { NumberingService } from "../import/numbering.service";
import { AddonService } from "../billing/addon.service";
import { IdempotencyService } from "../common/idempotency.service";
import { createMockPrisma } from "../testing/prisma-mock";
import type { JwtPayload } from "../auth/jwt-payload.interface";

const SUPER_ADMIN = {
  sub: "sa-1",
  role: "SUPER_ADMIN",
  forcePasswordChange: false,
  tenantId: null,
  tenantSlug: null,
  username: "root",
  status: "ACTIVE",
} as unknown as JwtPayload;

describe("InlineReturnsService: refund endpoints refuse a tenantless session (row 59)", () => {
  let service: InlineReturnsService;
  let prisma: ReturnType<typeof createMockPrisma>;
  let addon: { hasAddon: jest.Mock };

  beforeEach(async () => {
    prisma = createMockPrisma();
    prisma.getTenantId.mockReturnValue(null);
    addon = { hasAddon: jest.fn().mockResolvedValue(true) };
    const mod = await Test.createTestingModule({
      providers: [
        InlineReturnsService,
        { provide: PrismaService, useValue: prisma },
        { provide: RouteFlowGateway, useValue: { emitCreditNoteCreated: jest.fn() } },
        { provide: RegulatedLedgerService, useValue: {} },
        { provide: CreditNotesService, useValue: {} },
        { provide: NumberingService, useValue: {} },
        { provide: AddonService, useValue: addon },
        { provide: InlineReturnsQuoteService, useValue: {} },
        { provide: IdempotencyService, useValue: {} },
      ],
    }).compile();
    service = mod.get(InlineReturnsService);
  });

  const code = async (p: Promise<unknown>) =>
    p.then(
      () => null,
      (e: any) =>
        e instanceof ForbiddenException
          ? (e.getResponse() as { code?: string }).code
          : (e?.message ?? "other"),
    );

  it("refund() is a 403 REFUND_NOT_ALLOWED before any read or lock", async () => {
    const out = await code(
      service.refund("ret-1", { tender: "CASH", expectedAmount: 10 } as any, SUPER_ADMIN),
    );
    expect(out).toBe("REFUND_NOT_ALLOWED");
    expect(prisma.return.findFirst).not.toHaveBeenCalled();
    expect(prisma.tenantTransaction).not.toHaveBeenCalled();
  });

  it("storeCreditInstead() is a 403 REFUND_NOT_ALLOWED before any read or lock", async () => {
    const out = await code(service.storeCreditInstead("ret-1", SUPER_ADMIN));
    expect(out).toBe("REFUND_NOT_ALLOWED");
    expect(prisma.return.findFirst).not.toHaveBeenCalled();
    expect(prisma.tenantTransaction).not.toHaveBeenCalled();
  });
});
