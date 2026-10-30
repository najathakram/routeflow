/**
 * W-870: the office `PATCH invoices/:id/payments/:paymentId/void` on a TILL invoice (`counterPay.scope` non-null: a counter
 * sale or a PICKUP order) asks the same VOID_SALE predicate as the counter-sale void, over the OPERATOR's denied groups read
 * live. An operator denied ORDERS cannot unwind a till payment from the office instead of the till; an ordinary invoice and
 * a TENANT_ADMIN are unchanged.
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

describe("InvoicesService.voidPayment: a till payment needs VOID_SALE (W-870)", () => {
  let service: InvoicesService;
  let prisma: ReturnType<typeof createMockPrisma>;
  let voidInTx: jest.SpyInstance;

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
    prisma.tenantTransaction.mockImplementation((fn: any) => fn(prisma));
    prisma.counterDayClose.findFirst.mockResolvedValue(null); // no closed window: the day is open
    prisma.invoicePayment.findFirst.mockResolvedValue({
      id: "pay-1",
      amount: 30,
      status: "PAID",
      method: "CASH",
      paidAt: new Date(),
    });
    voidInTx = jest.spyOn(service as any, "voidPaymentInTx").mockResolvedValue({ id: "inv-1" });
  });

  const tillInvoice = () =>
    prisma.order.findFirst.mockResolvedValue({ id: "ord-1", counterSale: true, registerKey: null });
  const deny = (groups: string[]) =>
    prisma.user.findFirst.mockResolvedValue({
      deniedPermissionGroups: groups,
      permissionsVersion: 2,
    });
  const statusOf = (user: never) =>
    (service.voidPayment as (...a: unknown[]) => Promise<unknown>)("inv-1", "pay-1", user).then(
      () => 200,
      (e: any) => e.getStatus?.() ?? e,
    );

  it("an operator denied ORDERS is refused 403 on a till payment and nothing is voided (was: 200, voided)", async () => {
    tillInvoice();
    deny(["ORDERS"]);
    expect(await statusOf(operator)).toBe(403);
    expect(voidInTx).not.toHaveBeenCalled();
  });

  it("an operator holding ORDERS, and a TENANT_ADMIN, void a till payment", async () => {
    tillInvoice();
    deny(["PRICING"]);
    expect(await statusOf(operator)).toBe(200);
    expect(await statusOf(admin)).toBe(200);
    expect(voidInTx).toHaveBeenCalledTimes(2);
  });

  it("an ordinary (non-till) invoice is unchanged: the denied operator still voids it", async () => {
    prisma.order.findFirst.mockResolvedValue({
      id: "ord-2",
      counterSale: false,
      fulfillPath: "ROUTE",
    });
    deny(["ORDERS"]);
    expect(await statusOf(operator)).toBe(200);
  });
});
