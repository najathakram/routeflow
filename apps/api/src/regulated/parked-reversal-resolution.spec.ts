/**
 * SA-089 — B660 PR B: the operator RESOLUTION of a parked regulated-ledger reversal. The
 * classify/correct/book money math is `RegulatedLedgerService.resolveParkedReversal`'s own
 * job (tested in regulated-ledger.service.spec.ts) — stubbed here as a black box, matching
 * parked-restock-resolution.spec.ts's own convention of not re-testing the underlying writer.
 * These tests cover the claim-first transaction shape, the audit, and the endpoint wiring.
 */
import {
  BadRequestException,
  ConflictException,
  ExecutionContext,
  NotFoundException,
  ValidationPipe,
} from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import { Test } from "@nestjs/testing";
import { UserRole } from "@prisma/client";
import { ParkedReversalResolutionService } from "./parked-reversal-resolution.service";
import { RegulatedController } from "./regulated.controller";
import { ResolveParkedReversalDto } from "./dto/resolve-parked-reversal.dto";
import { PrismaService } from "../prisma/prisma.service";
import { RegulatedLedgerService } from "./regulated-ledger.service";
import { RolesGuard } from "../auth/guards/roles.guard";
import { REQUIRE_ADDON_KEY } from "../billing/require-addon.decorator";
import { createMockPrisma } from "../testing/prisma-mock";

const RETURN_ID = "ret-12345678-abcd";
const parked = (over: Record<string, unknown> = {}) => ({
  id: "pr-1",
  tenantId: "t1",
  returnId: RETURN_ID,
  orderId: "ord-1",
  orderItemId: "oi-1",
  saleEntryId: "s-1",
  returnedPieces: 5,
  reason: "no snapshot and no product to gate on",
  periodBucket: "2026-07",
  createdAt: new Date("2026-09-01T00:00:00Z"),
  resolvedAt: null as Date | null,
  resolvedById: null as string | null,
  unitsPerBoxSupplied: null as number | null,
  resolvedEntryId: null as string | null,
  ...over,
});

const BOOKED_RESOLUTION = {
  outcome: "booked" as const,
  correctionEntryId: "corr-1",
  resolvedEntryId: "rev-1",
  bookedPieces: 5,
  bookedQty: 5,
  bookedNet: -50,
  bookedTax: -10,
  parkedPieces: 0,
  parkedRowIds: [] as string[],
  unbookedPieces: 0,
  verdictAfter: "legacy" as const,
  unresolvableReason: null,
};

describe("ParkedReversalResolutionService", () => {
  let service: ParkedReversalResolutionService;
  let prisma: ReturnType<typeof createMockPrisma>;
  let audit: { log: jest.Mock };
  let ledger: { resolveParkedReversal: jest.Mock; filedPeriodForParked: jest.Mock };
  let table: ReturnType<typeof parked>[];
  const actor = { id: "u-op" };

  beforeEach(async () => {
    prisma = createMockPrisma();
    audit = { log: jest.fn().mockResolvedValue(undefined) };
    ledger = {
      resolveParkedReversal: jest.fn().mockResolvedValue(BOOKED_RESOLUTION),
      filedPeriodForParked: jest.fn().mockResolvedValue(null),
    };
    // SA-193 (6): the audit row is written INSIDE the transaction via tx.auditLog.create; `audit.log`
    // records the flat row so the assertions below read it the same way.
    (prisma as any).auditLog.create = jest.fn(async ({ data }: any) => {
      audit.log(data);
      return data;
    });
    table = [parked()];
    const model: any = (prisma as any).regulatedLedgerParkedReversal;
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
    prisma.return.findFirst.mockResolvedValue({ status: "RECEIVED" } as any);
    const mod = await Test.createTestingModule({
      providers: [
        ParkedReversalResolutionService,
        { provide: PrismaService, useValue: prisma },
        { provide: RegulatedLedgerService, useValue: ledger },
      ],
    }).compile();
    service = mod.get(ParkedReversalResolutionService);
  });

  it("stamps resolvedAt / resolvedById / unitsPerBoxSupplied / resolvedReason on a CONDITIONAL claim, then the resolvedEntryId", async () => {
    const res = await service.resolve("pr-1", 12, "confirmed the case size on the invoice", actor);
    const model: any = (prisma as any).regulatedLedgerParkedReversal;
    expect(model.updateMany.mock.calls[0][0]).toMatchObject({
      where: { id: "pr-1", resolvedAt: null },
      data: {
        resolvedById: "u-op",
        unitsPerBoxSupplied: 12,
        // Opus review: the operator's own reason persists on the ROW itself, not only in the
        // audit log's operatorReason meta field.
        resolvedReason: "confirmed the case size on the invoice",
      },
    });
    expect(table[0].resolvedAt).toBeInstanceOf(Date);
    expect(model.updateMany.mock.calls[1][0]).toMatchObject({
      where: { id: "pr-1" },
      data: { resolvedEntryId: "rev-1" },
    });
    expect(table[0].resolvedEntryId).toBe("rev-1");
    expect(res).toEqual({
      alreadyResolved: false,
      outcome: "booked",
      resolvedEntryId: "rev-1",
      correctionEntryId: "corr-1",
      verdictAfter: "legacy",
      bookedPieces: 5,
      bookedQty: 5,
      bookedNet: -50,
      bookedTax: -10,
      parkedPieces: 0,
      parkedRowIds: [],
      unbookedPieces: 0,
      amendedPeriod: null,
      grownParks: [],
    });
  });

  it("SA-167(2): locks the Order row (FOR UPDATE) BEFORE the claim (cancel() is Return -> Order -> parked delete) and BEFORE reading the sale/corrections/remaining, inside the SAME transaction", async () => {
    let capturedExecuteRaw: jest.Mock | undefined;
    (prisma.tenantTransaction as jest.Mock).mockImplementationOnce((fn: any) => {
      const tx: any = { ...(prisma as any), $executeRaw: jest.fn().mockResolvedValue(0) };
      capturedExecuteRaw = tx.$executeRaw;
      return fn(tx);
    });

    await service.resolve("pr-1", 12, "confirmed the case size on the invoice", actor);

    expect(capturedExecuteRaw).toHaveBeenCalledTimes(2);
    const sqls = capturedExecuteRaw!.mock.calls.map((c) =>
      (c[0] as TemplateStringsArray).join("?"),
    );
    // Return first, then Order (cancel() is Return -> Order -> parked delete).
    expect(sqls[0]).toContain('"Return"');
    expect(sqls[1]).toContain('"Order"');
    expect(sqls.every((q) => q.includes("FOR UPDATE"))).toBe(true);
    const model: any = (prisma as any).regulatedLedgerParkedReversal;
    // BEFORE the claim (the first updateMany) — claim-then-Order deadlocks against cancel() — and
    // BEFORE resolveParkedReversal is ever called (where the sale/corrections/remaining are read).
    expect(capturedExecuteRaw!.mock.invocationCallOrder[1]).toBeLessThan(
      model.updateMany.mock.invocationCallOrder[0],
    );
    expect(capturedExecuteRaw!.mock.invocationCallOrder[0]).toBeLessThan(
      (ledger.resolveParkedReversal as jest.Mock).mock.invocationCallOrder[0],
    );
  });

  it("an already-resolved row still takes the Order lock first (the lock precedes every read of the resolved state) and books nothing", async () => {
    table[0].resolvedAt = new Date();
    let capturedExecuteRaw: jest.Mock | undefined;
    (prisma.tenantTransaction as jest.Mock).mockImplementationOnce((fn: any) => {
      const tx: any = { ...(prisma as any), $executeRaw: jest.fn().mockResolvedValue(0) };
      capturedExecuteRaw = tx.$executeRaw;
      return fn(tx);
    });

    const res = await service.resolve("pr-1", 12, "confirmed the case size on the invoice", actor);
    expect(capturedExecuteRaw).toHaveBeenCalledTimes(2);
    expect(res.alreadyResolved).toBe(true);
    expect(ledger.resolveParkedReversal).not.toHaveBeenCalled();
  });

  it("SA-167(2): a row cancel() deleted while this waited for the Order lock is a 404, never alreadyResolved", async () => {
    const model: any = (prisma as any).regulatedLedgerParkedReversal;
    let reads = 0;
    model.findFirst = jest.fn(async () => (++reads === 1 ? table[0] : null));
    await expect(service.resolve("pr-1", 12, "reason text", actor)).rejects.toBeInstanceOf(
      NotFoundException,
    );
    expect(ledger.resolveParkedReversal).not.toHaveBeenCalled();
    expect(audit.log).not.toHaveBeenCalled();
  });

  it("SA-167(2): losing the claim to a cancel() that deleted the row is a 404 too", async () => {
    const model: any = (prisma as any).regulatedLedgerParkedReversal;
    let reads = 0;
    model.findFirst = jest.fn(async () => (++reads <= 2 ? table[0] : null));
    model.updateMany = jest.fn(async () => ({ count: 0 }));
    await expect(service.resolve("pr-1", 12, "reason text", actor)).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });

  it("SA-167: the audit and the answer carry every piece — parked and unbooked pieces are never hidden behind 'booked'", async () => {
    ledger.resolveParkedReversal.mockResolvedValue({
      ...BOOKED_RESOLUTION,
      outcome: "partial",
      bookedPieces: 24,
      parkedPieces: 36,
      parkedRowIds: ["pr-2"],
      unbookedPieces: 0,
      amendedPeriod: null,
      grownParks: [],
    });
    const res = await service.resolve("pr-1", 12, "reason text", actor);
    expect(res).toMatchObject({ outcome: "partial", parkedPieces: 36, parkedRowIds: ["pr-2"] });
    expect(audit.log).toHaveBeenCalledWith(
      expect.objectContaining({
        meta: expect.objectContaining({
          outcome: "partial",
          bookedPieces: 24,
          parkedPieces: 36,
          parkedRowIds: ["pr-2"],
          unbookedPieces: 0,
        }),
      }),
    );
  });

  it("passes the parked row's own fields and the supplied pack into RegulatedLedgerService.resolveParkedReversal", async () => {
    await service.resolve("pr-1", 12, "reason text", actor);
    expect(ledger.resolveParkedReversal).toHaveBeenCalledWith(
      expect.anything(),
      {
        returnId: RETURN_ID,
        orderId: "ord-1",
        orderItemId: "oi-1",
        saleEntryId: "s-1",
        returnedPieces: 5,
        // SA-182: the row's own period and the return's date travel with it.
        periodBucket: "2026-07",
        parkedAt: new Date("2026-09-01T00:00:00Z"),
      },
      12,
    );
  });

  it("a SECOND resolve is a no-op: no ledger call, the first answer stands, no second audit", async () => {
    await service.resolve("pr-1", 12, "first reason", actor);
    ledger.resolveParkedReversal.mockClear();
    audit.log.mockClear();
    const again = await service.resolve("pr-1", 6, "second reason", { id: "u-other" });
    expect(again).toMatchObject({ alreadyResolved: true, resolvedEntryId: "rev-1" });
    expect(ledger.resolveParkedReversal).not.toHaveBeenCalled();
    expect(table[0]).toMatchObject({ resolvedById: "u-op", unitsPerBoxSupplied: 12 });
    expect(audit.log).not.toHaveBeenCalled();
  });

  it("a concurrent resolve that loses the claim (count 0) never calls the ledger", async () => {
    (prisma as any).regulatedLedgerParkedReversal.updateMany.mockResolvedValueOnce({ count: 0 });
    const res = await service.resolve("pr-1", 12, "reason text", actor);
    expect(res.alreadyResolved).toBe(true);
    expect(ledger.resolveParkedReversal).not.toHaveBeenCalled();
  });

  it("404s a row the tenant cannot see, calling the ledger for nothing", async () => {
    table = [];
    await expect(service.resolve("pr-1", 12, "reason text", actor)).rejects.toBeInstanceOf(
      NotFoundException,
    );
    expect(ledger.resolveParkedReversal).not.toHaveBeenCalled();
    expect(audit.log).not.toHaveBeenCalled();
  });

  it("refuses a CANCELLED return BEFORE the claim (nothing is claimed) and calls the ledger for nothing", async () => {
    prisma.return.findFirst.mockResolvedValue({ status: "CANCELLED" } as any);
    await expect(service.resolve("pr-1", 12, "reason text", actor)).rejects.toBeInstanceOf(
      NotFoundException,
    );
    expect(
      (prisma as any).regulatedLedgerParkedReversal.updateMany as jest.Mock,
    ).not.toHaveBeenCalled();
    expect(ledger.resolveParkedReversal).not.toHaveBeenCalled();
    expect(audit.log).not.toHaveBeenCalled();
  });

  it("SA-170: reads the return's status INSIDE the transaction, AFTER the Return and Order locks and BEFORE the claim, so it serialises against cancel()", async () => {
    const order: string[] = [];
    const model: any = (prisma as any).regulatedLedgerParkedReversal;
    const claim = model.updateMany;
    model.updateMany = jest.fn(async (a: any) => {
      if (a.where?.resolvedAt === null) order.push("claim");
      return claim(a);
    });
    prisma.return.findFirst.mockImplementation(async () => {
      order.push("status-read");
      return { status: "RECEIVED" } as any;
    });
    ledger.resolveParkedReversal.mockImplementation(async () => {
      order.push("book");
      return BOOKED_RESOLUTION;
    });
    await service.resolve("pr-1", 12, "reason text", actor);
    expect(order).toEqual(["status-read", "claim", "book"]);
  });

  it("an unresolvable verdict refuses with a 409 PARKED_REVERSAL_UNRESOLVABLE, naming the reason — no audit", async () => {
    ledger.resolveParkedReversal.mockResolvedValue({
      outcome: "unresolvable",
      correctionEntryId: null,
      resolvedEntryId: null,
      bookedPieces: 0,
      bookedQty: 0,
      bookedNet: 0,
      bookedTax: 0,
      verdictAfter: null,
      unresolvableReason: "corrected qty is not positive",
    });
    // ONE call: a mock transaction doesn't actually roll back the claim mutation on throw the
    // way a real Postgres transaction would, so a second call here would see resolvedAt
    // already set and report alreadyResolved instead of re-throwing.
    let caught: unknown;
    try {
      await service.resolve("pr-1", 12, "reason text", actor);
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(ConflictException);
    expect((caught as ConflictException).message).toMatch(/corrected qty is not positive/);
    expect(audit.log).not.toHaveBeenCalled();
  });

  it("audits the actor, the classify verdict, the correction/reversal ids, the booked figures and the operator's own reason", async () => {
    await service.resolve("pr-1", 12, "confirmed with the supplier's packing slip", actor);
    expect(audit.log).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: "u-op",
        action: "regulated_ledger.parked_reversal_resolved",
        entityType: "RegulatedLedgerParkedReversal",
        entityId: "pr-1",
        meta: expect.objectContaining({
          returnId: RETURN_ID,
          saleEntryId: "s-1",
          orderItemId: "oi-1",
          parkReason: "no snapshot and no product to gate on",
          unitsPerBoxSupplied: 12,
          verdictAfter: "legacy",
          correctionEntryId: "corr-1",
          returnedPieces: 5,
          bookedPieces: 5,
          bookedQty: 5,
          bookedNet: -50,
          bookedTax: -10,
          resolvedEntryId: "rev-1",
          periodBucket: "2026-07",
          operatorReason: "confirmed with the supplier's packing slip",
        }),
      }),
    );
  });

  it("#2108: the audit row carries the PARKED ROW's tenantId never the caller context's tenant", async () => {
    (prisma as any).getTenantId = jest.fn().mockReturnValue("t-ctx");
    await service.resolve("pr-1", 12, "confirmed with the supplier's packing slip", actor);
    expect(audit.log).toHaveBeenCalledWith(expect.objectContaining({ tenantId: "t1" }));
  });

  it("#2108: a tenant-less caller (SUPER_ADMIN) is refused on resolve and list — no audit, no claim", async () => {
    (prisma as any).getTenantId = jest.fn().mockReturnValue(null);
    await expect(service.resolve("pr-1", 12, "confirmed the case size", actor)).rejects.toThrow(
      "tenant-scoped",
    );
    await expect(service.list()).rejects.toThrow("tenant-scoped");
    expect(audit.log).not.toHaveBeenCalled();
    expect(ledger.resolveParkedReversal).not.toHaveBeenCalled();
  });

  it("a CLOSED outcome (already fully reversed) still stamps resolvedAt and audits, with a null resolvedEntryId", async () => {
    ledger.resolveParkedReversal.mockResolvedValue({
      outcome: "closed",
      correctionEntryId: null,
      resolvedEntryId: null,
      bookedPieces: 0,
      bookedQty: 0,
      bookedNet: 0,
      bookedTax: 0,
      parkedPieces: 0,
      parkedRowIds: [],
      unbookedPieces: 0,
      verdictAfter: "piece-axis",
      unresolvableReason: null,
    });
    const res = await service.resolve("pr-1", 12, "reason text", actor);
    expect(res).toEqual({
      alreadyResolved: false,
      outcome: "closed",
      resolvedEntryId: null,
      correctionEntryId: null,
      verdictAfter: "piece-axis",
      bookedPieces: 0,
      bookedQty: 0,
      bookedNet: 0,
      bookedTax: 0,
      parkedPieces: 0,
      parkedRowIds: [],
      unbookedPieces: 0,
      amendedPeriod: null,
      grownParks: [],
    });
    expect(table[0].resolvedAt).toBeInstanceOf(Date);
    expect(audit.log).toHaveBeenCalledWith(
      expect.objectContaining({
        meta: expect.objectContaining({ bookedPieces: 0, resolvedEntryId: null }),
      }),
    );
  });

  it("lists the tenant's unresolved parked reversals, oldest first", async () => {
    const rows = await service.list();
    expect(rows).toHaveLength(1);
    expect((prisma as any).regulatedLedgerParkedReversal.findMany.mock.calls[0][0]).toEqual({
      where: { resolvedAt: null },
      orderBy: { createdAt: "asc" },
    });
  });

  it("#2108: list() gets amendedPeriod from the ledger's ONE filed-period helper (the resolution's own fold), per row", async () => {
    const filed = { periodKey: "2020-01", status: "GENERATED", trackedCategoryId: "cat-A" };
    ledger.filedPeriodForParked.mockResolvedValueOnce(filed);
    const [row] = (await service.list()) as any[];
    expect(row.amendedPeriod).toEqual(filed);
    expect(ledger.filedPeriodForParked).toHaveBeenCalledWith(expect.anything(), table[0]);

    ledger.filedPeriodForParked.mockResolvedValueOnce(null);
    const [open] = (await service.list()) as any[];
    expect(open.amendedPeriod).toBeNull();
  });

  it("#2108 source pin: findFiledPeriod is the ONLY regulatedFiling lookup on the resolve and list() paths (no second inline query survives)", () => {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const fs = require("fs");
    const wrapper: string = fs.readFileSync(
      require.resolve("./parked-reversal-resolution.service"),
      "utf8",
    );
    const ledgerSrc: string = fs.readFileSync(
      require.resolve("./regulated-ledger.service"),
      "utf8",
    );
    // the wrapper (resolve + list) never touches the filing table itself
    expect(wrapper).not.toMatch(/regulatedFiling/);
    // in the ledger service exactly one query reads it, and it is findFiledPeriod's
    const uses = ledgerSrc.match(/regulatedFiling\.(findFirst|findMany|findUnique)/g) ?? [];
    const finder = ledgerSrc.slice(
      ledgerSrc.indexOf("async findFiledPeriod("),
      ledgerSrc.indexOf("async filedPeriodForParked("),
    );
    expect(uses.length).toBeGreaterThanOrEqual(1);
    expect(finder).toMatch(/regulatedFiling\.findFirst/);
    const outside =
      ledgerSrc.replace(finder, "").match(/regulatedFiling\.(findFirst|findMany|findUnique)/g) ??
      [];
    expect(outside).toEqual([]);
  });

  it("#2108: a REJECTING in-transaction audit create makes resolve() reject — the audit is inside the transaction, never a post-commit best-effort write", async () => {
    (prisma as any).auditLog.create = jest.fn().mockRejectedValue(new Error("audit store down"));
    await expect(service.resolve("pr-1", 12, "reason text", actor)).rejects.toThrow(
      "audit store down",
    );
    // the audit write happened AFTER the ledger call, in the same tx (so the caller's rollback undoes both)
    expect(ledger.resolveParkedReversal).toHaveBeenCalledTimes(1);
    expect((prisma as any).auditLog.create).toHaveBeenCalledTimes(1);
  });
});

describe("parked reversal endpoints: roles, the tobacco addon, and the body", () => {
  const reflector = new Reflector();
  const guard = new RolesGuard(reflector);
  const proto = RegulatedController.prototype;
  const ctx = (handler: any, role?: UserRole): ExecutionContext =>
    ({
      getHandler: () => handler,
      getClass: () => RegulatedController,
      switchToHttp: () => ({ getRequest: () => ({ user: role ? { role } : undefined }) }),
    }) as unknown as ExecutionContext;

  it("OPERATOR and TENANT_ADMIN may resolve/list; DRIVER, CUSTOMER and anonymous are refused (403)", () => {
    for (const role of [UserRole.OPERATOR, UserRole.TENANT_ADMIN]) {
      expect(guard.canActivate(ctx(proto.resolveParkedReversal, role))).toBe(true);
      expect(guard.canActivate(ctx(proto.listParkedReversals, role))).toBe(true);
    }
    for (const role of [UserRole.DRIVER, UserRole.CUSTOMER, undefined]) {
      expect(guard.canActivate(ctx(proto.resolveParkedReversal, role))).toBe(false);
      expect(guard.canActivate(ctx(proto.listParkedReversals, role))).toBe(false);
    }
  });

  it("carries the tobacco_dealer addon gate — unlike parked-restocks, this surface is regulated-only", () => {
    // RequireAddon always stores an array (it also supports "any of several addons") — a bare
    // string here would be wrong even for one addon.
    for (const h of [proto.resolveParkedReversal, proto.listParkedReversals]) {
      expect(reflector.getAllAndOverride(REQUIRE_ADDON_KEY, [h, RegulatedController])).toEqual([
        "tobacco_dealer",
      ]);
    }
  });

  const pipe = new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true });
  const run = (body: unknown) =>
    pipe.transform(body, { type: "body", metatype: ResolveParkedReversalDto });

  it("the body is PACK (1..10000) and a REQUIRED reason (>= 3 chars) — no other field", async () => {
    await expect(run({ pack: 12, reason: "confirmed" })).resolves.toMatchObject({
      pack: 12,
      reason: "confirmed",
    });
    // 1 is accepted — same owner ruling as the parked-restock DTO: a genuinely unboxed line.
    await expect(run({ pack: 1, reason: "was never boxed" })).resolves.toMatchObject({ pack: 1 });
    for (const bad of [0, -12, 1.5, "abc", null, 10001, undefined]) {
      await expect(run({ pack: bad, reason: "confirmed" })).rejects.toBeInstanceOf(
        BadRequestException,
      );
    }
    for (const bad of ["", "ok", "  ", undefined, null]) {
      await expect(run({ pack: 12, reason: bad })).rejects.toBeInstanceOf(BadRequestException);
    }
    // SA-167(2): trimmed, then 3..500 — whitespace padding cannot satisfy the minimum.
    await expect(run({ pack: 12, reason: "  confirmed  " })).resolves.toMatchObject({
      reason: "confirmed",
    });
    await expect(run({ pack: 12, reason: "a".repeat(500) })).resolves.toBeDefined();
    for (const bad of ["  ok  ", " a ", "a".repeat(501)]) {
      await expect(run({ pack: 12, reason: bad })).rejects.toBeInstanceOf(BadRequestException);
    }
    for (const extra of ["unitsPerBoxSupplied", "returnedPieces", "qty"]) {
      await expect(run({ pack: 12, reason: "confirmed", [extra]: 99 })).rejects.toBeInstanceOf(
        BadRequestException,
      );
    }
  });
});
