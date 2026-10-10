import { BadRequestException, ConflictException } from "@nestjs/common";
import { NumberingService } from "./numbering.service";
import { NumberingController } from "./numbering.controller";

// B1188: the Settings "Save Numbering" card changes the invoice prefix through
// PUT /import/numbering/INVOICE. The change is PREVIEWED server-side (the true next number the new
// prefix would mint, from the same max-first scan the mint uses), and the save carries the stored
// nextNumber as its version token so a sequence that moved since the preview is refused.
function build(existing: { prefix: string; nextNumber: number; padding: number } | null) {
  const tx: any = {
    numberingSequence: {
      findUnique: jest.fn().mockResolvedValue(existing),
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      create: jest.fn(),
      findUniqueOrThrow: jest
        .fn()
        .mockResolvedValue({ docType: "INVOICE", ...(existing ?? {}), prefix: "NEW-" }),
    },
    $queryRaw: jest.fn().mockResolvedValue([{ max: 41 }]),
  };
  const prisma: any = {
    getTenantId: jest.fn().mockReturnValue("tenant-a"),
    tenantTransaction: jest.fn((fn: any) => fn(tx)),
  };
  return { svc: new NumberingService(prisma), tx, prisma };
}

describe("NumberingService.updateSettings: stale version token (B1188)", () => {
  it("409s and writes nothing when the sequence moved since the preview", async () => {
    const { svc, tx } = build({ prefix: "INV-", nextNumber: 50, padding: 4 });
    await expect(
      svc.updateSettings("INVOICE", { prefix: "NEW-", expectedNextNumber: 44 }),
    ).rejects.toBeInstanceOf(ConflictException);
    expect(tx.numberingSequence.updateMany).not.toHaveBeenCalled();
    expect(tx.numberingSequence.create).not.toHaveBeenCalled();
  });

  it("400s a save with no version token", async () => {
    const { svc, tx } = build({ prefix: "INV-", nextNumber: 50, padding: 4 });
    await expect(svc.updateSettings("INVOICE", { prefix: "NEW-" })).rejects.toBeInstanceOf(
      BadRequestException,
    );
    expect(tx.numberingSequence.updateMany).not.toHaveBeenCalled();
  });

  it("saves when the token still matches (CAS gated on the token)", async () => {
    const { svc, tx } = build({ prefix: "INV-", nextNumber: 50, padding: 4 });
    await svc.updateSettings("INVOICE", { prefix: "NEW-", expectedNextNumber: 50 });
    expect(tx.numberingSequence.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ tenantId: "tenant-a", nextNumber: 50 }),
        data: { prefix: "NEW-" },
      }),
    );
  });
});

describe("NumberingService.previewPrefix (B1188)", () => {
  it("returns the next number the NEW prefix would mint plus the version token, writing nothing", async () => {
    const { svc, tx } = build({ prefix: "INV-", nextNumber: 7, padding: 4 });
    const out = await svc.previewPrefix("INVOICE", "NEW-");
    // numeric max under NEW- is 41 (mocked scan) -> max-first next is 42, padded.
    expect(out).toEqual({
      docType: "INVOICE",
      prefix: "NEW-",
      preview: "NEW-0042",
      expectedNextNumber: 7,
    });
    expect(tx.numberingSequence.updateMany).not.toHaveBeenCalled();
    expect(tx.numberingSequence.create).not.toHaveBeenCalled();
  });

  it("uses the unsaved-row token 1 when the tenant never saved a sequence", async () => {
    const { svc } = build(null);
    const out = await svc.previewPrefix("INVOICE", "NEW-");
    expect(out.expectedNextNumber).toBe(1);
    expect(out.preview).toBe("NEW-0042");
  });

  it("refuses a trailing-digit prefix (shared validator) before scanning anything", async () => {
    const { svc, tx } = build({ prefix: "INV-", nextNumber: 7, padding: 4 });
    await expect(svc.previewPrefix("INVOICE", "INV2")).rejects.toBeInstanceOf(BadRequestException);
    expect(tx.$queryRaw).not.toHaveBeenCalled();
  });

  it("is tenant-scoped: scans through the tenant transaction with the JWT tenant", async () => {
    const { svc, prisma, tx } = build({ prefix: "INV-", nextNumber: 7, padding: 4 });
    await svc.previewPrefix("INVOICE", "NEW-");
    expect(prisma.tenantTransaction).toHaveBeenCalled();
    expect(tx.numberingSequence.findUnique).toHaveBeenCalledWith({
      where: { tenantId_docType_year: { tenantId: "tenant-a", docType: "INVOICE", year: 0 } },
    });
  });
});

describe("NumberingController GET :docType/preview (B1188)", () => {
  it("delegates with the parsed doc type and the prefix query", async () => {
    const numbering = { previewPrefix: jest.fn().mockResolvedValue({ ok: true }) };
    const ctrl = new NumberingController(numbering as any);
    await ctrl.previewPrefix("invoice", "NEW-");
    expect(numbering.previewPrefix).toHaveBeenCalledWith("INVOICE", "NEW-");
  });

  it("400s an unknown doc type", () => {
    const ctrl = new NumberingController({ previewPrefix: jest.fn() } as any);
    expect(() => ctrl.previewPrefix("PAYMENT", "X-")).toThrow(BadRequestException);
  });
});
