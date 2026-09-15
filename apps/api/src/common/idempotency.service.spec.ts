/**
 * REG-IDEM-SVC — the shared replay guard, whose semantics were COPIED from
 * RoutesService's three private RF-019 helpers (makeKeyHash /
 * checkIdempotencyKey / saveIdempotencyKey). RoutesService keeps its own
 * copies and still uses them for production driver traffic — it was not
 * refactored onto this service. Any change to the semantics pinned below
 * must be mirrored by hand in RoutesService's copies, or the two guards will
 * silently diverge.
 *
 * These pin the three semantics that make it safe to reuse: the sha256 scoping,
 * the 24h read window, and the FAIL-OPEN catches. A replay guard that throws
 * would 500 a legitimate return, so "the DB is broken" must degrade to "the
 * duplicate lands", never to "the request fails".
 */
import { Test, TestingModule } from "@nestjs/testing";
import { createHash } from "crypto";
import { IdempotencyService } from "./idempotency.service";
import { PrismaService } from "../prisma/prisma.service";
import { createMockPrisma } from "../testing/prisma-mock";

describe("IdempotencyService (REG-IDEM-SVC)", () => {
  let service: IdempotencyService;
  let prisma: ReturnType<typeof createMockPrisma>;

  beforeEach(async () => {
    prisma = createMockPrisma();
    const mod: TestingModule = await Test.createTestingModule({
      providers: [IdempotencyService, { provide: PrismaService, useValue: prisma }],
    }).compile();
    service = mod.get(IdempotencyService);
  });

  it("REG-IDEM-SVC-1 hashes sha256 of `${scope}:${key}` and separates scopes", () => {
    const expected = createHash("sha256").update("scope-a:key-1").digest("hex");
    expect(service.keyHash("key-1", "scope-a")).toBe(expected);
    // Same key, different scope — must NOT collide (this is what keeps two
    // callers, and two tenants, from reading each other's stored responses).
    expect(service.keyHash("key-1", "scope-b")).not.toBe(expected);
  });

  it("REG-IDEM-SVC-2 check() returns the parsed stored response", async () => {
    prisma.$queryRaw.mockResolvedValue([{ response: JSON.stringify({ id: "ret-1", qty: 3 }) }]);
    await expect(service.check("key-1", "scope-a")).resolves.toEqual({ id: "ret-1", qty: 3 });
  });

  it("REG-IDEM-SVC-3 check() reads with a 24h cutoff and returns null for no row", async () => {
    prisma.$queryRaw.mockResolvedValue([]);
    await expect(service.check("key-1", "scope-a")).resolves.toBeNull();

    // The cutoff parameter is interpolated into the tagged template; assert it
    // is ~24h ago so shortening/removing the window fails here.
    const params = prisma.$queryRaw.mock.calls.at(-1)!.slice(1);
    const cutoff = params.find((p: unknown) => p instanceof Date) as Date;
    expect(cutoff).toBeInstanceOf(Date);
    const ageMs = Date.now() - cutoff.getTime();
    expect(ageMs).toBeGreaterThan(23 * 60 * 60 * 1000);
    expect(ageMs).toBeLessThan(25 * 60 * 60 * 1000);
  });

  it("REG-IDEM-SVC-4 check() FAILS OPEN — returns null, never throws, when the read rejects", async () => {
    prisma.$queryRaw.mockRejectedValue(new Error('relation "IdempotencyKey" does not exist'));
    await expect(service.check("key-1", "scope-a")).resolves.toBeNull();
  });

  it("REG-IDEM-SVC-5 save() upserts on keyHash and stores the JSON response", async () => {
    await service.save("key-1", "scope-a", { id: "ret-1" });
    const call = prisma.$executeRaw.mock.calls.at(-1)!;
    const sql = (call[0] as unknown as string[]).join("?");
    expect(sql).toContain('INSERT INTO "IdempotencyKey"');
    expect(sql).toContain('ON CONFLICT ("keyHash") DO UPDATE');
    expect(call.slice(1)).toContain(JSON.stringify({ id: "ret-1" }));
    expect(call.slice(1)).toContain(service.keyHash("key-1", "scope-a"));
  });

  it("REG-IDEM-SVC-6 save() FAILS OPEN — swallows a rejecting write", async () => {
    prisma.$executeRaw.mockRejectedValue(new Error("boom"));
    await expect(service.save("key-1", "scope-a", { id: "ret-1" })).resolves.toBeUndefined();
  });
});
