/**
 * The CUSTOMERS soft cap has to cover the bulk import path, not just
 * CustomersService.create() — importing a CSV would otherwise be a free bypass:
 * every row created, no grace window ever opened, and so the single-create gate
 * permanently disarmed (it only ever fires on an aged, already-open window).
 */
import { Test } from "@nestjs/testing";
import { ForbiddenException } from "@nestjs/common";
import { ImportService } from "./import.service";
import { PrismaService } from "../prisma/prisma.service";
import { VendorBillsService } from "../vendor-bills/vendor-bills.service";
import { CustomersService } from "../customers/customers.service";
import { createMockPrisma } from "../testing/prisma-mock";
import { RegulatedLedgerService } from "../regulated/regulated-ledger.service";

describe("ImportService — CUSTOMERS soft cap", () => {
  let service: ImportService;
  let prisma: ReturnType<typeof createMockPrisma>;
  let customers: { assertCustomerCapNotExceeded: jest.Mock; maybeStartCustomerGrace: jest.Mock };

  beforeEach(async () => {
    prisma = createMockPrisma();
    customers = {
      assertCustomerCapNotExceeded: jest.fn().mockResolvedValue(undefined),
      maybeStartCustomerGrace: jest.fn().mockResolvedValue(undefined),
    };
    const mod = await Test.createTestingModule({
      providers: [
        ImportService,
        { provide: PrismaService, useValue: prisma },
        { provide: VendorBillsService, useValue: { create: jest.fn(), receive: jest.fn() } },
        { provide: CustomersService, useValue: customers },
      ],
    }).compile();
    service = mod.get(ImportService);
  });

  it("importContacts gates once up front and writes nothing when the cap gate throws", async () => {
    customers.assertCustomerCapNotExceeded.mockRejectedValue(new ForbiddenException("gated"));

    await expect(
      service.importContacts(Buffer.from("Customer Name\nAcme Supply\n"), "user-1"),
    ).rejects.toBeInstanceOf(ForbiddenException);

    expect(customers.assertCustomerCapNotExceeded).toHaveBeenCalledTimes(1);
    expect(prisma.tenantTransaction).not.toHaveBeenCalled();
    expect(customers.maybeStartCustomerGrace).not.toHaveBeenCalled();
  });

  it("importContacts opens the grace window after creating rows", async () => {
    const res = await service.importContacts(Buffer.from("Customer Name\nAcme Supply\n"), "user-1");

    expect(res.created).toBe(1);
    expect(customers.maybeStartCustomerGrace).toHaveBeenCalledTimes(1);
  });

  it("importContacts skips the grace hook when nothing was created", async () => {
    const res = await service.importContacts(
      Buffer.from("Customer Name,Contact Type\nAcme Supply,vendor\n"),
      "user-1",
    );

    expect(res.created).toBe(0);
    expect(customers.maybeStartCustomerGrace).not.toHaveBeenCalled();
  });

  it("importInvoices opens the grace window for auto-created customers but never pre-gates", async () => {
    await service.importInvoices(
      Buffer.from("Invoice Number,Customer Name,Total\nINV-1,Acme Supply,10\n"),
      "user-1",
    );

    // A finance import is never blocked by the customer cap...
    expect(customers.assertCustomerCapNotExceeded).not.toHaveBeenCalled();
    // ...but the customer it conjured still has to be reported against the cap.
    expect(customers.maybeStartCustomerGrace).toHaveBeenCalledTimes(1);
  });
});
