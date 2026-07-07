import { Test } from "@nestjs/testing";
import { BadRequestException, ConflictException } from "@nestjs/common";
import { PrismaService } from "../prisma/prisma.service";
import { createMockPrisma } from "../testing/prisma-mock";
import { ProductsService } from "../products/products.service";
import { ExternalRefService } from "./external-ref.service";
import { DuplicateMatchService } from "./duplicate-match.service";
import { MigrationService } from "./migration.service";

describe("MigrationService", () => {
  let service: MigrationService;
  let prisma: ReturnType<typeof createMockPrisma>;
  let products: { create: jest.Mock };
  let externalRefs: { findLocalId: jest.Mock; record: jest.Mock };
  let dupMatch: { findInvoiceDuplicate: jest.Mock };

  beforeEach(async () => {
    prisma = createMockPrisma();
    products = { create: jest.fn().mockResolvedValue({ id: "p1" }) };
    externalRefs = {
      findLocalId: jest.fn().mockResolvedValue(null),
      record: jest.fn().mockResolvedValue(undefined),
    };
    dupMatch = { findInvoiceDuplicate: jest.fn().mockResolvedValue(null) };
    const moduleRef = await Test.createTestingModule({
      providers: [
        MigrationService,
        { provide: PrismaService, useValue: prisma },
        { provide: ProductsService, useValue: products },
        { provide: ExternalRefService, useValue: externalRefs },
        { provide: DuplicateMatchService, useValue: dupMatch },
      ],
    }).compile();
    service = moduleRef.get(MigrationService);
  });

  describe("stageRecords", () => {
    it("flags an invoice that the secondary match finds, keeps a product pending", async () => {
      prisma.migrationJob.findUnique.mockResolvedValue({
        id: "j1",
        source: "ZOHO",
        status: "FETCHING",
      });
      dupMatch.findInvoiceDuplicate.mockResolvedValue({
        id: "existing-inv",
        invoiceNumber: "INV-1",
      });
      await service.stageRecords("j1", [
        { entityType: "PRODUCT", externalId: "item_1", payload: { name: "X" } },
        {
          entityType: "INVOICE",
          externalId: "inv_1",
          payload: { number: "INV-1", total: 100, issueDate: "2026-07-01" },
        },
      ]);
      const created = prisma.migrationStagingRecord.create.mock.calls.map((c) => c[0].data);
      expect(created[0]).toMatchObject({ entityType: "PRODUCT", status: "PENDING" });
      expect(created[1]).toMatchObject({
        entityType: "INVOICE",
        status: "DUPLICATE",
        matchedEntityId: "existing-inv",
        flags: ["duplicate"],
      });
      expect(prisma.migrationJob.update).toHaveBeenCalledWith(
        expect.objectContaining({ data: expect.objectContaining({ status: "STAGED" }) }),
      );
    });
  });

  describe("confirmJob", () => {
    it("commits a product, records its external ref, and opens a 24h undo window", async () => {
      prisma.migrationJob.findUnique.mockResolvedValue({
        id: "j1",
        source: "ZOHO",
        status: "STAGED",
      });
      prisma.migrationStagingRecord.findMany.mockResolvedValue([
        {
          id: "r1",
          entityType: "PRODUCT",
          externalId: "item_1",
          rawPayload: { name: "X", pricePerUnit: "5.00" },
          flags: [],
        },
      ]);
      const res = await service.confirmJob("j1");
      expect(products.create).toHaveBeenCalledWith(expect.objectContaining({ name: "X" }));
      expect(externalRefs.record).toHaveBeenCalledWith("PRODUCT", "p1", "zoho", "item_1");
      expect(prisma.migrationStagingRecord.update).toHaveBeenCalledWith(
        expect.objectContaining({ data: { status: "COMMITTED", createdEntityId: "p1" } }),
      );
      expect(prisma.migrationJob.update).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ status: "CONFIRMED", undoDeadline: expect.any(Date) }),
        }),
      );
      expect(res.committed).toBe(1);
    });

    it("rejects a second confirm", async () => {
      prisma.migrationJob.findUnique.mockResolvedValue({
        id: "j1",
        source: "ZOHO",
        status: "CONFIRMED",
      });
      await expect(service.confirmJob("j1")).rejects.toBeInstanceOf(ConflictException);
    });
  });

  describe("undoJob", () => {
    it("deletes exactly the rows it created and marks the job undone", async () => {
      prisma.migrationJob.findUnique.mockResolvedValue({
        id: "j1",
        source: "ZOHO",
        status: "CONFIRMED",
        undoDeadline: new Date("2999-01-01"),
      });
      prisma.migrationStagingRecord.findMany.mockResolvedValue([
        { id: "r1", entityType: "PRODUCT", createdEntityId: "p1" },
      ]);
      const res = await service.undoJob("j1");
      expect(prisma.product.delete).toHaveBeenCalledWith({ where: { id: "p1" } });
      expect(prisma.importExternalRef.deleteMany).toHaveBeenCalledWith({
        where: { entityType: "PRODUCT", entityId: "p1" },
      });
      expect(prisma.migrationJob.update).toHaveBeenCalledWith(
        expect.objectContaining({ data: expect.objectContaining({ status: "UNDONE" }) }),
      );
      expect(res.reversed).toBe(1);
    });

    it("refuses once the 24h window has passed", async () => {
      prisma.migrationJob.findUnique.mockResolvedValue({
        id: "j1",
        source: "ZOHO",
        status: "CONFIRMED",
        undoDeadline: new Date("2000-01-01"),
      });
      await expect(service.undoJob("j1")).rejects.toBeInstanceOf(BadRequestException);
    });

    it("refuses to undo a job that was never confirmed", async () => {
      prisma.migrationJob.findUnique.mockResolvedValue({
        id: "j1",
        source: "ZOHO",
        status: "STAGED",
      });
      await expect(service.undoJob("j1")).rejects.toBeInstanceOf(BadRequestException);
    });
  });
});
