/**
 * M8 scoping (design.md §7): a DRIVER may only quote for the customer of a stop on
 * their OWN currently-IN_PROGRESS run — mirrors orders.service.ts's B309 guard.
 * Pricing math itself is covered exhaustively by inline-returns-pricing.spec.ts;
 * these tests focus on the scoping gate and basic service wiring.
 */
import { Test, TestingModule } from "@nestjs/testing";
import { ForbiddenException, NotFoundException } from "@nestjs/common";
import { InlineReturnsQuoteService } from "./inline-returns-quote.service";
import { PrismaService } from "../prisma/prisma.service";
import { createMockPrisma } from "../testing/prisma-mock";
import type { JwtPayload } from "../auth/jwt-payload.interface";

const OPERATOR: JwtPayload = {
  sub: "user-op-1",
  role: "OPERATOR",
  forcePasswordChange: false,
  tenantId: "t1",
  tenantSlug: "acme",
  username: "admin",
  status: "ACTIVE",
} as JwtPayload;

const DRIVER: JwtPayload = {
  sub: "user-drv-1",
  role: "DRIVER",
  forcePasswordChange: false,
  tenantId: "t1",
  tenantSlug: "acme",
  username: "driver1",
  status: "ACTIVE",
} as JwtPayload;

describe("InlineReturnsQuoteService — M8 driver scoping", () => {
  let service: InlineReturnsQuoteService;
  let prisma: ReturnType<typeof createMockPrisma>;
  let db: ReturnType<PrismaService["forTenant"]>;

  beforeEach(async () => {
    prisma = createMockPrisma();
    const module: TestingModule = await Test.createTestingModule({
      providers: [InlineReturnsQuoteService, { provide: PrismaService, useValue: prisma }],
    }).compile();
    service = module.get(InlineReturnsQuoteService);
    db = prisma.forTenant();
  });

  const dto = { customerId: "cust-1", items: [{ productId: "prod-1", qty: 1 }] };

  it("refuses a DRIVER quote with no routeRunStopId", async () => {
    await expect(service.quote(dto, DRIVER)).rejects.toThrow(ForbiddenException);
  });

  it("refuses when the stop belongs to a different customer", async () => {
    (db.routeRunStop.findFirst as jest.Mock).mockResolvedValue({
      id: "stop-1",
      routeRunId: "run-1",
      customerId: "cust-OTHER",
    });
    await expect(service.quote({ ...dto, routeRunStopId: "stop-1" }, DRIVER)).rejects.toThrow(
      ForbiddenException,
    );
  });

  it("refuses when the run belongs to a different driver", async () => {
    (db.routeRunStop.findFirst as jest.Mock).mockResolvedValue({
      id: "stop-1",
      routeRunId: "run-1",
      customerId: "cust-1",
    });
    (db.driver.findFirst as jest.Mock).mockResolvedValue({ id: "driver-1" });
    (db.routeRun.findFirst as jest.Mock).mockResolvedValue({
      id: "run-1",
      driverId: "driver-OTHER",
      status: "IN_PROGRESS",
    });
    await expect(service.quote({ ...dto, routeRunStopId: "stop-1" }, DRIVER)).rejects.toThrow(
      ForbiddenException,
    );
  });

  it("refuses when the run is not IN_PROGRESS", async () => {
    (db.routeRunStop.findFirst as jest.Mock).mockResolvedValue({
      id: "stop-1",
      routeRunId: "run-1",
      customerId: "cust-1",
    });
    (db.driver.findFirst as jest.Mock).mockResolvedValue({ id: "driver-1" });
    (db.routeRun.findFirst as jest.Mock).mockResolvedValue({
      id: "run-1",
      driverId: "driver-1",
      status: "COMPLETED",
    });
    await expect(service.quote({ ...dto, routeRunStopId: "stop-1" }, DRIVER)).rejects.toThrow(
      ForbiddenException,
    );
  });

  it("proceeds past the scoping gate for a driver on their own in-progress stop", async () => {
    (db.routeRunStop.findFirst as jest.Mock).mockResolvedValue({
      id: "stop-1",
      routeRunId: "run-1",
      customerId: "cust-1",
    });
    (db.driver.findFirst as jest.Mock).mockResolvedValue({ id: "driver-1" });
    (db.routeRun.findFirst as jest.Mock).mockResolvedValue({
      id: "run-1",
      driverId: "driver-1",
      status: "IN_PROGRESS",
    });
    (db.customer.findUnique as jest.Mock).mockResolvedValue({
      id: "cust-1",
      pricingTier: 1,
      isTaxExempt: false,
    });
    const result = await service.quote({ ...dto, routeRunStopId: "stop-1" }, DRIVER);
    expect(result.total).toBe(0); // no candidate lines / product in the mock — over-return at $0 tier price
  });

  it("never scopes an OPERATOR caller (no routeRunStopId required)", async () => {
    (db.customer.findUnique as jest.Mock).mockResolvedValue({
      id: "cust-1",
      pricingTier: 1,
      isTaxExempt: false,
    });
    await expect(service.quote(dto, OPERATOR)).resolves.toBeDefined();
    expect(db.routeRunStop.findFirst).not.toHaveBeenCalled();
  });

  it("404s when the customer does not exist", async () => {
    (db.customer.findUnique as jest.Mock).mockResolvedValue(null);
    await expect(service.quote(dto, OPERATOR)).rejects.toThrow(NotFoundException);
  });
});
