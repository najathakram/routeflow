/**
 * Customer purge paths must reverse an invoice's regulated-sales ledger entries
 * before destroying it.
 *
 * The regulated ledger is append-only and holds NO foreign key to Invoice — it
 * keeps its own snapshot — so once an invoice row is deleted, its entries can
 * never be matched back and regulated sales and excise are permanently
 * overstated. `invoices.service` honours this in `voidInvoiceInTx` and
 * `deleteInvoice`, and `orders.service.deleteOrder` was fixed to honour it in
 * campaign batch F07 (B65). The customer purge paths were the remaining
 * violators.
 *
 * WHAT THE ORIGINAL REPORT GOT WRONG. The finding pointed at `deleteCustomer`'s
 * hard-delete block. That site cannot actually destroy an invoice: it is only
 * reached when the pre-flight counted ZERO orders, invoices and returns
 * (`hasFinancialRecords === false`), so its `invoice.deleteMany` is defensive.
 * The two paths that genuinely leak are the BULK ones, and neither was named in
 * the report:
 *
 *   - `deleteAllCustomers` blocks only on issued or paid invoices (PAID or SENT at the time;
 *     SENT/VIEWED/PARTIAL/OVERDUE/PAID since #2558), then hard-deletes every remaining invoice —
 *     DRAFT included.
 *   - `deleteImportedCustomers` had **no invoice guard at all** (since #2569 it runs the same
 *     pre-flight, in-tx re-check and CAS delete as deleteAllCustomers).
 *
 * The load-bearing fact that makes those real: a **DRAFT invoice already carries
 * ledger rows**. `createSplitInvoices` calls `ledger.writeSaleEntries` in the
 * same transaction that creates the invoice with `status: DRAFT`, before it is
 * ever sent. So "we only delete drafts" is not a defence, and any future
 * status-based filter here would reintroduce the leak.
 */

import { Test, TestingModule } from "@nestjs/testing";
import { ConfigService } from "@nestjs/config";

import { CustomersService } from "./customers.service";
import { PrismaService } from "../prisma/prisma.service";
import { StorageService } from "../storage/storage.service";
import { MeterService } from "../billing/meter.service";
import { PlanCatalogService } from "../billing/plan-catalog.service";
import { EntitlementAuthority } from "../billing/entitlement-authority.service";
import { CommissionEngineService } from "../sales-agents/commission-engine.service";
import { RegulatedLedgerService } from "../regulated/regulated-ledger.service";
import { EmailService } from "../email/email.service";
import { createMockPrisma } from "../testing/prisma-mock";

describe("CustomersService — purge paths reverse the regulated ledger", () => {
  let service: CustomersService;
  let prisma: ReturnType<typeof createMockPrisma>;
  let ledger: { reverseInvoiceEntries: jest.Mock };
  /** Shared call log — the ORDER of reversal vs deletion is the whole point. */
  let calls: string[];

  beforeEach(async () => {
    prisma = createMockPrisma();
    calls = [];
    ledger = {
      reverseInvoiceEntries: jest.fn().mockImplementation(({ invoiceId }: any) => {
        calls.push(`reverse:${invoiceId}`);
        return Promise.resolve(undefined);
      }),
    };

    (prisma as any).tenantSubscription = {
      findUnique: jest.fn().mockResolvedValue(null),
      upsert: jest.fn().mockResolvedValue({}),
    };
    prisma.getTenantId.mockReturnValue("tenant-a");
    prisma.invoiceItem.deleteMany.mockImplementation(() => {
      calls.push("deleteItems");
      return Promise.resolve({ count: 0 });
    });
    // SA-510a: deleteAllCustomers' invoice delete is a CAS that must remove exactly the rows it
    // read (primeInvoices' two DRAFTs).
    prisma.invoice.deleteMany.mockImplementation(() => {
      calls.push("deleteInvoices");
      return Promise.resolve({ count: 2 });
    });

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        CustomersService,
        { provide: PrismaService, useValue: prisma },
        { provide: ConfigService, useValue: { get: jest.fn().mockReturnValue(null) } },
        {
          provide: StorageService,
          useValue: { upload: jest.fn(), delete: jest.fn(), presignedUrl: jest.fn() },
        },
        {
          provide: MeterService,
          useValue: { read: jest.fn().mockResolvedValue({ used: 0, included: null }) },
        },
        { provide: PlanCatalogService, useValue: { getPublishedVersion: jest.fn() } },
        {
          provide: EntitlementAuthority,
          useValue: { can: jest.fn().mockResolvedValue(false) },
        },
        {
          provide: CommissionEngineService,
          useValue: {
            syncInvoiceCommissionSafe: jest.fn(),
            syncOrderInvoices: jest.fn(),
            syncInvoiceCommission: jest.fn(),
            removeInvoiceCommission: jest.fn(),
          },
        },
        { provide: RegulatedLedgerService, useValue: ledger },
        {
          provide: EmailService,
          useValue: { send: jest.fn().mockResolvedValue({ delivered: true, transport: "resend" }) },
        },
      ],
    }).compile();

    service = module.get<CustomersService>(CustomersService);
  });

  /** Two DRAFT invoices — the status that used to look safe and is not. */
  function primeInvoices() {
    prisma.invoice.findMany.mockResolvedValue([
      { id: "inv-1", customerId: "cust-1", status: "DRAFT" },
      { id: "inv-2", customerId: "cust-1", status: "DRAFT" },
    ]);
  }

  it("REG-LEDGER-PURGE: deleteAllCustomers reverses every invoice's ledger entries BEFORE deleting them", async () => {
    prisma.customer.findMany.mockResolvedValue([{ id: "cust-1", userId: "user-1" }]);
    // Pre-flight blocks only on PAID/SENT, so an empty result lets the wipe run
    // while DRAFT invoices still exist — the exact leak.
    prisma.invoice.groupBy.mockResolvedValue([]);
    primeInvoices();

    await service.deleteAllCustomers();

    expect(ledger.reverseInvoiceEntries).toHaveBeenCalledTimes(2);
    for (const id of ["inv-1", "inv-2"]) {
      expect(ledger.reverseInvoiceEntries).toHaveBeenCalledWith(
        expect.objectContaining({ invoiceId: id }),
      );
    }
    // Both entries must EXIST before their order means anything — indexOf
    // returns -1 for an absent call, so a bare `<` would also pass on a tree
    // where the reversal never happened at all.
    expect(calls).toContain("reverse:inv-1");
    expect(calls).toContain("deleteInvoices");
    expect(calls.indexOf("reverse:inv-1")).toBeLessThan(calls.indexOf("deleteItems"));
    expect(calls.indexOf("reverse:inv-2")).toBeLessThan(calls.indexOf("deleteInvoices"));
  });

  it("REG-LEDGER-PURGE: deleteImportedCustomers reverses its (DRAFT/VOID-only, #2569) invoices' ledger entries too", async () => {
    prisma.customer.findMany.mockResolvedValue([
      { id: "cust-1", userId: "user-1", customerLink: { status: "PENDING" } },
    ]);
    primeInvoices();

    await service.runImportedCustomersCleanup();

    expect(ledger.reverseInvoiceEntries).toHaveBeenCalledTimes(2);
    expect(calls.indexOf("reverse:inv-1")).toBeLessThan(calls.indexOf("deleteItems"));
    expect(calls.indexOf("reverse:inv-2")).toBeLessThan(calls.indexOf("deleteInvoices"));
  });

  it("REG-LEDGER-PURGE: an ACTIVE-linked customer is preserved, so nothing is reversed or deleted for them", async () => {
    prisma.customer.findMany.mockResolvedValue([
      { id: "cust-1", userId: "user-1", customerLink: { status: "ACTIVE" } },
    ]);
    primeInvoices();

    const result = await service.runImportedCustomersCleanup();

    expect(result).toEqual({ deleted: 0, preserved: 1 });
    expect(ledger.reverseInvoiceEntries).not.toHaveBeenCalled();
  });

  it("REG-LEDGER-PURGE: deleteAllCustomers still refuses a null tenant before touching the ledger", async () => {
    prisma.getTenantId.mockReturnValue(null);

    await expect(service.deleteAllCustomers()).rejects.toThrow(/tenant context/i);
    expect(ledger.reverseInvoiceEntries).not.toHaveBeenCalled();
  });
});
