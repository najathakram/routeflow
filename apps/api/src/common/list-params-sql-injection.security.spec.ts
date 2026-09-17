import "reflect-metadata";
import { Test } from "@nestjs/testing";
import { plainToInstance } from "class-transformer";
import { validate } from "class-validator";
import { ListCustomersDto } from "../customers/dto/list-customers.dto";
import { ListOrdersDto } from "../orders/dto/list-orders.dto";
import { ListProductsDto } from "../products/dto/list-products.dto";
import { ListInvoicesDto } from "../invoices/dto/list-invoices.dto";
import { CustomersService } from "../customers/customers.service";
import { PrismaService } from "../prisma/prisma.service";
import { StorageService } from "../storage/storage.service";
import { MeterService } from "../billing/meter.service";
import { PlanCatalogService } from "../billing/plan-catalog.service";
import { EntitlementsService } from "../billing/entitlements.service";
import { CommissionEngineService } from "../sales-agents/commission-engine.service";
import { RegulatedLedgerService } from "../regulated/regulated-ledger.service";
import { EmailService } from "../email/email.service";
import { ConfigService } from "@nestjs/config";
import { createMockPrisma } from "../testing/prisma-mock";

const SQLI_PAYLOAD = "'; DROP TABLE customers; --";

/**
 * B451 Phase A — Strix coverage gap 3 (SQL injection via /customers /orders
 * /products /invoices search/filter params). Static read of every list-query
 * builder in these four services (customers.service.ts:134-142,
 * orders.service.ts:367-370, products.service.ts:226-231,
 * invoices.service.ts:3017-3021) shows the `search` value is always assigned
 * straight into a Prisma `{ field: { contains, mode: "insensitive" } }`
 * clause — Prisma's own parameterized query builder — never string-
 * concatenated into raw SQL. The only `$queryRaw` in this surface
 * (invoices.service.ts:3244) is a tagged template with bound params for an
 * unrelated KPI average, not reachable from list params. `sortBy` is either
 * absent from the client-controlled surface (orders/products hardcode
 * orderBy) or allowlisted via `Object.hasOwn` before reaching Prisma
 * (customers.service.ts F4-002, invoices.service.ts:3061-3069).
 */
describe("List DTOs accept a SQLi-shaped search string as an ordinary string (B451 gap 3)", () => {
  it.each([
    ["ListCustomersDto", ListCustomersDto],
    ["ListOrdersDto", ListOrdersDto],
    ["ListProductsDto", ListProductsDto],
    ["ListInvoicesDto", ListInvoicesDto],
  ])("REFUTED: %s.search passes @IsString() validation unmangled", async (_name, DtoClass) => {
    const instance = plainToInstance(DtoClass as any, { search: SQLI_PAYLOAD });
    const errors = await validate(instance, { whitelist: true, forbidNonWhitelisted: true });
    expect(errors.filter((e) => e.property === "search")).toHaveLength(0);
    expect((instance as any).search).toBe(SQLI_PAYLOAD);
  });
});

describe("CustomersService.findAll — SQLi payload reaches Prisma as a bound `contains` filter (B451 gap 3)", () => {
  let service: CustomersService;
  let prisma: ReturnType<typeof createMockPrisma>;

  beforeEach(async () => {
    prisma = createMockPrisma();
    const mod = await Test.createTestingModule({
      providers: [
        CustomersService,
        {
          provide: CommissionEngineService,
          useValue: {
            syncInvoiceCommissionSafe: jest.fn(),
            syncOrderInvoices: jest.fn(),
            syncInvoiceCommission: jest.fn(),
          },
        },
        { provide: RegulatedLedgerService, useValue: { reverseInvoiceEntries: jest.fn() } },
        { provide: PrismaService, useValue: prisma },
        { provide: ConfigService, useValue: { get: jest.fn().mockReturnValue(null) } },
        {
          provide: StorageService,
          useValue: { upload: jest.fn(), delete: jest.fn(), presignedUrl: jest.fn() },
        },
        { provide: MeterService, useValue: { read: jest.fn() } },
        { provide: PlanCatalogService, useValue: { getPublishedVersion: jest.fn() } },
        { provide: EntitlementsService, useValue: { hasFlag: jest.fn().mockResolvedValue(false) } },
        { provide: EmailService, useValue: { send: jest.fn() } },
      ],
    }).compile();
    service = mod.get(CustomersService);
  });

  it("REFUTED: search is passed to Prisma's `contains` operator, never string-interpolated", async () => {
    await service.findAll({ search: SQLI_PAYLOAD } as ListCustomersDto);
    const where = prisma.customer.findMany.mock.calls[0][0].where;
    expect(where.OR).toEqual(
      expect.arrayContaining([{ businessName: { contains: SQLI_PAYLOAD, mode: "insensitive" } }]),
    );
    // The payload is a VALUE inside a structured Prisma filter object, not a
    // fragment of a SQL string — there is nothing here for Postgres to parse
    // as a second statement.
  });
});
