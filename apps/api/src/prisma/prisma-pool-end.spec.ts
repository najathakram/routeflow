// W-720: PrismaService builds its own pg.Pool and hands it to PrismaPg. The adapter never ends a
// pool its caller supplied, so `$disconnect()` left the pool's idle clients open until pg's 10 s
// idle timeout: every DB spec printed "Jest did not exit" and held the heavy slot ~10 s longer.
// These pin that an explicit $disconnect ends the pool it built, exactly once, and that app
// shutdown (Nest lifecycle hooks) never does: draining requests, crons and Bull jobs still query.
const mockPools: Array<{ end: jest.Mock; on: jest.Mock }> = [];
jest.mock("pg", () => {
  const actual = jest.requireActual("pg");
  return {
    ...actual,
    Pool: jest.fn().mockImplementation(() => {
      const pool = { end: jest.fn().mockResolvedValue(undefined), on: jest.fn() };
      mockPools.push(pool);
      return pool;
    }),
  };
});

import { Test } from "@nestjs/testing";
import { PrismaService } from "./prisma.service";

describe("W-720 PrismaService ends the pg.Pool it built", () => {
  beforeEach(() => {
    mockPools.length = 0;
  });

  it("$disconnect() ends the service's own pool", async () => {
    const svc = new PrismaService();
    expect(mockPools).toHaveLength(1);
    await svc.$disconnect();
    expect(mockPools[0].end).toHaveBeenCalledTimes(1);
  });

  it("onModuleDestroy() keeps the pool open: Nest closes HTTP/ws (dispose) only AFTER destroy hooks", async () => {
    // A request or cron tick still draining after onModuleDestroy reconnects lazily on this pool;
    // ending it here would turn every in-flight request of a redeploy into a 500.
    const svc = new PrismaService();
    await svc.onModuleDestroy();
    expect(mockPools[0].end).not.toHaveBeenCalled();
  });

  it("the service has no onApplicationShutdown: Bull queues close in theirs, maybe after it, and their running jobs still query", () => {
    expect(
      (PrismaService.prototype as { onApplicationShutdown?: unknown }).onApplicationShutdown,
    ).toBeUndefined();
  });

  it("a pool pg already marks as ending is never ended again", async () => {
    const svc = new PrismaService();
    (mockPools[0] as unknown as { ending: boolean }).ending = true;
    await svc.$disconnect();
    expect(mockPools[0].end).not.toHaveBeenCalled();
  });

  it("a full Nest close() (every lifecycle hook) never ends the pool; only an explicit $disconnect does", async () => {
    const mod = await Test.createTestingModule({ providers: [PrismaService] }).compile();
    const svc = mod.get(PrismaService);
    const pool = mockPools[mockPools.length - 1];
    await mod.close();
    expect(pool.end).not.toHaveBeenCalled();
    await svc.$disconnect();
    expect(pool.end).toHaveBeenCalledTimes(1);
  });

  it("a second $disconnect() never ends the pool twice (pg throws on a double end)", async () => {
    const svc = new PrismaService();
    await svc.$disconnect();
    await svc.$disconnect();
    expect(mockPools[0].end).toHaveBeenCalledTimes(1);
  });

  it("each service ends only its own pool", async () => {
    const a = new PrismaService();
    const b = new PrismaService();
    await a.$disconnect();
    expect(mockPools[0].end).toHaveBeenCalledTimes(1);
    expect(mockPools[1].end).not.toHaveBeenCalled();
    await b.$disconnect();
    expect(mockPools[1].end).toHaveBeenCalledTimes(1);
  });
});
