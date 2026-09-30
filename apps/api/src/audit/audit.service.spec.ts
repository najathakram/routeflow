import { Test } from "@nestjs/testing";
import { AuditService } from "./audit.service";
import { PrismaService } from "../prisma/prisma.service";
import { createMockPrisma } from "../testing/prisma-mock";

describe("AuditService.log (B165)", () => {
  let service: AuditService;
  let prisma: ReturnType<typeof createMockPrisma>;

  beforeEach(async () => {
    prisma = createMockPrisma();
    const mod = await Test.createTestingModule({
      providers: [AuditService, { provide: PrismaService, useValue: prisma }],
    }).compile();
    service = mod.get(AuditService);
  });

  it("REG-B165 writes impersonatedBy into the AuditLog row", async () => {
    await service.log({
      tenantId: "t1",
      userId: "ta1",
      action: "POST /orders",
      entityType: "orders",
      impersonatedBy: "sa1",
    } as any);
    expect(prisma.auditLog.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ impersonatedBy: "sa1" }) }),
    );
  });

  it("REG-B165 writes impersonatedBy: null when the request was not impersonated", async () => {
    await service.log({
      tenantId: "t1",
      userId: "u1",
      action: "POST /orders",
      entityType: "orders",
    });
    const data = prisma.auditLog.create.mock.calls[0]![0].data;
    expect(data).toHaveProperty("impersonatedBy", null);
  });

  it("pin (B165): a failing create never rejects (audit must not fail the request)", async () => {
    prisma.auditLog.create.mockRejectedValue(new Error("column missing"));
    await expect(
      service.log({ tenantId: "t1", userId: "u1", action: "POST /x", entityType: "x" }),
    ).resolves.toBeUndefined();
  });

  // B212-class fix: the catch used to be entirely silent (no logger call at
  // all), so a real DB failure on the audit trail — the exact record
  // impersonation accountability (B138/B165) relies on — was indistinguishable
  // from "no action happened". Still never rethrows.
  it("logs a failing write instead of swallowing it silently", async () => {
    prisma.auditLog.create.mockRejectedValue(new Error("column missing"));
    const loggerErrorSpy = jest.spyOn((service as any).logger, "error");

    await service.log({
      tenantId: "t1",
      userId: "u1",
      action: "POST /orders",
      entityType: "orders",
    });

    expect(loggerErrorSpy).toHaveBeenCalledWith(
      expect.stringContaining("Failed to write audit log"),
    );
  });
});
