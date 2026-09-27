/**
 * The operator RESOLUTION of a parked STANDARD-return restock (B665 follow-up). receive() parked the item
 * because the sold line's pack was unknown (no stock booked). The operator supplies only the PACK; the restock
 * is the stored returnedQty x pack, booked through the same writer as receive(), and cancel() undoes it.
 */
import {
  BadRequestException,
  ExecutionContext,
  NotFoundException,
  ValidationPipe,
} from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import { Test } from "@nestjs/testing";
import { Prisma, UserRole } from "@prisma/client";
import { ParkedRestockResolutionService } from "./parked-restock-resolution.service";
import { ReturnsService } from "./returns.service";
import { ReturnsController } from "./returns.controller";
import { restockReturnItems } from "./returns-restock.util";
import { ResolveParkedRestockDto } from "./dto/resolve-parked-restock.dto";
import { PrismaService } from "../prisma/prisma.service";
import { AuditService } from "../audit/audit.service";
import { RouteFlowGateway } from "../gateways/routeflow.gateway";
import { RegulatedLedgerService } from "../regulated/regulated-ledger.service";
import { CreditNotesService } from "../credit-notes/credit-notes.service";
import { NumberingService } from "../import/numbering.service";
import { RolesGuard } from "../auth/guards/roles.guard";
import { REQUIRE_ADDON_KEY } from "../billing/require-addon.decorator";
import { createMockPrisma } from "../testing/prisma-mock";

const RETURN_ID = "ret-12345678-abcd";
const parked = (over: Record<string, unknown> = {}) => ({
  id: "pr-1",
  tenantId: "t1",
  returnId: RETURN_ID,
  returnItemId: "ri-1",
  productId: "p1",
  returnedQty: new Prisma.Decimal(3), // 3 BOXES, as typed
  reason: "no own split and no same-product source line with a split",
  createdAt: new Date("2026-09-01T00:00:00Z"),
  resolvedAt: null as Date | null,
  resolvedById: null as string | null,
  unitsPerBoxSupplied: null as number | null,
  resolvedMovementId: null as string | null,
  ...over,
});

describe("ParkedRestockResolutionService", () => {
  let service: ParkedRestockResolutionService;
  let prisma: ReturnType<typeof createMockPrisma>;
  let audit: { log: jest.Mock };
  let table: ReturnType<typeof parked>[];
  const actor = { id: "u-op" };

  beforeEach(async () => {
    prisma = createMockPrisma();
    audit = { log: jest.fn().mockResolvedValue(undefined) };
    table = [parked()];
    const model: any = (prisma as any).returnParkedRestock;
    model.findFirst = jest.fn(
      async ({ where }: any) => table.find((r) => r.id === where.id) ?? null,
    );
    model.updateMany = jest.fn(async ({ where, data }: any) => {
      const hit = table.filter(
        (r) => r.id === where.id && (where.resolvedAt === null ? r.resolvedAt === null : true),
      );
      hit.forEach((r) => Object.assign(r, data));
      return { count: hit.length };
    });
    model.findMany = jest.fn(async () => table.filter((r) => r.resolvedAt === null));
    prisma.product.findFirst.mockResolvedValue({
      currentStock: new Prisma.Decimal(100),
      averageCost: new Prisma.Decimal(2),
    } as any);
    // The resolve path re-reads the return's status inside the transaction (a CANCELLED return is refused).
    prisma.return.findFirst.mockResolvedValue({ status: "RECEIVED" } as any);
    prisma.stockMovement.create.mockImplementation(async (a: any) => ({ id: "mv-1", ...a.data }));
    const mod = await Test.createTestingModule({
      providers: [
        ParkedRestockResolutionService,
        { provide: PrismaService, useValue: prisma },
        { provide: AuditService, useValue: audit },
      ],
    }).compile();
    service = mod.get(ParkedRestockResolutionService);
  });

  const movement = () => prisma.stockMovement.create.mock.calls[0]?.[0].data;

  it("#2108: a tenant-less caller (SUPER_ADMIN) is refused before any claim or audit", async () => {
    (prisma as any).getTenantId = jest.fn().mockReturnValue(null);
    await expect(service.resolve("pr-1", 12, actor)).rejects.toThrow("tenant-scoped");
    expect((prisma as any).returnParkedRestock.updateMany).not.toHaveBeenCalled();
    expect(audit.log).not.toHaveBeenCalled();
    expect(() => service.list()).toThrow("tenant-scoped");
  });

  it("books EXACTLY the stored qty x the pack: 3 boxes at pack 12 = +36 PIECES, on the RET-<id> reference", async () => {
    const res = await service.resolve("pr-1", 12, actor);
    expect(Number(movement().quantity)).toBe(36);
    expect(movement()).toMatchObject({
      productId: "p1",
      type: "RETURN",
      reference: "RET-ret-1234",
      performedById: "u-op",
    });
    expect(Number(movement().stockAfter)).toBe(136);
    const inc = prisma.product.update.mock.calls[0][0];
    expect(inc.where).toEqual({ id: "p1" });
    expect(Number(inc.data.currentStock.increment)).toBe(36);
    expect(res).toEqual({ alreadyResolved: false, resolvedMovementId: "mv-1" });
  });

  it("stamps resolvedAt / resolvedById / unitsPerBoxSupplied on a CONDITIONAL claim, and resolvedMovementId", async () => {
    await service.resolve("pr-1", 12, actor);
    const model: any = (prisma as any).returnParkedRestock;
    expect(model.updateMany.mock.calls[0][0]).toMatchObject({
      where: { id: "pr-1", resolvedAt: null },
      data: { resolvedById: "u-op", unitsPerBoxSupplied: 12 },
    });
    expect(table[0].resolvedAt).toBeInstanceOf(Date);
    expect(table[0].resolvedMovementId).toBe("mv-1");
  });

  it("a SECOND resolve is a no-op: no movement, no stock change, the first answer stands, no second audit", async () => {
    await service.resolve("pr-1", 12, actor);
    prisma.stockMovement.create.mockClear();
    prisma.product.update.mockClear();
    audit.log.mockClear();
    const again = await service.resolve("pr-1", 6, { id: "u-other" });
    expect(again).toMatchObject({ alreadyResolved: true, resolvedMovementId: "mv-1" });
    expect(prisma.stockMovement.create).not.toHaveBeenCalled();
    expect(prisma.product.update).not.toHaveBeenCalled();
    expect(table[0]).toMatchObject({ resolvedById: "u-op", unitsPerBoxSupplied: 12 });
    expect(audit.log).not.toHaveBeenCalled();
  });

  it("a concurrent resolve that loses the claim (count 0) books nothing", async () => {
    (prisma as any).returnParkedRestock.updateMany.mockResolvedValueOnce({ count: 0 });
    const res = await service.resolve("pr-1", 12, actor);
    expect(res.alreadyResolved).toBe(true);
    expect(prisma.stockMovement.create).not.toHaveBeenCalled();
  });

  it("404s a row the tenant cannot see (another tenant's, or voided by a cancelled return), booking nothing", async () => {
    table = [];
    await expect(service.resolve("pr-1", 12, actor)).rejects.toBeInstanceOf(NotFoundException);
    expect(prisma.stockMovement.create).not.toHaveBeenCalled();
    expect(audit.log).not.toHaveBeenCalled();
  });

  it("refuses a CANCELLED return and books NOTHING, rolling the claim back so the row stays parked", async () => {
    // A cancelled return's goods were never kept: restocking them would inflate stock with no offsetting
    // movement, and cancel() cannot undo a movement booked after it ran.
    prisma.return.findFirst.mockResolvedValue({ status: "CANCELLED" } as any);
    await expect(service.resolve("pr-1", 12, actor)).rejects.toBeInstanceOf(NotFoundException);
    expect(prisma.stockMovement.create).not.toHaveBeenCalled();
    expect(prisma.product.update).not.toHaveBeenCalled();
    expect(audit.log).not.toHaveBeenCalled();
  });

  it("makes the CANCELLED check INSIDE the transaction and AFTER the claim, so the claim's row lock serialises against cancel()", async () => {
    // The claim's UPDATE and cancel()'s DELETE of unresolved parked rows contend for the same row: claiming
    // first is what makes "cancel committed already" show up as a 0-count claim rather than a booking.
    const order: string[] = [];
    const model: any = (prisma as any).returnParkedRestock;
    const claim = model.updateMany;
    model.updateMany = jest.fn(async (a: any) => {
      if (a.where?.resolvedAt === null) order.push("claim");
      return claim(a);
    });
    prisma.return.findFirst.mockImplementation(async () => {
      order.push("status-read");
      return { status: "RECEIVED" } as any;
    });
    prisma.stockMovement.create.mockImplementation(async (a: any) => {
      order.push("book");
      return { id: "mv-1", ...a.data };
    });
    await service.resolve("pr-1", 12, actor);
    expect(order).toEqual(["claim", "status-read", "book"]);
  });

  it("refuses when the return row is GONE, booking nothing", async () => {
    prisma.return.findFirst.mockResolvedValue(null as any);
    await expect(service.resolve("pr-1", 12, actor)).rejects.toBeInstanceOf(NotFoundException);
    expect(prisma.stockMovement.create).not.toHaveBeenCalled();
  });

  it("a factor-1 parked row RESOLVES: 3 stays 3 pieces, booked and stamped like any other (owner ruling 2026-09-22)", async () => {
    // Reachable: a box-unaware line carrying a pack snapshot but NO split, on an uninvoiced order, has no
    // InvoiceItem source, so it parks even though its qty is already a piece count. The true pack is 1.
    // Before this ruling @Min(2) made such a row permanently unresolvable — a 100% undercount.
    const res = await service.resolve("pr-1", 1, actor);
    expect(Number(movement().quantity)).toBe(3);
    expect(Number(prisma.product.update.mock.calls[0][0].data.currentStock.increment)).toBe(3);
    expect(res).toEqual({ alreadyResolved: false, resolvedMovementId: "mv-1" });
    expect(table[0].unitsPerBoxSupplied).toBe(1);
    expect(audit.log).toHaveBeenCalledWith(
      expect.objectContaining({
        meta: expect.objectContaining({ unitsPerBoxSupplied: 1, pieces: 3 }),
      }),
    );
  });

  it("the pack lives ONLY on the parked row: nothing is written to a line, invoice line or the product's pack", async () => {
    await service.resolve("pr-1", 12, actor);
    for (const model of ["orderItem", "invoiceItem"] as const) {
      for (const verb of ["update", "updateMany", "create", "createMany", "upsert"]) {
        expect((prisma as any)[model][verb]).not.toHaveBeenCalled();
      }
    }
    // the ONLY product write is the stock increment
    expect(Object.keys(prisma.product.update.mock.calls[0][0].data)).toEqual(["currentStock"]);
  });

  it("audits the actor, the supplied pack and the pieces booked", async () => {
    await service.resolve("pr-1", 12, actor);
    expect(audit.log).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: "u-op",
        action: "return_restock.parked_resolved",
        entityType: "ReturnParkedRestock",
        entityId: "pr-1",
        meta: expect.objectContaining({
          returnId: RETURN_ID,
          productId: "p1",
          returnedQty: 3,
          unitsPerBoxSupplied: 12,
          pieces: 36,
          resolvedMovementId: "mv-1",
        }),
      }),
    );
  });

  it("uses the SAME writer as receive(): the movement equals the one receive() books for the same pieces", async () => {
    await service.resolve("pr-1", 12, actor);
    const resolved = movement();
    prisma.stockMovement.create.mockClear();
    await restockReturnItems(
      prisma as any,
      { id: RETURN_ID, items: [{ id: "ri-1", productId: "p1", qty: 3, restock: true }] },
      "u-op",
      async () => ({ pieces: 36 }),
    );
    const viaReceive = movement();
    const pick = (m: any) => ({
      productId: m.productId,
      type: m.type,
      quantity: Number(m.quantity),
      unitCost: Number(m.unitCost),
      stockAfter: Number(m.stockAfter),
      reference: m.reference,
      performedById: m.performedById,
    });
    expect(pick(resolved)).toEqual(pick(viaReceive));
  });

  it("lists the tenant's unresolved parked restocks, oldest first", async () => {
    const rows = await service.list();
    expect(rows).toHaveLength(1);
    expect((prisma as any).returnParkedRestock.findMany.mock.calls[0][0]).toEqual({
      where: { resolvedAt: null },
      orderBy: { createdAt: "asc" },
    });
  });
});

describe("cancel() undoes a RESOLVED restock exactly (36 pieces, not the typed 3)", () => {
  it("sums the resolver's RET-<id> movement and decrements it", async () => {
    const prisma = createMockPrisma();
    const mod = await Test.createTestingModule({
      providers: [
        ReturnsService,
        { provide: PrismaService, useValue: prisma },
        { provide: RouteFlowGateway, useValue: { emitReturnCreated: jest.fn() } },
        {
          provide: RegulatedLedgerService,
          useValue: { reverseReturnEntries: jest.fn(), unreverseReturnEntries: jest.fn() },
        },
        { provide: CreditNotesService, useValue: { create: jest.fn() } },
        { provide: NumberingService, useValue: { reserveNext: jest.fn() } },
      ],
    }).compile();
    const returns = mod.get(ReturnsService);
    // book the resolved restock, then hand cancel() exactly what the writer created
    const table = [parked()];
    const model: any = (prisma as any).returnParkedRestock;
    model.findFirst = jest.fn(async () => table[0]);
    model.updateMany = jest.fn(
      async ({ data }: any) => Object.assign(table[0], data) && { count: 1 },
    );
    prisma.product.findFirst.mockResolvedValue({
      currentStock: new Prisma.Decimal(0),
      averageCost: null,
    } as any);
    // resolve() re-reads the return's status inside its transaction; this return is live, not cancelled.
    prisma.return.findFirst.mockResolvedValue({ status: "RECEIVED" } as any);
    prisma.stockMovement.create.mockImplementation(async (a: any) => ({ id: "mv-1", ...a.data }));
    const resolver = new ParkedRestockResolutionService(prisma as any, { log: jest.fn() } as any);
    await resolver.resolve("pr-1", 12, { id: "u-op" });
    const booked = prisma.stockMovement.create.mock.calls[0][0].data;

    // cancel() must VOID the parked rows before it scans the movements — that order is what makes a
    // concurrent resolve() either lose its claim or have its movement seen and undone (see cancel()'s
    // comment). Scanning first would leave an orphan RET-<id> movement and permanently inflated stock.
    const order: string[] = [];
    const tx = {
      return: {
        findUnique: jest.fn().mockResolvedValue({
          id: RETURN_ID,
          status: "RECEIVED",
          items: [{ id: "ri-1", productId: "p1", qty: 3, restock: true }],
        }),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
      // B562 PR-2: update() returns the written row — the reversing movement reads its counter.
      product: { update: jest.fn().mockResolvedValue({ currentStock: 0, averageCost: null }) },
      stockMovement: {
        findMany: jest.fn(() => {
          order.push("scan-movements");
          return Promise.resolve([{ productId: booked.productId, quantity: booked.quantity }]);
        }),
        deleteMany: jest.fn(),
        create: jest.fn().mockResolvedValue({ id: "mv-rev" }),
      },
      returnParkedRestock: { deleteMany: jest.fn(() => order.push("void-parked")) },
      $executeRaw: jest.fn().mockResolvedValue(0),
    };
    prisma.tenantTransaction.mockImplementation((fn: any) => fn(tx));
    prisma.return.findUnique.mockResolvedValue({
      id: RETURN_ID,
      status: "APPROVED",
      customerId: "c1",
      items: [{ id: "ri-1", productId: "p1", qty: 3, restock: true }],
    });
    await returns.cancel(RETURN_ID, { sub: "u1", role: "OPERATOR" } as any);
    expect(order).toEqual(["void-parked", "scan-movements"]);
    expect(tx.stockMovement.findMany).toHaveBeenCalledWith({
      where: { reference: booked.reference, type: booked.type },
      select: { productId: true, quantity: true },
    });
    expect(tx.product.update).toHaveBeenCalledWith({
      where: { id: "p1" },
      data: { currentStock: { decrement: 36 } },
    });
  });
});

describe("parked restock endpoints: roles, no addon, and the body", () => {
  const reflector = new Reflector();
  const guard = new RolesGuard(reflector);
  const proto = ReturnsController.prototype;
  const ctx = (handler: any, role?: UserRole): ExecutionContext =>
    ({
      getHandler: () => handler,
      getClass: () => ReturnsController,
      switchToHttp: () => ({ getRequest: () => ({ user: role ? { role } : undefined }) }),
    }) as unknown as ExecutionContext;

  it("OPERATOR and TENANT_ADMIN may resolve; DRIVER, CUSTOMER and anonymous are refused (403)", () => {
    for (const role of [UserRole.OPERATOR, UserRole.TENANT_ADMIN]) {
      expect(guard.canActivate(ctx(proto.resolveParkedRestock, role))).toBe(true);
    }
    for (const role of [UserRole.DRIVER, UserRole.CUSTOMER, undefined]) {
      expect(guard.canActivate(ctx(proto.resolveParkedRestock, role))).toBe(false);
      expect(guard.canActivate(ctx(proto.listParkedRestocks, role))).toBe(false);
    }
  });

  it("carries NO tobacco/regulated addon gate (returns exist for every tenant)", () => {
    for (const h of [proto.resolveParkedRestock, proto.listParkedRestocks]) {
      expect(
        reflector.getAllAndOverride(REQUIRE_ADDON_KEY, [h, ReturnsController]),
      ).toBeUndefined();
    }
  });

  it("the list route is declared BEFORE the `:id` routes, so `parked-restocks` is never read as a return id", () => {
    const order = Object.getOwnPropertyNames(proto);
    expect(order.indexOf("listParkedRestocks")).toBeLessThan(order.indexOf("findOne"));
  });

  const pipe = new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true });
  const run = (body: unknown) =>
    pipe.transform(body, { type: "body", metatype: ResolveParkedRestockDto });

  it("the body is the PACK only: an integer 1..10000, and a retyped quantity is refused", async () => {
    await expect(run({ unitsPerBoxSupplied: 12 })).resolves.toMatchObject({
      unitsPerBoxSupplied: 12,
    });
    // 1 is ACCEPTED (owner ruling 2026-09-22): a parked row can legitimately have a factor of 1, and
    // rejecting it would leave those rows unresolvable forever — a 100% undercount.
    await expect(run({ unitsPerBoxSupplied: 1 })).resolves.toMatchObject({
      unitsPerBoxSupplied: 1,
    });
    for (const bad of [0, -12, 1.5, "abc", null, 10001, undefined]) {
      await expect(run({ unitsPerBoxSupplied: bad })).rejects.toBeInstanceOf(BadRequestException);
    }
    for (const extra of ["returnedQty", "qty", "pieces", "quantity", "unitsPerBox"]) {
      await expect(run({ unitsPerBoxSupplied: 12, [extra]: 99 })).rejects.toBeInstanceOf(
        BadRequestException,
      );
    }
  });
});
