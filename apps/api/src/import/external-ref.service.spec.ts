import { Test } from "@nestjs/testing";
import { PrismaService } from "../prisma/prisma.service";
import { createMockPrisma } from "../testing/prisma-mock";
import { ExternalRefService } from "./external-ref.service";

describe("ExternalRefService", () => {
  let service: ExternalRefService;
  let prisma: ReturnType<typeof createMockPrisma>;

  beforeEach(async () => {
    prisma = createMockPrisma();
    const moduleRef = await Test.createTestingModule({
      providers: [ExternalRefService, { provide: PrismaService, useValue: prisma }],
    }).compile();
    service = moduleRef.get(ExternalRefService);
  });

  describe("parse", () => {
    it("splits a combined ref on the first colon", () => {
      expect(service.parse("zoho:inv_884412")).toEqual({
        source: "zoho",
        externalId: "inv_884412",
      });
    });
    it("keeps colons inside the id", () => {
      expect(service.parse("qb:a:b")).toEqual({ source: "qb", externalId: "a:b" });
    });
    it("returns null when there is no source or no id", () => {
      expect(service.parse("nocolon")).toBeNull();
      expect(service.parse(":x")).toBeNull();
      expect(service.parse("x:")).toBeNull();
    });
  });

  describe("record", () => {
    it("upserts by the tenant-scoped external-id key (idempotent)", async () => {
      await service.record("INVOICE", "local-1", "zoho", "inv_884412");
      expect(prisma.importExternalRef.upsert).toHaveBeenCalledWith(
        expect.objectContaining({
          where: {
            tenantId_externalSource_externalId_entityType: {
              tenantId: "test-tenant",
              externalSource: "zoho",
              externalId: "inv_884412",
              entityType: "INVOICE",
            },
          },
          create: expect.objectContaining({ entityId: "local-1" }),
          update: { entityId: "local-1" },
        }),
      );
    });
  });

  describe("findLocalId", () => {
    it("returns the mapped local id", async () => {
      prisma.importExternalRef.findUnique.mockResolvedValue({ entityId: "local-9" });
      await expect(service.findLocalId("PRODUCT", "zoho", "item_5")).resolves.toBe("local-9");
    });
    it("returns null when unmapped", async () => {
      prisma.importExternalRef.findUnique.mockResolvedValue(null);
      await expect(service.findLocalId("PRODUCT", "zoho", "item_5")).resolves.toBeNull();
    });
  });
});
