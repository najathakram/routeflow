/**
 * Security tests for the customers module.
 *
 * F4-002: ListCustomersDto.sortBy was passed straight into Prisma's orderBy, so
 * a caller could inject an unknown/relation field name (Prisma throws → 500 DoS)
 * or probe relation ordering. findAll now allowlists scalar sort columns and
 * falls back to a safe default for anything else.
 */
import { Test } from "@nestjs/testing";
import { ConfigService } from "@nestjs/config";
import { CustomersService } from "./customers.service";
import { PrismaService } from "../prisma/prisma.service";
import { StorageService } from "../storage/storage.service";
import { createMockPrisma } from "../testing/prisma-mock";
import { ListCustomersDto } from "./dto/list-customers.dto";

describe("CustomersService — F4-002 sort-field allowlist", () => {
  let service: CustomersService;
  let prisma: ReturnType<typeof createMockPrisma>;

  beforeEach(async () => {
    prisma = createMockPrisma();
    const mod = await Test.createTestingModule({
      providers: [
        CustomersService,
        { provide: PrismaService, useValue: prisma },
        { provide: ConfigService, useValue: { get: jest.fn().mockReturnValue(null) } },
        {
          provide: StorageService,
          useValue: { upload: jest.fn(), delete: jest.fn(), presignedUrl: jest.fn() },
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
