import { Test, TestingModule } from "@nestjs/testing";
import { NotFoundException, ForbiddenException, BadRequestException } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
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

  let configGet: jest.Mock;
  const originalFetch = global.fetch;

  beforeEach(async () => {
    prisma = createMockPrisma();
    // Defaults to "no key configured" so geocoding is a no-op for every pre-existing
    // test — narrow it per-test to exercise the geocode-on-update paths below.
    configGet = jest.fn().mockReturnValue(null);

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        DriversService,
        { provide: PrismaService, useValue: prisma },
        { provide: ConfigService, useValue: { get: configGet } },
      ],
    }).compile();

    service = module.get<DriversService>(DriversService);
  });

  afterEach(() => {
    global.fetch = originalFetch;
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

  // ─── update: home base geocoding ───────────────────────────────────────────

  describe("update", () => {
    it("composes homeAddress and writes coords when the geocoder succeeds", async () => {
      prisma.driver.findUnique.mockResolvedValue(MOCK_DRIVER);
      prisma.driver.update.mockResolvedValue(MOCK_DRIVER);
      configGet.mockImplementation((key: string) =>
        key === "googleMaps.apiKey" ? "test-key" : null,
      );
      global.fetch = jest.fn().mockResolvedValue({
        ok: true,
        json: async () => ({
          results: [{ geometry: { location: { lat: 40.7128, lng: -74.006 } } }],
        }),
      }) as any;

      await service.update("drv-1", {
        homeLine1: "123 Main St",
        homeCity: "Springfield",
        homeState: "IL",
        homeZip: "62701",
      });

      expect(prisma.driver.update).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: "drv-1" },
          data: expect.objectContaining({
            homeAddress: "123 Main St, Springfield, IL, 62701",
            homeLat: 40.7128,
            homeLng: -74.006,
          }),
        }),
      );
    });

    it("writes null coords without throwing when the geocoder fails", async () => {
      prisma.driver.findUnique.mockResolvedValue(MOCK_DRIVER);
      prisma.driver.update.mockResolvedValue(MOCK_DRIVER);
      configGet.mockImplementation((key: string) =>
        key === "googleMaps.apiKey" ? "test-key" : null,
      );
      global.fetch = jest.fn().mockRejectedValue(new Error("network down")) as any;

      await expect(
        service.update("drv-1", {
          homeLine1: "123 Main St",
          homeCity: "Springfield",
          homeState: "IL",
          homeZip: "62701",
        }),
      ).resolves.toEqual(MOCK_DRIVER);

      expect(prisma.driver.update).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            homeAddress: "123 Main St, Springfield, IL, 62701",
            homeLat: null,
            homeLng: null,
          }),
        }),
      );
    });

    it("never calls geocodeAddress when the update carries no home fields", async () => {
      prisma.driver.findUnique.mockResolvedValue(MOCK_DRIVER);
      prisma.driver.update.mockResolvedValue(MOCK_DRIVER);
      configGet.mockImplementation((key: string) =>
        key === "googleMaps.apiKey" ? "test-key" : null,
      );
      global.fetch = jest.fn();

      await service.update("drv-1", { contactName: "New Name" });

      expect(global.fetch).not.toHaveBeenCalled();
      expect(prisma.driver.update).toHaveBeenCalledWith(
        expect.objectContaining({
          data: { contactName: "New Name" },
        }),
      );
      const data = prisma.driver.update.mock.calls[0][0].data;
      expect(data).not.toHaveProperty("homeAddress");
      expect(data).not.toHaveProperty("homeLat");
      expect(data).not.toHaveProperty("homeLng");
    });
  });

  // ─── remove ───────────────────────────────────────────────────────────────

  describe("remove", () => {
    it("deletes the driver and the linked user when the login is a pure DRIVER account", async () => {
      prisma.driver.findUnique.mockResolvedValue(MOCK_DRIVER);
      prisma.routeRun.count.mockResolvedValue(0);
      prisma.user.findUnique.mockResolvedValue({ role: "DRIVER" } as any);

      const result = await service.remove("drv-1");

      expect(result).toEqual({ success: true });
      expect(prisma.driver.delete).toHaveBeenCalledWith({ where: { id: "drv-1" } });
      expect(prisma.user.delete).toHaveBeenCalledWith({ where: { id: "user-drv" } });
      expect(prisma.user.update).not.toHaveBeenCalled();
    });

    it("keeps the login and clears canActAsDriver when the linked user is not a pure DRIVER account", async () => {
      prisma.driver.findUnique.mockResolvedValue(MOCK_DRIVER);
      prisma.routeRun.count.mockResolvedValue(0);
      prisma.user.findUnique.mockResolvedValue({ role: "TENANT_ADMIN" } as any);

      const result = await service.remove("drv-1");

      expect(result).toEqual({ success: true });
      expect(prisma.driver.delete).toHaveBeenCalledWith({ where: { id: "drv-1" } });
      expect(prisma.user.delete).not.toHaveBeenCalled();
      expect(prisma.user.update).toHaveBeenCalledWith({
        where: { id: "user-drv" },
        data: { canActAsDriver: false },
      });
    });

    it("throws BadRequestException and deletes nothing when the driver has a scheduled or in-progress run", async () => {
      prisma.driver.findUnique.mockResolvedValue(MOCK_DRIVER);
      prisma.routeRun.count.mockResolvedValue(1);

      await expect(service.remove("drv-1")).rejects.toThrow(BadRequestException);

      expect(prisma.driver.delete).not.toHaveBeenCalled();
      expect(prisma.user.delete).not.toHaveBeenCalled();
      expect(prisma.user.update).not.toHaveBeenCalled();
    });
  });
});
