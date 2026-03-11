import { Test, TestingModule } from "@nestjs/testing";
import { NotFoundException, ForbiddenException } from "@nestjs/common";
import { DriversService } from "./drivers.service";
import { PrismaService } from "../prisma/prisma.service";
import { createMockPrisma } from "../testing/prisma-mock";

const MOCK_DRIVER = {
  id: "drv-1",
  userId: "user-drv",
  contactName: "Jane Smith",
  phone: "555-0200",
  status: "ACTIVE" as const,
  vehicleMake: "Toyota",
  vehicleModel: "HiAce",
  vehicleColour: "White",
  vehiclePlate: "ABC-123",
  createdAt: new Date(),
  updatedAt: new Date(),
};

const operatorPayload = {
  sub: "user-op",
  username: "operator",
  role: "OPERATOR" as const,
  status: "ACTIVE" as const,
  forcePasswordChange: false,
};

const driverPayload = {
  sub: "user-drv",
  username: "driver1",
  role: "DRIVER" as const,
  status: "ACTIVE" as const,
  forcePasswordChange: false,
};

describe("DriversService", () => {
  let service: DriversService;
  let prisma: ReturnType<typeof createMockPrisma>;

  beforeEach(async () => {
    prisma = createMockPrisma();

    const module: TestingModule = await Test.createTestingModule({
      providers: [DriversService, { provide: PrismaService, useValue: prisma }],
    }).compile();

    service = module.get<DriversService>(DriversService);
  });

  // ─── findAll ──────────────────────────────────────────────────────────────

  describe("findAll", () => {
    it("should return paginated drivers", async () => {
      prisma.driver.findMany.mockResolvedValue([MOCK_DRIVER]);
      prisma.driver.count.mockResolvedValue(1);

      const result = await service.findAll({ page: 1, limit: 20 });

      expect(result.data).toHaveLength(1);
      expect(result.meta.total).toBe(1);
    });

    it("should filter by status", async () => {
      prisma.driver.findMany.mockResolvedValue([]);
      prisma.driver.count.mockResolvedValue(0);

      await service.findAll({ status: "ACTIVE" as any, page: 1, limit: 20 });

      expect(prisma.driver.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({ status: "ACTIVE" }),
        }),
      );
    });

    it("should search by contactName, username, and phone", async () => {
      prisma.driver.findMany.mockResolvedValue([]);
      prisma.driver.count.mockResolvedValue(0);

      await service.findAll({ search: "jane", page: 1, limit: 20 });

      expect(prisma.driver.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            OR: expect.arrayContaining([{ contactName: expect.any(Object) }]),
          }),
        }),
      );
    });
  });

  // ─── findOne ──────────────────────────────────────────────────────────────

  describe("findOne", () => {
    it("should return driver for operators", async () => {
      prisma.driver.findUnique.mockResolvedValue(MOCK_DRIVER);
      const result = await service.findOne("drv-1", operatorPayload);
      expect(result).toEqual(MOCK_DRIVER);
    });

    it("should return driver when authenticated driver matches", async () => {
      prisma.driver.findUnique.mockResolvedValue(MOCK_DRIVER);
      const result = await service.findOne("drv-1", driverPayload);
      expect(result).toEqual(MOCK_DRIVER);
    });

    it("should throw ForbiddenException when a different driver tries to access", async () => {
      prisma.driver.findUnique.mockResolvedValue(MOCK_DRIVER);

      const otherDriver = { ...driverPayload, sub: "user-other" };
      await expect(service.findOne("drv-1", otherDriver)).rejects.toThrow(ForbiddenException);
    });

    it("should throw NotFoundException when driver does not exist", async () => {
      prisma.driver.findUnique.mockResolvedValue(null);
      await expect(service.findOne("nonexistent", operatorPayload)).rejects.toThrow(
        NotFoundException,
      );
    });
  });

  // ─── changeStatus ─────────────────────────────────────────────────────────

  describe("changeStatus", () => {
    it("should update driver status", async () => {
      prisma.driver.findUnique.mockResolvedValue(MOCK_DRIVER);
      prisma.driver.update.mockResolvedValue({});

      const result = await service.changeStatus("drv-1", { status: "INACTIVE" as any });

      expect(result).toEqual({ success: true });
      expect(prisma.driver.update).toHaveBeenCalledWith({
        where: { id: "drv-1" },
        data: { status: "INACTIVE" },
      });
    });

    it("should throw NotFoundException for non-existent driver", async () => {
      prisma.driver.findUnique.mockResolvedValue(null);
      await expect(
        service.changeStatus("nonexistent", { status: "INACTIVE" as any }),
      ).rejects.toThrow(NotFoundException);
    });
  });

  // ─── findMetrics ──────────────────────────────────────────────────────────

  describe("findMetrics", () => {
    it("should return completed and total runs", async () => {
      prisma.driver.findUnique.mockResolvedValue(MOCK_DRIVER);
      prisma.routeRun.count
        .mockResolvedValueOnce(5) // completed
        .mockResolvedValueOnce(10); // total

      const result = await service.findMetrics("drv-1");

      expect(result).toEqual({ completedRuns: 5, totalRuns: 10 });
    });
  });
});
