import { readFileSync } from "fs";
import { resolve } from "path";
import { createHash } from "crypto";
import {
  checkRouteIdempotencyKey,
  makeRouteKeyHash,
  saveRouteIdempotencyKey,
} from "./route-idempotency";

/**
 * RF-019, extracted VERBATIM from RoutesService (behaviour-neutral; SA-065 funding for routes.service.ts).
 * These pin the three semantics the move must not change: the sha256 scoping, the 24h read window, and the
 * FAIL-OPEN catches. `common/idempotency.service.ts` copies the same semantics: a change here must be mirrored there.
 */
const fakePrisma = () => ({
  $queryRaw: jest.fn(),
  $executeRaw: jest.fn(),
});
/** The tagged-template's bound values, in order. */
const values = (call: unknown[]) => call.slice(1);

describe("makeRouteKeyHash", () => {
  it("is sha256 of `${scope}:${key}`", () => {
    expect(makeRouteKeyHash("k-1", "completeWithPayment:run-1:stop-1")).toBe(
      createHash("sha256").update("completeWithPayment:run-1:stop-1:k-1").digest("hex"),
    );
  });
});

describe("checkRouteIdempotencyKey", () => {
  it("reads by hash inside a 24h window and returns the parsed response", async () => {
    const prisma = fakePrisma();
    prisma.$queryRaw.mockResolvedValue([{ response: JSON.stringify({ ok: true }) }]);
    const before = Date.now();
    const out = await checkRouteIdempotencyKey(prisma as any, "k-1", "scope");
    expect(out).toEqual({ ok: true });
    const [hash, cutoff] = values(prisma.$queryRaw.mock.calls[0]) as [string, Date];
    expect(hash).toBe(makeRouteKeyHash("k-1", "scope"));
    const ageMs = before - cutoff.getTime();
    expect(ageMs).toBeGreaterThanOrEqual(24 * 60 * 60 * 1000 - 1000);
    expect(ageMs).toBeLessThan(24 * 60 * 60 * 1000 + 5000);
  });

  it("no row is null", async () => {
    const prisma = fakePrisma();
    prisma.$queryRaw.mockResolvedValue([]);
    expect(await checkRouteIdempotencyKey(prisma as any, "k", "s")).toBeNull();
  });

  it("FAIL-OPEN: a database error (e.g. the table is not there yet) is null, never a throw", async () => {
    const prisma = fakePrisma();
    prisma.$queryRaw.mockRejectedValue(new Error('relation "IdempotencyKey" does not exist'));
    expect(await checkRouteIdempotencyKey(prisma as any, "k", "s")).toBeNull();
  });
});

describe("saveRouteIdempotencyKey", () => {
  it("upserts by hash with the JSON response", async () => {
    const prisma = fakePrisma();
    prisma.$executeRaw.mockResolvedValue(1);
    await saveRouteIdempotencyKey(prisma as any, "k-1", "scope", { a: 1 });
    const [hash, json] = values(prisma.$executeRaw.mock.calls[0]);
    expect(hash).toBe(makeRouteKeyHash("k-1", "scope"));
    expect(json).toBe(JSON.stringify({ a: 1 }));
    expect((prisma.$executeRaw.mock.calls[0][0] as string[]).join("?")).toMatch(
      /ON CONFLICT \("keyHash"\) DO UPDATE/,
    );
  });

  it("FAIL-OPEN: a failing write is swallowed", async () => {
    const prisma = fakePrisma();
    prisma.$executeRaw.mockRejectedValue(new Error("db down"));
    await expect(saveRouteIdempotencyKey(prisma as any, "k", "s", {})).resolves.toBeUndefined();
  });
});

describe("the move is complete: routes.service.ts holds no copy of the guard", () => {
  const src = readFileSync(resolve(__dirname, "routes.service.ts"), "utf8");
  it("calls the extracted functions and owns no hashing or IdempotencyKey SQL itself", () => {
    expect(src).toMatch(/from "\.\/route-idempotency"/);
    expect(src).toMatch(/checkRouteIdempotencyKey\(this\.prisma,/);
    expect(src).toMatch(/saveRouteIdempotencyKey\(this\.prisma,/);
    expect(src).not.toMatch(/createHash\(/);
    expect(src).not.toMatch(/"IdempotencyKey"/);
    expect(src).not.toMatch(/this\.(check|save)IdempotencyKey|makeKeyHash/);
  });
});
