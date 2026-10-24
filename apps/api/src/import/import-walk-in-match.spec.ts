/**
 * The customer CSV import never matches the tenant's walk-in customer, by business name or by Customer ID:
 * its stored email stays as it is. A row that names it is handled like any row with no match.
 */
import { Test } from "@nestjs/testing";
import { ImportService } from "./import.service";
import { PrismaService } from "../prisma/prisma.service";
import { VendorBillsService } from "../vendor-bills/vendor-bills.service";
import { CustomersService } from "../customers/customers.service";
import { createMockPrisma } from "../testing/prisma-mock";
import { RegulatedLedgerService } from "../regulated/regulated-ledger.service";
import { NumberingService } from "./numbering.service";
import { ExternalRefService } from "./external-ref.service";
import { ProductsService } from "../products/products.service";
import { AuditService } from "../audit/audit.service";
import { SellingRestrictionsService } from "../selling-restrictions/selling-restrictions.service";

describe("ImportService.importContacts: the walk-in customer is never matched", () => {
  let service: ImportService;
  let prisma: ReturnType<typeof createMockPrisma>;
  let customers: {
    assertCustomerCapNotExceeded: jest.Mock;
    maybeStartCustomerGrace: jest.Mock;
    update: jest.Mock;
  };

  beforeEach(async () => {
    prisma = createMockPrisma();
    customers = {
      assertCustomerCapNotExceeded: jest.fn().mockResolvedValue(undefined),
      maybeStartCustomerGrace: jest.fn().mockResolvedValue(undefined),
      // B858/B859 harness note: not yet called by ImportService (RC1) — added so this mock is
      // ready for FIX2's commercial-column update path.
      update: jest.fn().mockResolvedValue({ id: "cust-1" }),
    };
    const mod = await Test.createTestingModule({
      providers: [
        ImportService,
        { provide: PrismaService, useValue: prisma },
        { provide: VendorBillsService, useValue: { create: jest.fn(), receive: jest.fn() } },
        { provide: CustomersService, useValue: customers },
        // Harness: ImportService injects NumberingService (B267/B269);
        // these suites never exercise a mint, so the mock only satisfies DI.
        {
          provide: NumberingService,
          useValue: { reserveNext: jest.fn().mockResolvedValue("INV-2026-0001") },
        },
        // Harness: ImportService injects ExternalRefService (B268/D4 re-import
        // idempotency for source-numberless rows). Mocked at the module boundary;
        // `findLocalId` → null means "never imported before", the state every
        // suite here assumes.
        {
          provide: ExternalRefService,
          useValue: {
            findLocalId: jest.fn().mockResolvedValue(null),
            record: jest.fn().mockResolvedValue(undefined),
          },
        },
        // B858/B859 harness note: not yet consumed by ImportService's constructor (RC1) — added
        // here so this module keeps compiling once FIX2 wires them in.
        {
          provide: ProductsService,
          useValue: {
            create: jest.fn().mockResolvedValue({ id: "prod-1" }),
            update: jest.fn().mockResolvedValue({ id: "prod-1" }),
            emitCatalogBulkChanged: jest.fn(),
            assertCanFlagTobacco: jest.fn().mockResolvedValue(undefined),
            assertMsrpAllowed: jest.fn().mockResolvedValue(undefined),
          },
        },
        { provide: AuditService, useValue: { log: jest.fn().mockResolvedValue(undefined) } },
        {
          provide: SellingRestrictionsService,
          useValue: {
            judgeStaffWrite: jest.fn().mockResolvedValue({
              outcome: "ALLOW",
              reasons: [],
              breaches: [],
              basis: "CUSTOMER",
            }),
          },
        },
      ],
    }).compile();
    service = mod.get(ImportService);
  });

  const WALK_IN = {
    id: "walk-1",
    businessName: "Counter Sales",
    zohoContactId: "ZC-1",
    email: "walk@acme.example",
    isWalkIn: true,
    deletedAt: null,
    addresses: [],
    contactPersons: [],
  };
  // The lookups honour the walk-in exclusion the way the database would: an ordinary customer query
  // returns the row, a query carrying the isWalkIn exclusion does not, and the walk-in lookup finds it.
  const excludes = (args: any) =>
    JSON.stringify(args?.where ?? {}).includes("isWalkIn") && args?.where?.isWalkIn !== true;
  const RESERVED = "Row 1 skipped: this name is reserved for walk-in sales.";

  beforeEach(() => {
    prisma.customer.findFirst.mockImplementation((async (args: any) =>
      args?.where?.isWalkIn === true
        ? WALK_IN
        : excludes(args)
          ? null
          : args?.where?.zohoContactId === "ZC-1"
            ? WALK_IN
            : null) as any);
    prisma.customer.findMany.mockImplementation((async (args: any) =>
      excludes(args) ? [] : [WALK_IN]) as any);
  });

  const walkInEmailWrites = () =>
    prisma.customer.update.mock.calls.filter(
      ([a]: any[]) => a?.where?.id === "walk-1" && a?.data && "email" in a.data,
    );

  it("a row carrying the walk-in's business name is skipped with a row error", async () => {
    const res: any = await service.importContacts(
      Buffer.from("Customer Name,Email\nCounter Sales,other@acme.example\n"),
      "user-1",
    );

    expect(walkInEmailWrites()).toHaveLength(0);
    expect(res.created).toBe(0);
    expect(res.skipped).toBe(1);
    expect(res.skippedRows[0]).toMatchObject({ row: 1, reason: RESERVED });
    expect(res.errors.join("\n")).toContain(RESERVED);
  });

  it("a row carrying the walk-in's Customer ID is skipped with a row error", async () => {
    const res: any = await service.importContacts(
      Buffer.from("Customer ID,Customer Name,Email\nZC-1,Renamed Shop,other@acme.example\n"),
      "user-1",
    );

    expect(walkInEmailWrites()).toHaveLength(0);
    expect(res.created).toBe(0);
    expect(res.skippedRows[0]).toMatchObject({ row: 1, reason: RESERVED });
  });

  it("other rows in the same file still import", async () => {
    const res: any = await service.importContacts(
      Buffer.from("Customer Name,Email\nCounter Sales,a@acme.example\nShop Two,b@acme.example\n"),
      "user-1",
    );

    expect(res.created).toBe(1);
    expect(res.skipped).toBe(1);
    expect(walkInEmailWrites()).toHaveLength(0);
  });
});
