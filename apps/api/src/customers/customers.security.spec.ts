/**
 * Security tests for the customers module.
 *
 * F4-002: ListCustomersDto.sortBy was passed straight into Prisma's orderBy, so
 * a caller could inject an unknown/relation field name (Prisma throws → 500 DoS)
 * or probe relation ordering. findAll now allowlists scalar sort columns and
 * falls back to a safe default for anything else.
 */
import { Test } from "@nestjs/testing";
import { CommissionEngineService } from "../sales-agents/commission-engine.service";
import { ConfigService } from "@nestjs/config";
import { CustomersService } from "./customers.service";
import { PrismaService } from "../prisma/prisma.service";
import { StorageService } from "../storage/storage.service";
import { MeterService } from "../billing/meter.service";
import { PlanCatalogService } from "../billing/plan-catalog.service";
import { EntitlementsService } from "../billing/entitlements.service";
import { createMockPrisma } from "../testing/prisma-mock";
import { ListCustomersDto } from "./dto/list-customers.dto";

describe("CustomersService — F4-002 sort-field allowlist", () => {
  let service: CustomersService;
  let prisma: ReturnType<typeof createMockPrisma>;

  beforeEach(async () => {
    prisma = createMockPrisma();
    const mod = await Test.createTestingModule({
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
          useValue: { upload: jest.fn(), delete: jest.fn(), presignedUrl: jest.fn() },
        },
        // Customer soft-cap collaborators — unused by the sort-field tests, but
        // CustomersService now depends on them.
        { provide: MeterService, useValue: { read: jest.fn() } },
        { provide: PlanCatalogService, useValue: { getPublishedVersion: jest.fn() } },
        {
          provide: EntitlementsService,
          useValue: { hasFlag: jest.fn().mockResolvedValue(false) },
        },
      ],
    }).compile();
    service = mod.get(CustomersService);
  });

  const orderByFromCall = () => prisma.customer.findMany.mock.calls[0][0].orderBy;

  it("falls back to the safe default for a NON-scalar column (receivables)", async () => {
    await service.findAll({ sortBy: "receivables", sortDir: "asc" } as ListCustomersDto);
    expect(orderByFromCall()).toEqual({ createdAt: "desc" });
  });

  it("falls back to the safe default for an injected/unknown field name", async () => {
    await service.findAll({ sortBy: "id); DROP TABLE customers;--" } as ListCustomersDto);
    expect(orderByFromCall()).toEqual({ createdAt: "desc" });
  });

  it.each(["__proto__", "constructor", "toString", "valueOf", "hasOwnProperty"])(
    "falls back to the safe default for the prototype key %s (Object.hasOwn guard)",
    async (key) => {
      await service.findAll({ sortBy: key } as ListCustomersDto);
      // Without the Object.hasOwn guard, a bare index would resolve the inherited
      // prototype value and reach Prisma as a malformed orderBy → 500.
      expect(orderByFromCall()).toEqual({ createdAt: "desc" });
    },
  );

  it("honors an allowlisted scalar column + direction", async () => {
    await service.findAll({ sortBy: "businessName", sortDir: "asc" } as ListCustomersDto);
    expect(orderByFromCall()).toEqual({ businessName: "asc" });
  });

  it("defaults the direction to desc for an allowlisted column with no dir", async () => {
    await service.findAll({ sortBy: "contactName" } as ListCustomersDto);
    expect(orderByFromCall()).toEqual({ contactName: "desc" });
  });

  it("uses the default order when no sortBy is supplied", async () => {
    await service.findAll({} as ListCustomersDto);
    expect(orderByFromCall()).toEqual({ createdAt: "desc" });
  });
});

// ─── Wave 4: operator statement-PDF endpoints stay OPERATOR-gated ─────────────
// The monthly statement exposes a customer's full financial position; both new
// routes must carry the same @Roles(OPERATOR) guard as their siblings.
// Reflection-only (no DI) — mirrors vendor-bills.security.spec's pattern.
import "reflect-metadata";
import { UserRole } from "@prisma/client";
import { CustomersController } from "./customers.controller";
import { ROLES_KEY } from "../auth/decorators/roles.decorator";

describe("CustomersController — statement endpoints role guard", () => {
  it.each([["getStatementMonths"], ["getStatementPdf"]] as const)(
    "%s requires OPERATOR",
    (method) => {
      const roles = Reflect.getMetadata(
        ROLES_KEY,
        CustomersController.prototype[method as keyof CustomersController] as object,
      );
      expect(roles).toEqual([UserRole.OPERATOR]);
    },
  );
});
