/**
 * executeMerge soft-deletes the secondary BuyerAccount (status DELETED). Its outstanding reset and
 * verification links must die in the SAME transaction as that write
 * (`common/revoke-user-link-tokens.ts`); the surviving primary keeps its own links.
 */
import { BuyerMergeService } from "./buyer-merge.service";

const acct = (id: string) => ({
  id,
  status: "ACTIVE",
  email: `${id}@example.com`,
  name: id,
  googleId: null,
  appleId: null,
  appleRefreshTokenEnc: null,
});

function build() {
  const order: string[] = [];
  const tx = {
    customerLink: { updateMany: jest.fn() },
    buyerAccount: {
      update: jest.fn(async (args: { data: Record<string, unknown> }) => {
        order.push(args.data.status === "DELETED" ? "secondary.deleted" : "buyerAccount.update");
      }),
    },
    buyerRefreshToken: { deleteMany: jest.fn() },
    buyerMergeRequest: { update: jest.fn() },
    $executeRaw: jest.fn(async (strings: TemplateStringsArray, id: string) => {
      order.push(`burn:${/UPDATE "(\w+)"/.exec(strings.join(""))![1]}:${id}`);
      return 1;
    }),
  };
  const prisma = {
    buyerMergeRequest: {
      findUnique: jest.fn().mockResolvedValue({
        id: "req-1",
        status: "PENDING_REVIEW",
        primaryAccount: acct("P"),
        secondaryAccount: acct("S"),
      }),
    },
    customerLink: { findMany: jest.fn().mockResolvedValue([]) },
    $transaction: jest.fn(async (fn: (t: typeof tx) => Promise<void>) => fn(tx)),
  } as any;
  const email = { sendMergeCompleteEmail: jest.fn().mockResolvedValue(undefined) } as any;
  const apple = { revokeRefreshToken: jest.fn(), revokeForBuyer: jest.fn() } as any;
  return { service: new BuyerMergeService(prisma, email, apple), tx, order, prisma };
}

describe("BuyerMergeService.executeMerge — link revocation", () => {
  it("burns the secondary's reset and verification links inside the merge transaction", async () => {
    const { service, order, prisma } = build();

    await service.executeMerge("req-1");

    expect(prisma.$transaction).toHaveBeenCalledTimes(1);
    expect(order).toEqual(
      expect.arrayContaining([
        "burn:BuyerPasswordResetToken:S",
        "burn:BuyerEmailVerificationToken:S",
      ]),
    );
    // after the soft-delete write, inside the same transaction callback
    expect(order.indexOf("burn:BuyerPasswordResetToken:S")).toBeGreaterThan(
      order.indexOf("secondary.deleted"),
    );
  });

  it("never touches the surviving primary's links", async () => {
    const { service, tx } = build();

    await service.executeMerge("req-1");

    const ids = tx.$executeRaw.mock.calls.map((c: any[]) => c[1]);
    expect(ids).toEqual(["S", "S"]);
  });

  it("a failed burn fails the merge (the soft-delete rolls back with it)", async () => {
    const { service, tx } = build();
    tx.$executeRaw.mockRejectedValue(new Error("db down"));

    await expect(service.executeMerge("req-1")).rejects.toThrow("db down");
  });
});
