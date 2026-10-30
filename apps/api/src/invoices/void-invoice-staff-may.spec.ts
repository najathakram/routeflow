/**
 * W-870: the office `POST invoices/:id/void` on a TILL invoice (a counter sale or a PICKUP order) asks the same VOID_SALE
 * predicate as the counter-sale void, over the OPERATOR's denied groups read live. A denied operator cannot void the whole
 * sale from the office instead of the till; an ordinary invoice and a TENANT_ADMIN are unchanged.
 */
jest.mock("./invoice-pdf.service", () => ({
  InvoicePdfService: jest.fn().mockImplementation(() => ({
    getOrGenerate: jest.fn().mockResolvedValue("https://example.com/invoice.pdf"),
  })),
}));
jest.mock("../storage/compress.util", () => ({ compressDocument: jest.fn() }));

import { Test, TestingModule } from "@nestjs/testing";
import { InvoicesService } from "./invoices.service";
import { InvoicePdfService } from "./invoice-pdf.service";
import { PrismaService } from "../prisma/prisma.service";
import { NumberingService } from "../import/numbering.service";
import { RouteFlowGateway } from "../gateways/routeflow.gateway";
import { EmailService } from "../email/email.service";
import { SystemConfigService } from "../system-config/system-config.service";
import { StorageService } from "../storage/storage.service";
import { createMockPrisma } from "../testing/prisma-mock";
import { RegulatedLedgerService } from "../regulated/regulated-ledger.service";
import { AuthorizationGuardService } from "../authorizations/authorization-guard.service";
import { CreditNotesService } from "../credit-notes/credit-notes.service";
import { MessagingService } from "../messaging/messaging.service";
import { EntitlementsService } from "../billing/entitlements.service";
import { CommissionEngineService } from "../sales-agents/commission-engine.service";
import { SellingRestrictionsService } from "../selling-restrictions/selling-restrictions.service";
import { entitlementAuthorityFromEntitlements } from "../testing/entitlement-authority-provider";

const operator = { sub: "op-1", role: "OPERATOR", tenantId: "t-1" } as never;
const admin = { sub: "ad-1", role: "TENANT_ADMIN", tenantId: "t-1" } as never;

describe("InvoicesService.voidInvoice: a till invoice needs VOID_SALE (W-870)", () => {
  let service: InvoicesService;
  let prisma: ReturnType<typeof createMockPrisma>;

  beforeEach(async () => {
    prisma = createMockPrisma();
    const mod: TestingModule = await Test.createTestingModule({
      providers: [
        InvoicesService,
        { provide: SellingRestrictionsService, useValue: { assertLinesSellable: jest.fn() } },
        { provide: PrismaService, useValue: prisma },
        { provide: RouteFlowGateway, useValue: { emitInvoiceUpdated: jest.fn() } },
        { provide: EmailService, useValue: {} },
        { provide: InvoicePdfService, useValue: { getOrGenerate: jest.fn() } },
        { provide: SystemConfigService, useValue: { get: jest.fn().mockResolvedValue(null) } },
        { provide: RegulatedLedgerService, useValue: {} },
        { provide: AuthorizationGuardService, useValue: {} },
        { provide: CreditNotesService, useValue: {} },
        { provide: MessagingService, useValue: { notify: jest.fn(), notifyEvent: jest.fn() } },
        { provide: StorageService, useValue: { delete: jest.fn() } },
        { provide: EntitlementsService, useValue: { hasFlag: jest.fn().mockResolvedValue(false) } },
        entitlementAuthorityFromEntitlements,
        { provide: CommissionEngineService, useValue: { syncInvoiceCommissionSafe: jest.fn() } },
        { provide: NumberingService, useValue: { reserveNext: jest.fn() } },
      ],
    }).compile();
    service = mod.get(InvoicesService);
    prisma.counterDayClose.findFirst.mockResolvedValue(null);
    // the read stops the call at 404: a 403 before it is the door, a 404 is "got past the door"
    prisma.invoice.findUnique.mockResolvedValue(null);
  });

  const tillInvoice = () =>
    prisma.order.findFirst.mockResolvedValue({ id: "ord-1", counterSale: true, registerKey: null });
  const deny = (groups: string[]) =>
    prisma.user.findFirst.mockResolvedValue({
      deniedPermissionGroups: groups,
      permissionsVersion: 2,
    });
  const statusOf = (user: never) =>
    (service.voidInvoice as (...a: unknown[]) => Promise<unknown>)("inv-1", user).then(
      () => 200,
      (e: any) => e.getStatus?.() ?? e,
    );

  it("an operator denied ORDERS is refused 403 on a till invoice (was: past the door)", async () => {
    tillInvoice();
    deny(["ORDERS"]);
    expect(await statusOf(operator)).toBe(403);
  });

  it("an operator holding ORDERS, and a TENANT_ADMIN, get past the door on a till invoice", async () => {
    tillInvoice();
    deny(["PRICING"]);
    expect(await statusOf(operator)).toBe(404);
    expect(await statusOf(admin)).toBe(404);
  });

  it("a till invoice voided with NO principal fails closed 403 (was: past the door, 404)", async () => {
    tillInvoice();
    expect(await statusOf(undefined as never)).toBe(403);
  });

  it("an ordinary (non-till) invoice is unchanged: the denied operator gets past the door", async () => {
    prisma.order.findFirst.mockResolvedValue({
      id: "ord-2",
      counterSale: false,
      fulfillPath: "ROUTE",
    });
    deny(["ORDERS"]);
    expect(await statusOf(operator)).toBe(404);
  });
});
