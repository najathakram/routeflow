import { Test } from "@nestjs/testing";
import { RegulatedService } from "./regulated.service";
import { PrismaService } from "../prisma/prisma.service";
import { createMockPrisma } from "../testing/prisma-mock";

describe("RegulatedService.getLedger", () => {
  let service: RegulatedService;
  let prisma: ReturnType<typeof createMockPrisma>;

  beforeEach(async () => {
    prisma = createMockPrisma();
    const mod = await Test.createTestingModule({
      providers: [RegulatedService, { provide: PrismaService, useValue: prisma }],
    }).compile();
    service = mod.get(RegulatedService);
    // groupBy isn't in the default mock surface — stub it for these tests.
    (prisma.regulatedSalesLedger as any).groupBy = jest.fn().mockResolvedValue([]);
  });

  const whereOf = () => (prisma.regulatedSalesLedger as any).groupBy.mock.calls[0][0].where;

  it("filters soldAt INCLUSIVELY (.lte) by default (user-facing /ledger)", async () => {
    await service.getLedger({ from: "2026-01-01T00:00:00.000Z", to: "2026-02-01T00:00:00.000Z" });
    const where = whereOf();
    expect(where.soldAt.gte).toEqual(new Date("2026-01-01T00:00:00.000Z"));
    expect(where.soldAt.lte).toEqual(new Date("2026-02-01T00:00:00.000Z"));
    expect(where.soldAt.lt).toBeUndefined();
  });

  it("filters soldAt EXCLUSIVELY (.lt) for exact half-open filing windows", async () => {
    await service.getLedger(
      { from: "2026-01-01T00:00:00.000Z", to: "2026-02-01T00:00:00.000Z" },
      { exclusiveTo: true },
    );
    const where = whereOf();
    expect(where.soldAt.lt).toEqual(new Date("2026-02-01T00:00:00.000Z"));
    expect(where.soldAt.lte).toBeUndefined();
  });
});
