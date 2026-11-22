import { Test, TestingModule } from "@nestjs/testing";
import { ConflictException } from "@nestjs/common";
import { Prisma } from "@prisma/client";
import { InventoryService } from "./inventory.service";
import { PrismaService } from "../prisma/prisma.service";
import { IdempotencyService } from "../common/idempotency.service";
import { API_ERROR_CODES } from "../common/api-error-codes";
import { createMockPrisma } from "../testing/prisma-mock";
import { StockAlertService } from "../stock-alerts/stock-alert.service";

/**
 * SA-1222 PR-A: the PO create is one transaction (number, PO and lines), replays an Idempotency-Key, retries a
 * P2002 number clash once, and consumes the builder draft it was made from. The fake idempotency store is
 * stateful so a replay really finds what the first call saved.
 */
function fakeIdempotency() {
  const store = new Map<string, unknown>();
  const hashFor = (key: string, tenantId: string | null, scope: string) =>
    `${tenantId}:${scope}:${key}`;
  return {
    hashFor,
    acquireLock: jest.fn().mockResolvedValue(undefined),
    check: jest.fn(async (key: string, tenantId: string | null, scope: string) =>
      store.has(hashFor(key, tenantId, scope)) ? store.get(hashFor(key, tenantId, scope)) : null,
    ),
    save: jest.fn(
      async (key: string, tenantId: string | null, scope: string, response: unknown) => {
        store.set(hashFor(key, tenantId, scope), JSON.parse(JSON.stringify(response)));
      },
    ),
  };
}

describe("InventoryService.createPurchaseOrder: key, draft and number race (SA-1222)", () => {
  let service: InventoryService;
  let prisma: ReturnType<typeof createMockPrisma>;
  let idem: ReturnType<typeof fakeIdempotency>;
  let seq: number;
  let liveDrafts: Set<string>;
  const year = new Date().getFullYear();

  beforeEach(async () => {
    prisma = createMockPrisma();
    idem = fakeIdempotency();
    seq = 0;
    liveDrafts = new Set(["draft-1", "draft-2"]);
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        InventoryService,
        { provide: PrismaService, useValue: prisma },
        { provide: IdempotencyService, useValue: idem },
        { provide: StockAlertService, useValue: { fireForProducts: jest.fn() } },
      ],
    }).compile();
    service = module.get(InventoryService);
    prisma.supplier.findUnique.mockResolvedValue({ id: "sup-1", name: "Acme Supply" });
    prisma.product.findMany.mockResolvedValue([{ id: "prod-1" }]);
    prisma.purchaseOrder.findFirst.mockResolvedValue(null);
    prisma.purchaseOrder.create.mockImplementation(async (a: any) => {
      seq += 1;
      return { id: `po-${seq}`, poNumber: a.data.poNumber, items: [] };
    });
    prisma.purchaseOrder.findUnique.mockImplementation(async (a: any) => ({
      id: a.where.id,
      poNumber: `PO-${year}-000${a.where.id.split("-")[1]}`,
      items: [],
    }));
    // The draft table: deleteMany by id removes it once; a second delete finds nothing.
    prisma.saleDraft.deleteMany.mockImplementation(async (a: any) => {
      const id = a.where.id as string;
      const had = liveDrafts.delete(id);
      return { count: had ? 1 : 0 };
    });
  });

  const body = (extra: Record<string, unknown> = {}) => ({
    supplierId: "sup-1",
    items: [{ productId: "prod-1", qty: 2, unitCost: 1.5 }],
    ...extra,
  });

  it("R7: two creates with the same Idempotency-Key make one PO and return the same id", async () => {
    const a = await service.createPurchaseOrder(body() as never, "u1", "key-1");
    const b = await service.createPurchaseOrder(body() as never, "u1", "key-1");
    expect(prisma.purchaseOrder.create).toHaveBeenCalledTimes(1);
    expect(b.id).toBe(a.id);
  });

  it("R8: the same key with a NEW draftId (the mirror re-created it) returns the same PO, makes none, and cleans the draft", async () => {
    const a = await service.createPurchaseOrder(
      body({ draftId: "draft-1" }) as never,
      "u1",
      "key-1",
    );
    const b = await service.createPurchaseOrder(
      body({ draftId: "draft-2" }) as never,
      "u1",
      "key-1",
    );
    expect(prisma.purchaseOrder.create).toHaveBeenCalledTimes(1);
    expect(b.id).toBe(a.id);
    expect(liveDrafts.has("draft-2")).toBe(false);
  });

  it("the same key with a DIFFERENT body is a 409 IDEMPOTENCY_KEY_CONFLICT and no second PO", async () => {
    await service.createPurchaseOrder(body() as never, "u1", "key-1");
    const other = body({ items: [{ productId: "prod-1", qty: 9, unitCost: 1.5 }] });
    await expect(service.createPurchaseOrder(other as never, "u1", "key-1")).rejects.toMatchObject({
      response: { code: "IDEMPOTENCY_KEY_CONFLICT" },
    });
    expect(prisma.purchaseOrder.create).toHaveBeenCalledTimes(1);
  });

  it("R9: two tabs submit one draftId with different keys: the second is 409 PO_DRAFT_GONE and writes no PO", async () => {
    const first = await service.createPurchaseOrder(
      body({ draftId: "draft-1" }) as never,
      "u1",
      "key-A",
    );
    expect(first.id).toBe("po-1");
    const second = service.createPurchaseOrder(
      body({ draftId: "draft-1" }) as never,
      "u1",
      "key-B",
    );
    await expect(second).rejects.toBeInstanceOf(ConflictException);
    await expect(second).rejects.toMatchObject({
      response: { code: API_ERROR_CODES.PO_DRAFT_GONE },
    });
    expect(prisma.purchaseOrder.create).toHaveBeenCalledTimes(1);
  });

  it("the draft is consumed for this user and kind only, inside the transaction", async () => {
    await service.createPurchaseOrder(body({ draftId: "draft-1" }) as never, "u1", "key-1");
    expect(prisma.saleDraft.deleteMany).toHaveBeenCalledWith({
      where: { id: "draft-1", userId: "u1", kind: "PURCHASE_ORDER" },
    });
    expect(prisma.tenantTransaction).toHaveBeenCalled();
  });

  it("R10: a P2002 on the PO number retries once with a fresh number: both creates succeed", async () => {
    let clashed = false;
    prisma.purchaseOrder.create.mockImplementation(async (a: any) => {
      if (!clashed) {
        clashed = true;
        throw new Prisma.PrismaClientKnownRequestError("dup", {
          code: "P2002",
          clientVersion: "x",
          meta: { target: ["tenantId", "poNumber"] },
        });
      }
      seq += 1;
      return { id: `po-${seq}`, poNumber: a.data.poNumber, items: [] };
    });
    const po = await service.createPurchaseOrder(body() as never, "u1");
    expect(po.id).toBe("po-1");
    expect(prisma.purchaseOrder.create).toHaveBeenCalledTimes(2);
  });

  it("a second P2002 is not swallowed", async () => {
    prisma.purchaseOrder.create.mockRejectedValue(
      new Prisma.PrismaClientKnownRequestError("dup", { code: "P2002", clientVersion: "x" }),
    );
    await expect(service.createPurchaseOrder(body() as never, "u1")).rejects.toMatchObject({
      code: "P2002",
    });
    expect(prisma.purchaseOrder.create).toHaveBeenCalledTimes(2);
  });

  it("with no key and no draftId the create is the plain one: no idempotency row, no draft delete", async () => {
    await service.createPurchaseOrder(body() as never, "u1");
    expect(idem.check).not.toHaveBeenCalled();
    expect(idem.save).not.toHaveBeenCalled();
    expect(prisma.saleDraft.deleteMany).not.toHaveBeenCalled();
    expect(prisma.purchaseOrder.create).toHaveBeenCalledTimes(1);
  });

  it("money is unchanged: the line total is still rounded server-side", async () => {
    await service.createPurchaseOrder(
      { supplierId: "sup-1", items: [{ productId: "prod-1", qty: 3, unitCost: 0.335 }] } as never,
      "u1",
      "key-1",
    );
    const data = prisma.purchaseOrder.create.mock.calls[0][0].data;
    expect(data.totalAmount).toBe(1.01);
  });
});
