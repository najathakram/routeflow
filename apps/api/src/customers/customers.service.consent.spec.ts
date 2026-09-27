/**
 * SA-305 (2) — `CustomersService.setCustomerConsent` must write the consent column(s) AND its
 * evidence (an AuditLog row via `tx.auditLog.create`, never `AuditService.log`, which swallows
 * every error) in ONE tenantTransaction:
 *   - a failing evidence insert must leave the consent flag(s) unchanged (the whole tx rolls back)
 *   - a failing consent-column update must leave no evidence row (never reached)
 *
 * Used today by the CSV importer (`ImportService.applyCustomerCommercialFields`, see
 * `import-commercial-columns.spec.ts`'s SA-305 tests); there is no UI consent-capture flow yet —
 * this only proves the method itself.
 */
import { Test, TestingModule } from "@nestjs/testing";
import { ConflictException } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { CustomersService } from "./customers.service";
import { PrismaService } from "../prisma/prisma.service";
import { StorageService } from "../storage/storage.service";
import { MeterService } from "../billing/meter.service";
import { PlanCatalogService } from "../billing/plan-catalog.service";
import { EntitlementsService } from "../billing/entitlements.service";
import { EmailService } from "../email/email.service";
import { CommissionEngineService } from "../sales-agents/commission-engine.service";
import { RegulatedLedgerService } from "../regulated/regulated-ledger.service";
import { createMockPrisma } from "../testing/prisma-mock";
import { entitlementAuthorityFromEntitlements } from "../testing/entitlement-authority-provider";

describe("CustomersService.setCustomerConsent (SA-305 (2))", () => {
  let service: CustomersService;
  let prisma: ReturnType<typeof createMockPrisma>;

  beforeEach(async () => {
    prisma = createMockPrisma();
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        {
          provide: CommissionEngineService,
          useValue: {
            syncInvoiceCommissionSafe: jest.fn(),
            syncOrderInvoices: jest.fn(),
            syncInvoiceCommission: jest.fn(),
          },
        },
        CustomersService,
        { provide: PrismaService, useValue: prisma },
        { provide: ConfigService, useValue: { get: jest.fn().mockReturnValue(null) } },
        {
          provide: StorageService,
          useValue: {
            upload: jest.fn(),
            delete: jest.fn(),
            presignedUrl: jest.fn(),
          },
        },
        { provide: MeterService, useValue: { read: jest.fn() } },
        { provide: PlanCatalogService, useValue: { getPublishedVersion: jest.fn() } },
        { provide: EntitlementsService, useValue: { hasFlag: jest.fn().mockResolvedValue(false) } },
        entitlementAuthorityFromEntitlements, // #2241
        {
          provide: RegulatedLedgerService,
          useValue: { reverseInvoiceEntries: jest.fn() },
        },
        { provide: EmailService, useValue: { send: jest.fn() } },
      ],
    }).compile();

    service = module.get(CustomersService);
    prisma.customer.findFirst.mockResolvedValue({ id: "cust-1", deletedAt: null });
  });

  it("writes the consent column(s) AND one evidence row per changed channel, in the same transaction", async () => {
    await service.setCustomerConsent(
      "cust-1",
      { smsConsent: true },
      { userId: "user-1", source: "import", fileName: "contacts.csv", row: 3 },
    );

    expect(prisma.tenantTransaction).toHaveBeenCalledTimes(1);
    expect(prisma.customer.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "cust-1" },
        data: expect.objectContaining({ smsConsent: true }),
      }),
    );
    expect(prisma.auditLog.create).toHaveBeenCalledTimes(1);
    const dto = prisma.auditLog.create.mock.calls[0]?.[0]?.data;
    expect(dto).toMatchObject({
      userId: "user-1",
      action: "customer.consent.import",
      entityType: "Customer",
      entityId: "cust-1",
      meta: expect.objectContaining({
        source: "import",
        fileName: "contacts.csv",
        row: 3,
        channel: "sms",
        value: true,
      }),
    });
  });

  /**
   * A fake transaction with real commit/rollback semantics: writes made through the `tx` handed
   * to the callback are staged and only land in `committed` when the callback resolves. Writes
   * made on the ambient client (`prisma.customer.update`, `prisma.auditLog.create`) bypass it —
   * so each failure test also proves neither statement escapes the transaction.
   */
  function useStagingTransaction(fail: { update?: boolean; evidence?: boolean }) {
    const committed = { customerUpdates: [] as any[], auditRows: [] as any[] };
    prisma.tenantTransaction.mockImplementation(async (fn: any) => {
      const staged = { customerUpdates: [] as any[], auditRows: [] as any[] };
      const tx = {
        customer: {
          findFirst: jest.fn().mockResolvedValue({ id: "cust-1", deletedAt: null }),
          update: jest.fn(async (args: any) => {
            if (fail.update) throw new Error("db down");
            staged.customerUpdates.push(args);
            return { id: "cust-1" };
          }),
        },
        auditLog: {
          create: jest.fn(async (args: any) => {
            if (fail.evidence) throw new Error("db down");
            staged.auditRows.push(args);
            return { id: "audit-1" };
          }),
        },
      };
      const result = await fn(tx);
      committed.customerUpdates.push(...staged.customerUpdates);
      committed.auditRows.push(...staged.auditRows);
      return result;
    });
    return committed;
  }

  it("commits the consent flag and its evidence together through the transaction client", async () => {
    const committed = useStagingTransaction({});

    await service.setCustomerConsent(
      "cust-1",
      { smsConsent: true },
      { userId: "user-1", source: "import", fileName: "contacts.csv", row: 3 },
    );

    expect(committed.customerUpdates).toHaveLength(1);
    expect(committed.auditRows).toHaveLength(1);
    expect(prisma.customer.update).not.toHaveBeenCalled();
    expect(prisma.auditLog.create).not.toHaveBeenCalled();
  });

  it("a failing evidence insert leaves the consent flag unchanged (both statements share one tx)", async () => {
    const committed = useStagingTransaction({ evidence: true });

    await expect(
      service.setCustomerConsent(
        "cust-1",
        { smsConsent: true },
        { userId: "user-1", source: "import" },
      ),
    ).rejects.toThrow("db down");

    // The flag update ran inside the transaction, so the failed evidence insert rolled it back:
    // nothing committed, and nothing written on the ambient (non-transactional) client either.
    expect(committed.customerUpdates).toEqual([]);
    expect(committed.auditRows).toEqual([]);
    expect(prisma.customer.update).not.toHaveBeenCalled();
    expect(prisma.auditLog.create).not.toHaveBeenCalled();
  });

  it("a failing consent-column update leaves no evidence row", async () => {
    const committed = useStagingTransaction({ update: true });

    await expect(
      service.setCustomerConsent(
        "cust-1",
        { smsConsent: true },
        { userId: "user-1", source: "import" },
      ),
    ).rejects.toThrow("db down");

    expect(committed.auditRows).toEqual([]);
    expect(committed.customerUpdates).toEqual([]);
    expect(prisma.auditLog.create).not.toHaveBeenCalled();
  });

  it("refuses a soft-deleted customer (Restore the customer first) and writes nothing", async () => {
    prisma.customer.findFirst.mockResolvedValueOnce({ id: "cust-1", deletedAt: new Date() });

    await expect(
      service.setCustomerConsent(
        "cust-1",
        { smsConsent: true },
        { userId: "user-1", source: "import" },
      ),
    ).rejects.toThrow(ConflictException);

    expect(prisma.customer.update).not.toHaveBeenCalled();
    expect(prisma.auditLog.create).not.toHaveBeenCalled();
  });

  it("a no-op call (neither channel defined) never opens a transaction", async () => {
    await service.setCustomerConsent("cust-1", {}, { userId: "user-1", source: "import" });

    expect(prisma.tenantTransaction).not.toHaveBeenCalled();
  });

  it("writes an evidence row per channel when both sms and whatsapp consent change", async () => {
    await service.setCustomerConsent(
      "cust-1",
      { smsConsent: true, waConsent: false },
      { userId: "user-1", source: "import" },
    );

    expect(prisma.auditLog.create).toHaveBeenCalledTimes(2);
    const channels = prisma.auditLog.create.mock.calls.map((c: any) => c[0]?.data?.meta?.channel);
    expect(channels.sort()).toEqual(["sms", "wa"]);
  });

  // B858/B859: update()'s `options.compliance` (importer-only, never HTTP) writes the tobacco
  // licence fields and nothing else — never an address (so never a geocode) and never consent,
  // which only setCustomerConsent writes, with its evidence row. Moved here from
  // customers.service.spec.ts, which sits at its size-ratchet ceiling.
  it("update(id, {}, { compliance }) writes only licence fields, never consent, never geocodes", async () => {
    prisma.customer.findUnique.mockResolvedValue({ id: "cust-1", deletedAt: null });
    prisma.customer.update.mockResolvedValue({ id: "cust-1" });
    const geocodeSpy = jest.spyOn(service as any, "geocodeIfPossible");

    await (service.update as any)(
      "cust-1",
      {},
      { compliance: { tobaccoLicenseNo: "TL-1", smsConsent: true } },
    );

    expect(geocodeSpy).not.toHaveBeenCalled();
    const data = prisma.customer.update.mock.calls[0][0].data;
    expect(data).toEqual({ tobaccoLicenseNo: "TL-1" });
    expect(prisma.tenantTransaction).not.toHaveBeenCalled();
    expect(prisma.auditLog.create).not.toHaveBeenCalled();
  });
});
