/**
 * SA-773 row 333(b): the parked-reversal resolve retries a deadlock or serialization conflict (the whole transaction is
 * idempotent: its claim is a CAS on resolvedAt) and, when the retries are exhausted, answers a coded, retryable 503
 * LOCK_UNAVAILABLE (nothing saved), never the raw 40P01 as an uncoded 500. Its lock order (Return, then Order) is unchanged:
 * it is the house order the pooled refund mint now follows.
 */
import { ServiceUnavailableException } from "@nestjs/common";
import { ParkedReversalResolutionService } from "./parked-reversal-resolution.service";
import { createMockPrisma } from "../testing/prisma-mock";

describe("ParkedReversalResolutionService.resolve: the retry backstop (row 333b)", () => {
  let prisma: ReturnType<typeof createMockPrisma>;
  let service: ParkedReversalResolutionService;
  const settled = { alreadyResolved: true as const, row: { resolvedEntryId: "rev-1" } };

  beforeEach(() => {
    prisma = createMockPrisma();
    service = new ParkedReversalResolutionService(prisma as any, {} as any);
  });
  const conflict = (code: string) => Object.assign(new Error("deadlock detected"), { code });
  const resolve = () => service.resolve("pr-1", 12, "operator checked the box", { id: "u-op" });

  it("a deadlock on the first attempt is retried and the resolve completes", async () => {
    prisma.tenantTransaction
      .mockRejectedValueOnce(conflict("40P01"))
      .mockResolvedValueOnce(settled);
    await expect(resolve()).resolves.toMatchObject({
      alreadyResolved: true,
      resolvedEntryId: "rev-1",
    });
    expect(prisma.tenantTransaction).toHaveBeenCalledTimes(2);
  });

  it.each(["40P01", "40001", "P2034"])(
    "a %s on every attempt gives up after 3 with a coded 503 LOCK_UNAVAILABLE",
    async (code) => {
      prisma.tenantTransaction.mockRejectedValue(conflict(code));
      const err: any = await resolve().then(
        () => null,
        (e) => e,
      );
      expect(err).toBeInstanceOf(ServiceUnavailableException);
      expect(err.getResponse()).toMatchObject({ code: "LOCK_UNAVAILABLE" });
      expect(prisma.tenantTransaction).toHaveBeenCalledTimes(3);
    },
  );
});
