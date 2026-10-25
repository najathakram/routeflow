import { Test } from "@nestjs/testing";
import { ConflictException } from "@nestjs/common";
import { PrismaService } from "../prisma/prisma.service";
import { createMockPrisma } from "../testing/prisma-mock";
import { ProductsService } from "../products/products.service";
import { ExternalRefService } from "./external-ref.service";
import { DuplicateMatchService } from "./duplicate-match.service";
import { MigrationService } from "./migration.service";

/**
 * T4 BT-9 (migration/import, tier 1): B334 (one colliding row left earlier rows live and the job stuck) and B205 (the
 * Migration Hub's product price "1,234.56" was lost or threw). The wrong values these pin: job status STAGED after a
 * failing row, and a thousands-comma price reaching products.create / the staged payload verbatim.
 */
describe("MigrationService, BT-9", () => {
  let service: MigrationService;
  let prisma: ReturnType<typeof createMockPrisma>;
  let products: { create: jest.Mock };
  let externalRefs: { findLocalId: jest.Mock; record: jest.Mock };

  beforeEach(async () => {
    prisma = createMockPrisma();
    products = { create: jest.fn() };
    externalRefs = {
      findLocalId: jest.fn().mockResolvedValue(null),
      record: jest.fn().mockResolvedValue(undefined),
    };
    const moduleRef = await Test.createTestingModule({
      providers: [
        MigrationService,
        { provide: PrismaService, useValue: prisma },
        { provide: ProductsService, useValue: products },
        { provide: ExternalRefService, useValue: externalRefs },
        { provide: DuplicateMatchService, useValue: { findInvoiceDuplicate: jest.fn() } },
      ],
    }).compile();
    service = moduleRef.get(MigrationService);
  });

  const rec = (id: string, payload: Record<string, unknown>) => ({
    id,
    entityType: "PRODUCT",
    externalId: `ext-${id}`,
    rawPayload: payload,
    flags: [],
    status: "PENDING",
  });

  describe("B334: per-row isolation on confirm", () => {
    it("REG-B334 a failing row in confirmJob is marked SKIPPED with its error and the job still reaches CONFIRMED with an undo deadline", async () => {
      prisma.migrationJob.findUnique.mockResolvedValue({
        id: "j1",
        source: "ZOHO",
        status: "STAGED",
      });
      prisma.migrationStagingRecord.findMany.mockResolvedValue([
        rec("r1", { name: "Cola" }),
        rec("r2", { name: "Cola" }), // the colliding row
        rec("r3", { name: "Chips" }),
      ]);
      products.create
        .mockResolvedValueOnce({ id: "p1" })
        .mockRejectedValueOnce(new ConflictException("Product name already exists"))
        .mockResolvedValueOnce({ id: "p3" });

      const res = await service.confirmJob("j1");

      expect(res.committed).toBe(2);
      expect(res.skipped).toBe(1);
      expect(res.undoDeadline).toBeInstanceOf(Date);
      const updates = prisma.migrationStagingRecord.update.mock.calls.map((c) => c[0]);
      expect(updates.find((u) => u.where.id === "r2")?.data).toMatchObject({
        status: "SKIPPED",
        flags: ["commit-failed"],
      });
      expect(updates.find((u) => u.where.id === "r1")?.data).toMatchObject({ status: "COMMITTED" });
      expect(updates.find((u) => u.where.id === "r3")?.data).toMatchObject({ status: "COMMITTED" });
      expect(prisma.migrationJob.update).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ status: "CONFIRMED", undoDeadline: expect.any(Date) }),
        }),
      );
    });

    it("the skipped row's flag carries a code, never the server's error text", async () => {
      prisma.migrationJob.findUnique.mockResolvedValue({ id: "j1", source: "ZOHO", status: "STAGED" });
      prisma.migrationStagingRecord.findMany.mockResolvedValue([rec("r1", { name: "Cola" })]);
      products.create.mockRejectedValueOnce(new Error('duplicate key value "secret-detail"'));
      await service.confirmJob("j1");
      const data = prisma.migrationStagingRecord.update.mock.calls[0][0].data;
      expect(JSON.stringify(data)).not.toContain("secret-detail");
      expect(data.flags).toEqual(["commit-failed"]);
    });
  });

  describe("B205: thousands-comma prices", () => {
    const stageOne = async (payload: Record<string, unknown>) => {
      prisma.migrationJob.findUnique.mockResolvedValue({ id: "j1", source: "ZOHO", status: "FETCHING" });
      await service.stageRecords("j1", [{ entityType: "PRODUCT", externalId: "e1", payload }]);
      return prisma.migrationStagingRecord.create.mock.calls[0][0].data;
    };

    it.each([
      ["1,234.56", "1234.56"],
      ["$1,234.5", "1234.50"],
      [" 12 ", "12.00"],
      [1234.56, "1234.56"],
    ])("stage normalises price %p to %p", async (price, expected) => {
      const row = await stageOne({ name: "Cola", pricePerUnit: price });
      expect(row.status).toBe("PENDING");
      expect((row.rawPayload as Record<string, unknown>).pricePerUnit).toBe(expected);
    });

    it("stage: a non-numeric or negative price is SKIPPED with flag bad-price, never silently 0", async () => {
      expect(await stageOne({ name: "Cola", pricePerUnit: "abc" })).toMatchObject({
        status: "SKIPPED",
        flags: ["bad-price"],
      });
      prisma.migrationStagingRecord.create.mockClear();
      expect(await stageOne({ name: "Cola", pricePerUnit: "-5" })).toMatchObject({
        status: "SKIPPED",
        flags: ["bad-price"],
      });
    });

    it("stage: an absent price stays PENDING (the product is created at 0 as before)", async () => {
      expect(await stageOne({ name: "Cola" })).toMatchObject({ status: "PENDING" });
    });

    it("confirm: a record staged before this fix with price '1,234.56' reaches products.create as '1234.56'", async () => {
      prisma.migrationJob.findUnique.mockResolvedValue({ id: "j1", source: "ZOHO", status: "STAGED" });
      prisma.migrationStagingRecord.findMany.mockResolvedValue([
        rec("r1", { name: "Cola", price: "1,234.56", unitsPerBox: "1,000" }),
      ]);
      products.create.mockResolvedValue({ id: "p1" });
      await service.confirmJob("j1");
      expect(products.create).toHaveBeenCalledWith(
        expect.objectContaining({ pricePerUnit: "1234.56", unitsPerBox: 1000 }),
      );
    });
  });
});
