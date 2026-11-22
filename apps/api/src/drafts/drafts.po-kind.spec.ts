import { Test, TestingModule } from "@nestjs/testing";
import { BadRequestException, NotFoundException } from "@nestjs/common";
import { plainToInstance } from "class-transformer";
import { validate } from "class-validator";
import { DraftsService } from "./drafts.service";
import { SaveDraftDto } from "./dto/save-draft.dto";
import { PrismaService } from "../prisma/prisma.service";
import { createMockPrisma } from "../testing/prisma-mock";

const user = {
  sub: "user-1",
  username: "maria",
  role: "OPERATOR" as const,
  status: "ACTIVE" as const,
  forcePasswordChange: false,
  tenantId: "tenant-a",
  tenantSlug: "acme",
};

/** What a tenant-scoped read does: only this tenant's own rows come back for an id list. */
const ownRows = (owned: string[]) => async (args: { where: { id: { in: string[] } } }) =>
  args.where.id.in.filter((id) => owned.includes(id)).map((id) => ({ id }));

// SA-1222 PR-A: the PURCHASE_ORDER builder-draft kind. Nothing writes it until PR-B wires the modal.
describe("DraftsService: PURCHASE_ORDER kind (SA-1222 PR-A)", () => {
  let service: DraftsService;
  let prisma: ReturnType<typeof createMockPrisma>;

  beforeEach(async () => {
    prisma = createMockPrisma();
    prisma.supplier.findMany.mockImplementation(ownRows(["sup-a"]));
    prisma.product.findMany.mockImplementation(ownRows(["prod-a"]));
    prisma.customer.findMany.mockImplementation(ownRows(["cust-a"]));
    prisma.saleDraft.create.mockResolvedValue({ id: "d1" });
    prisma.saleDraft.findMany.mockResolvedValue([]);
    prisma.saleDraft.findUnique.mockResolvedValue({ id: "d1", userId: "user-1", payload: {} });
    prisma.saleDraft.update.mockResolvedValue({ id: "d1" });
    const moduleRef: TestingModule = await Test.createTestingModule({
      providers: [DraftsService, { provide: PrismaService, useValue: prisma }],
    }).compile();
    service = moduleRef.get(DraftsService);
  });

  const poPayload = (supplierId: string, productId = "prod-a") => ({
    v: 1,
    supplierId,
    lines: [{ productId, unitsPerBox: 12 }],
  });

  it("R1: the DTO accepts kind PURCHASE_ORDER (and still refuses an unknown kind)", async () => {
    const ok = await validate(plainToInstance(SaveDraftDto, { kind: "PURCHASE_ORDER" }));
    expect(ok.map((e) => e.property)).toEqual([]);
    const bad = await validate(plainToInstance(SaveDraftDto, { kind: "ESTIMATE" }));
    expect(bad.map((e) => e.property)).toEqual(["kind"]);
  });

  it("R2: another tenant's supplier on a PURCHASE_ORDER draft is a 404 and nothing is written", async () => {
    await expect(
      service.create(
        user as never,
        {
          kind: "PURCHASE_ORDER",
          payload: poPayload("sup-other"),
        } as never,
      ),
    ).rejects.toBeInstanceOf(NotFoundException);
    expect(prisma.saleDraft.create).not.toHaveBeenCalled();
  });

  it("R2: another tenant's product line is a 404 at save", async () => {
    await expect(
      service.create(
        user as never,
        {
          kind: "PURCHASE_ORDER",
          payload: poPayload("sup-a", "prod-other"),
        } as never,
      ),
    ).rejects.toBeInstanceOf(NotFoundException);
    expect(prisma.saleDraft.create).not.toHaveBeenCalled();
  });

  it("R2: an own supplier and product saves, and a PATCH of a PO draft is checked the same way", async () => {
    await service.create(
      user as never,
      {
        kind: "PURCHASE_ORDER",
        payload: poPayload("sup-a"),
      } as never,
    );
    expect(prisma.saleDraft.create).toHaveBeenCalledTimes(1);
    prisma.saleDraft.findUnique.mockResolvedValue({
      id: "d1",
      userId: "user-1",
      kind: "PURCHASE_ORDER",
      payload: {},
    });
    await expect(
      service.update(user as never, "d1", { payload: poPayload("sup-other") } as never),
    ).rejects.toBeInstanceOf(NotFoundException);
    expect(prisma.saleDraft.update).not.toHaveBeenCalled();
  });

  it("an ORDER draft's payload is still not read for suppliers (the payload check is PO-only)", async () => {
    await service.create(
      user as never,
      {
        kind: "ORDER",
        payload: { supplierId: "sup-other", lines: [{ productId: "prod-other" }] },
      } as never,
    );
    expect(prisma.saleDraft.create).toHaveBeenCalledTimes(1);
  });

  it("GET /drafts?kind= filters by kind; with no kind the query is unchanged", async () => {
    await service.list(user as never, "PURCHASE_ORDER");
    expect(prisma.saleDraft.findMany.mock.calls[0][0].where).toEqual({
      userId: "user-1",
      kind: "PURCHASE_ORDER",
    });
    prisma.saleDraft.findMany.mockClear();
    await service.list(user as never);
    expect(prisma.saleDraft.findMany.mock.calls[0][0].where).toEqual({ userId: "user-1" });
  });

  it("an unknown ?kind= is a 400", async () => {
    await expect(service.list(user as never, "ESTIMATE")).rejects.toBeInstanceOf(
      BadRequestException,
    );
  });
});
