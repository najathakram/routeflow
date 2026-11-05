import { existsSync, readFileSync } from "fs";
import { resolve } from "path";
import { replayStopKey, stopCompletionRequestHash } from "./stop-completion-key";

const line = (over: Record<string, unknown> = {}) => ({
  orderItemId: "a",
  type: "DELIVERED",
  quantityDelivered: 10,
  ...over,
});
const second = line({ orderItemId: "b", quantityDelivered: 4 });
const dto = (over: Record<string, unknown> = {}) =>
  ({
    deliveries: [line(), second],
    payment: { amount: 120, method: "CASH" },
    ...over,
  }) as never;

describe("stopCompletionRequestHash (SA-953 S1)", () => {
  const base = stopCompletionRequestHash(dto());

  it.each([
    ["a changed quantity", { deliveries: [line({ quantityDelivered: 7 }), second] }],
    ["a changed type", { deliveries: [line({ type: "PARTIAL" }), second] }],
    ["a changed line", { deliveries: [line({ orderItemId: "c" }), second] }],
    ["a changed product", { deliveries: [line({ productId: "p2" }), second] }],
    ["a dropped line", { deliveries: [line()] }],
    ["a changed amount", { payment: { amount: 120.01, method: "CASH" } }],
    ["a changed method", { payment: { amount: 120, method: "CHECK" } }],
    ["a changed invoice", { payment: { amount: 120, method: "CASH", invoiceId: "i" } }],
    ["no payment", { payment: undefined }],
  ])("%s is a different request", (_name, over) => {
    expect(stopCompletionRequestHash(dto(over))).not.toBe(base);
  });

  it.each([
    ["the lines in another order", { deliveries: [second, line()] }],
    ["the method in another case", { payment: { amount: 120, method: "cash" } }],
    ["a driver note", { driverNote: "left at the side door" }],
    ["a signature", { signatureUrl: "data:image/png;base64,AAAA" }],
    ["photos", { podPhotoUrls: ["data:image/png;base64,AAAA"] }],
    ["a safe drop", { safeDropEnabled: true }],
    ["age and ID evidence", { ageVerified: true, identityVerified: true, identityType: "DL" }],
    ["the key", { idempotencyKey: "another" }],
  ])("%s is the same request", (_name, over) => {
    expect(stopCompletionRequestHash(dto(over))).toBe(base);
  });

  it("a line's note is the same request", () => {
    const noted = dto({ deliveries: [line({ note: "dented" }), second] });
    expect(stopCompletionRequestHash(noted)).toBe(base);
  });

  it("no deliveries and an empty list are the same request", () => {
    expect(stopCompletionRequestHash({ deliveries: [] } as never)).toBe(
      stopCompletionRequestHash({} as never),
    );
  });

  it("amounts compare in cents, so a float's tail is the same request", () => {
    expect(stopCompletionRequestHash(dto({ payment: { amount: 0.1 + 0.2, method: "CASH" } }))).toBe(
      stopCompletionRequestHash(dto({ payment: { amount: 0.3, method: "CASH" } })),
    );
  });
});

describe("I-5 Pin. One model: RoutesService keeps no key code of its own (SA-953 S2)", () => {
  it("the private trio is gone", () => {
    const src = readFileSync(resolve(__dirname, "routes.service.ts"), "utf8");
    expect(existsSync(resolve(__dirname, "route-idempotency.ts"))).toBe(false);
    expect(src).not.toMatch(/route-idempotency|check\w*IdempotencyKey|save\w*IdempotencyKey/);
    expect(src).not.toMatch(/createHash\(|"IdempotencyKey"/);
    expect(src).toMatch(/from "\.\/stop-completion-key"/);
  });
});

describe("replayStopKey reads the stop after the row (SA-1098 A-2)", () => {
  const stopKey = { key: "k", tenantId: "t", scope: "s", requestHash: "h" } as never;
  const prismaFor = (queryRaw: unknown[], stop: { status: string } | null | Error) => {
    const findUnique = jest.fn(() =>
      stop instanceof Error ? Promise.reject(stop) : Promise.resolve(stop),
    );
    const tx = {
      $executeRaw: jest.fn().mockResolvedValue(0),
      $queryRaw: jest.fn().mockResolvedValue(queryRaw),
      routeRunStop: { findUnique },
    };
    return {
      findUnique,
      prisma: { tenantTransaction: (fn: (t: typeof tx) => Promise<unknown>) => fn(tx) } as never,
    };
  };
  const row = (hash: string) => [
    { response: JSON.stringify({ requestHash: hash, response: { id: "stop-1" } }) },
  ];

  it("no stored row: nothing is read, the completion goes on", async () => {
    const { prisma, findUnique } = prismaFor([], { status: "PENDING" });
    await expect(replayStopKey(prisma, stopKey, "stop-1")).resolves.toBeNull();
    expect(findUnique).not.toHaveBeenCalled();
  });

  it.each(["PENDING", "IN_PROGRESS", "SKIPPED"])(
    "a row for a stop that is now %s: 409 STOP_REOPENED",
    async (status) => {
      const { prisma } = prismaFor(row("h"), { status });
      await expect(replayStopKey(prisma, stopKey, "stop-1")).rejects.toMatchObject({
        response: { code: "STOP_REOPENED" },
      });
    },
  );

  it("a row for a stop that is gone: 409 STOP_REOPENED too", async () => {
    const { prisma } = prismaFor(row("h"), null);
    await expect(replayStopKey(prisma, stopKey, "stop-1")).rejects.toMatchObject({
      response: { code: "STOP_REOPENED" },
    });
  });

  it("the status is checked before the hash: a changed request on a reopened stop is STOP_REOPENED", async () => {
    const { prisma } = prismaFor(row("another-hash"), { status: "PENDING" });
    await expect(replayStopKey(prisma, stopKey, "stop-1")).rejects.toMatchObject({
      response: { code: "STOP_REOPENED" },
    });
  });

  it("COMPLETED: the same request replays, a changed one is the existing conflict", async () => {
    const same = prismaFor(row("h"), { status: "COMPLETED" });
    await expect(replayStopKey(same.prisma, stopKey, "stop-1")).resolves.toEqual({ id: "stop-1" });
    const changed = prismaFor(row("other"), { status: "COMPLETED" });
    await expect(replayStopKey(changed.prisma, stopKey, "stop-1")).rejects.toMatchObject({
      response: { code: "IDEMPOTENCY_KEY_CONFLICT" },
    });
  });

  it("a failed status read is an error, never a replay (the client keeps its key)", async () => {
    const { prisma } = prismaFor(row("h"), new Error("connection lost"));
    await expect(replayStopKey(prisma, stopKey, "stop-1")).rejects.toThrow("connection lost");
  });

  it("the helper takes no status argument, so no caller can hand it a stale one", () => {
    expect(replayStopKey.length).toBe(3);
  });
});
