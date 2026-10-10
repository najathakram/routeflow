import { ForbiddenException, NotFoundException } from "@nestjs/common";
import { RoutesService } from "./routes.service";
import { assertRunStillInProgress, lockRunStopsForTerminalStatus } from "./delivery-lines.util";

jest.mock("../common/geocode.util", () => ({ geocodeAddress: jest.fn() }));

/**
 * #2631 / SA-550 — the stop row is the serialization point between a run's terminal transition and a
 * stop completion (house order STOP rows → RouteRun):
 *   - updateRunStatus (→ COMPLETED / CANCELLED) locks the run's CURRENT stop rows FIRST, before the run
 *     row or any order release (a run with no stops locks the run row directly);
 *   - completeStop / completeWithPayment re-read the run status IN-TX right after their stop claim
 *     through the SAME assertRunInProgress (403), with no run lock (SA-550a).
 * The real-PG latch / pg_locks / retry pins live in routes.run-recheck-2631.db.spec.ts (F2's lane).
 */
describe("#2631 assertRunStillInProgress (in-tx, after the stop claim)", () => {
  const tx = (status: string | null) => ({
    routeRun: {
      findUnique: jest.fn().mockResolvedValue(status === null ? null : { status }),
    },
  });

  it("an IN_PROGRESS run passes", async () => {
    await expect(assertRunStillInProgress(tx("IN_PROGRESS"), "run-1")).resolves.toBeUndefined();
  });

  it.each(["COMPLETED", "CANCELLED", "SCHEDULED"])(
    "a %s run ⇒ the SAME 403 as the pre-tx assertRunInProgress (reused, not copied)",
    async (status) => {
      const err = await assertRunStillInProgress(tx(status), "run-1").catch((e: unknown) => e);
      expect(err).toBeInstanceOf(ForbiddenException);
      expect((err as Error).message).toBe(
        `Cannot complete a stop on a run that is not in progress (current status: ${status}).`,
      );
    },
  );

  it("a run that vanished ⇒ 404", async () => {
    await expect(assertRunStillInProgress(tx(null), "run-1")).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });

  it("reads the run by id on the TRANSACTION client, status only (a plain read — no lock)", async () => {
    const t = tx("IN_PROGRESS");
    await assertRunStillInProgress(t, "run-9");
    expect(t.routeRun.findUnique).toHaveBeenCalledWith({
      where: { id: "run-9" },
      select: { status: true },
    });
  });
});

describe("#2631 lockRunStopsForTerminalStatus (STOP rows → RouteRun)", () => {
  const sqlOf = (call: any[]) => (call[0] as TemplateStringsArray).join("?");

  it("locks the run's stop rows by id FOR UPDATE; with stops present the run row is not locked here", async () => {
    const tx = { $queryRaw: jest.fn().mockResolvedValue([{ id: "s1" }, { id: "s2" }]) };
    await lockRunStopsForTerminalStatus(tx, "run-1");
    expect(tx.$queryRaw).toHaveBeenCalledTimes(1);
    expect(sqlOf(tx.$queryRaw.mock.calls[0])).toMatch(
      /FROM "RouteRunStop" WHERE "routeRunId" = \? ORDER BY id FOR UPDATE/,
    );
    expect(tx.$queryRaw.mock.calls[0][1]).toBe("run-1");
  });

  it("a run with NO stop rows locks the run row directly", async () => {
    const tx = { $queryRaw: jest.fn().mockResolvedValueOnce([]).mockResolvedValueOnce([]) };
    await lockRunStopsForTerminalStatus(tx, "run-1");
    expect(tx.$queryRaw).toHaveBeenCalledTimes(2);
    expect(sqlOf(tx.$queryRaw.mock.calls[1])).toMatch(/FROM "RouteRun" WHERE id = \? FOR UPDATE/);
  });

  it("SA-511c: an undefined run id throws BEFORE any query (never a no-op lock)", async () => {
    const tx = { $queryRaw: jest.fn() };
    await expect(lockRunStopsForTerminalStatus(tx, undefined as any)).rejects.toThrow(
      /run id missing/,
    );
    expect(tx.$queryRaw).not.toHaveBeenCalled();
  });
});

describe("#2631 updateRunStatus → CANCELLED: the stop lock is the FIRST statement of the tx", () => {
  it("stop rows FOR UPDATE precede the run update and every order release", async () => {
    const order: string[] = [];
    const rec =
      (name: string, value: unknown = {}) =>
      (..._a: unknown[]) => {
        order.push(name);
        return Promise.resolve(value);
      };
    const tx: any = {
      $queryRaw: jest.fn(rec("lockStops", [{ id: "s1" }])),
      routeRun: { update: jest.fn(rec("routeRun.update", { id: "run-1", status: "CANCELLED" })) },
      routeRunStop: { findMany: jest.fn(rec("routeRunStop.findMany", [])) },
      order: { updateMany: jest.fn(rec("order.updateMany", { count: 0 })) },
      changeRequest: { updateMany: jest.fn(rec("changeRequest.updateMany", { count: 0 })) },
    };
    const db = {
      routeRun: {
        findUnique: jest.fn().mockResolvedValue({
          id: "run-1",
          status: "IN_PROGRESS",
          driverId: "d1",
          completedAt: null,
        }),
      },
    };
    const svc: any = Object.assign(Object.create(RoutesService.prototype), {
      prisma: { forTenant: () => db, tenantTransaction: (fn: any) => fn(tx) },
      logger: { log: jest.fn(), warn: jest.fn(), error: jest.fn() },
    });
    const operator = { sub: "u-op", role: "OPERATOR", tenantId: "t1" } as any;

    // Anything after the transaction (emits, notifications) is out of scope — only its order matters.
    await svc.updateRunStatus("run-1", { status: "CANCELLED" }, operator).catch(() => undefined);

    expect(order[0]).toBe("lockStops");
    expect(order).toContain("routeRun.update");
    expect(order.indexOf("lockStops")).toBeLessThan(order.indexOf("routeRun.update"));
  });
});
