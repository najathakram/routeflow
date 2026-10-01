/**
 * #2653 (SA-542a/b) the handoff core, red-first. The DB is an in-memory fake with the same
 * findFirst/deleteMany/create semantics the service relies on, so single-use and TTL are real.
 */
import { ConflictException, Logger, UnauthorizedException } from "@nestjs/common";
import { hashSignedToken, mintSignedToken } from "../../common/signed-token";
import {
  HANDOFF_TTL_SECONDS,
  HandoffCodeService,
  handoffTokenSecret,
} from "./handoff-code.service";
import { withReadBarrier } from "./read-barrier";

const SECRET = "h".repeat(40);

interface Row {
  tokenHash: string;
  realm: "STAFF" | "BUYER";
  userId: string | null;
  buyerAccountId: string | null;
  tenantId: string | null;
  deviceId: string;
  expiresAt: Date;
}

function fakeDb() {
  const rows: Row[] = [];
  const match = (r: Row, w: Record<string, unknown>) =>
    Object.entries(w).every(([k, v]) => {
      const val = (r as unknown as Record<string, unknown>)[k];
      if (v && typeof v === "object" && !(v instanceof Date)) {
        const cond = v as { gt?: Date; lte?: Date };
        if (cond.gt) return (val as Date) > cond.gt;
        if (cond.lte) return (val as Date) <= cond.lte;
      }
      return val === v;
    });
  const authHandoffCode = {
    create: jest.fn(async ({ data }: { data: Row }) => {
      rows.push({ ...data });
      return data;
    }),
    findFirst: jest.fn(async ({ where }: { where: Record<string, unknown> }) => {
      const r = rows.find((x) => match(x, where));
      return r ? { ...r } : null;
    }),
    deleteMany: jest.fn(async ({ where }: { where: Record<string, unknown> }) => {
      let count = 0;
      for (let i = rows.length - 1; i >= 0; i--) {
        if (match(rows[i], where)) {
          rows.splice(i, 1);
          count++;
        }
      }
      return { count };
    }),
  };
  return { rows, prisma: { authHandoffCode } };
}

const STAFF = { realm: "STAFF" as const, userId: "u1", tenantId: "t1" };
const BUYER = { realm: "BUYER" as const, buyerAccountId: "b1" };

describe("HandoffCodeService (#2653)", () => {
  const OLD = process.env.HANDOFF_TOKEN_SECRET;
  beforeEach(() => {
    process.env.HANDOFF_TOKEN_SECRET = SECRET;
    jest.useFakeTimers({ now: new Date("2026-09-28T09:00:00Z") });
  });
  afterEach(() => {
    jest.useRealTimers();
    if (OLD === undefined) delete process.env.HANDOFF_TOKEN_SECRET;
    else process.env.HANDOFF_TOKEN_SECRET = OLD;
  });

  it("the secret needs ≥ 32 chars; below that mint is 409 HANDOFF_NOT_CONFIGURED", async () => {
    expect(handoffTokenSecret({ HANDOFF_TOKEN_SECRET: "x".repeat(31) })).toBeNull();
    expect(handoffTokenSecret({ HANDOFF_TOKEN_SECRET: "x".repeat(32) })).toBe("x".repeat(32));
    process.env.HANDOFF_TOKEN_SECRET = "short";
    const { prisma } = fakeDb();
    await expect(new HandoffCodeService(prisma as never).mint(STAFF, "d1")).rejects.toMatchObject({
      response: { code: "HANDOFF_NOT_CONFIGURED", statusCode: 409 },
    });
    await expect(new HandoffCodeService(prisma as never).mint(STAFF, "d1")).rejects.toBeInstanceOf(
      ConflictException,
    );
  });

  it("stores ONLY sha256(code), one subject column, a 60 s expiry", async () => {
    const { rows, prisma } = fakeDb();
    const svc = new HandoffCodeService(prisma as never);
    const { code, expiresIn } = await svc.mint(STAFF, "d1");
    expect(expiresIn).toBe(60);
    expect(rows).toHaveLength(1);
    expect(rows[0].tokenHash).toBe(hashSignedToken(code));
    expect(JSON.stringify(rows)).not.toContain(code);
    expect(rows[0]).toMatchObject({
      realm: "STAFF",
      userId: "u1",
      buyerAccountId: null,
      tenantId: "t1",
    });
    expect(rows[0].expiresAt.getTime() - Date.now()).toBe(HANDOFF_TTL_SECONDS * 1000);

    await svc.mint(BUYER, "d2");
    expect(rows[1]).toMatchObject({
      realm: "BUYER",
      userId: null,
      buyerAccountId: "b1",
      tenantId: null,
    });
  });

  it("exactly one subject column is set on every row", async () => {
    const { rows, prisma } = fakeDb();
    const svc = new HandoffCodeService(prisma as never);
    await svc.mint(STAFF, "d1");
    await svc.mint(BUYER, "d2");
    for (const r of rows)
      expect([r.userId, r.buyerAccountId].filter((v) => v !== null)).toHaveLength(1);
  });

  it("minting clears the SAME subject's expired rows only", async () => {
    const { rows, prisma } = fakeDb();
    const svc = new HandoffCodeService(prisma as never);
    await svc.mint(STAFF, "old");
    await svc.mint({ realm: "STAFF", userId: "u2", tenantId: "t1" }, "other");
    jest.advanceTimersByTime(61_000);
    await svc.mint(STAFF, "new");
    expect(rows.map((r) => r.deviceId).sort()).toEqual(["new", "other"]);
  });

  it("consume works once; a second exchange of the same code is 401", async () => {
    const { prisma } = fakeDb();
    const svc = new HandoffCodeService(prisma as never);
    const { code } = await svc.mint(STAFF, "d1");
    await expect(svc.consume("STAFF", code)).resolves.toMatchObject({
      realm: "STAFF",
      userId: "u1",
      tenantId: "t1",
      deviceId: "d1",
    });
    await expect(svc.consume("STAFF", code)).rejects.toMatchObject({
      response: { code: "HANDOFF_CODE_INVALID", statusCode: 401 },
    });
  });

  it("of two exchanges that BOTH read the row before either deletes it, exactly one wins (count must be 1)", async () => {
    const { prisma } = fakeDb();
    const minter = new HandoffCodeService(prisma as never);
    const { code } = await minter.mint(STAFF, "d1");
    // Forced interleave: each consume's findFirst returns the row, then waits until the other
    // has read it too, so both reach deleteMany holding a row that only one of them can delete.
    const gated = {
      authHandoffCode: withReadBarrier(prisma.authHandoffCode as never, 2),
    };
    const svc = new HandoffCodeService(gated as never);
    const results = await Promise.allSettled([
      svc.consume("STAFF", code),
      svc.consume("STAFF", code),
    ]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((r) => r.status === "rejected")).toHaveLength(1);
    // Discriminates: both reads really happened before any delete.
    expect(prisma.authHandoffCode.findFirst).toHaveBeenCalledTimes(2);
  });

  it("expires after 60 s (TTL)", async () => {
    const { prisma } = fakeDb();
    const svc = new HandoffCodeService(prisma as never);
    const { code } = await svc.mint(STAFF, "d1");
    jest.advanceTimersByTime(60_001);
    await expect(svc.consume("STAFF", code)).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it("a forged or malformed code is 401 with ZERO database calls", async () => {
    const { prisma } = fakeDb();
    const svc = new HandoffCodeService(prisma as never);
    for (const bad of [mintSignedToken("z".repeat(40)), "nope", "", "a.b", 42, null, undefined]) {
      await expect(svc.consume("STAFF", bad)).rejects.toMatchObject({
        response: { code: "HANDOFF_CODE_INVALID" },
      });
    }
    expect(prisma.authHandoffCode.findFirst).not.toHaveBeenCalled();
    expect(prisma.authHandoffCode.deleteMany).not.toHaveBeenCalled();
  });

  it("a code presented to the OTHER realm is the same 401 and writes nothing", async () => {
    const { rows, prisma } = fakeDb();
    const svc = new HandoffCodeService(prisma as never);
    const { code } = await svc.mint(STAFF, "d1");
    prisma.authHandoffCode.deleteMany.mockClear();
    await expect(svc.consume("BUYER", code)).rejects.toMatchObject({
      response: { code: "HANDOFF_CODE_INVALID" },
    });
    expect(prisma.authHandoffCode.deleteMany).not.toHaveBeenCalled();
    expect(rows).toHaveLength(1); // still usable at its own realm
    await expect(svc.consume("STAFF", code)).resolves.toMatchObject({ realm: "STAFF" });
  });

  it("with the secret unset, consume refuses before any DB read", async () => {
    const { prisma } = fakeDb();
    const svc = new HandoffCodeService(prisma as never);
    const { code } = await svc.mint(STAFF, "d1");
    delete process.env.HANDOFF_TOKEN_SECRET;
    prisma.authHandoffCode.findFirst.mockClear();
    await expect(svc.consume("STAFF", code)).rejects.toBeInstanceOf(UnauthorizedException);
    expect(prisma.authHandoffCode.findFirst).not.toHaveBeenCalled();
  });

  it("the code never reaches a log line", async () => {
    const spies = (["log", "warn", "error", "debug", "verbose"] as const).map((m) =>
      jest.spyOn(Logger.prototype, m).mockImplementation(() => undefined),
    );
    const { prisma } = fakeDb();
    const svc = new HandoffCodeService(prisma as never);
    const { code } = await svc.mint(STAFF, "d1");
    await svc.consume("STAFF", code);
    await svc.consume("STAFF", code).catch(() => undefined);
    for (const s of spies) {
      for (const call of s.mock.calls) expect(JSON.stringify(call)).not.toContain(code);
      s.mockRestore();
    }
  });
});
