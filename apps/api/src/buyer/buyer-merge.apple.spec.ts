/**
 * Follow-up 2 on #2486: executeMerge soft-deletes the secondary BuyerAccount but used to leave its
 * `appleId` set. `BuyerAccount_appleId_key` is unique, so the stale id on a DELETED row made a later
 * Sign in with Apple for that same Apple user resolve to the deleted row (sub-first) and 500/refuse.
 * The merge now clears it (like googleId): the secondary is cleared FIRST (unique index), then the
 * primary inherits the Apple identity only when it has none.
 */
import { BuyerMergeService } from "./buyer-merge.service";

type Acct = {
  id: string;
  status: string;
  email: string;
  name: string | null;
  googleId: string | null;
  appleId: string | null;
  appleRefreshTokenEnc: string | null;
};

const acct = (over: Partial<Acct>): Acct => ({
  id: "x",
  status: "ACTIVE",
  email: "x@example.com",
  name: "X",
  googleId: null,
  appleId: null,
  appleRefreshTokenEnc: null,
  ...over,
});

function build(primary: Acct, secondary: Acct) {
  const calls: Array<{ id: string; data: Record<string, unknown> }> = [];
  const order: string[] = [];
  const tx = {
    // Row 424: the links are read inside the tx, after the decide claim.
    customerLink: { updateMany: jest.fn(), findMany: jest.fn().mockResolvedValue([]) },
    buyerAccount: {
      update: jest.fn(async (args: { where: { id: string }; data: Record<string, unknown> }) => {
        calls.push({ id: args.where.id, data: args.data });
      }),
    },
    buyerRefreshToken: { deleteMany: jest.fn() },
    // Row 424: the decide claim (compare-and-set on the status) wins.
    buyerMergeRequest: { updateMany: jest.fn().mockResolvedValue({ count: 1 }) },
  };
  const prisma = {
    buyerMergeRequest: {
      findUnique: jest.fn().mockResolvedValue({
        id: "req-1",
        status: "PENDING_REVIEW",
        primaryAccount: primary,
        secondaryAccount: secondary,
      }),
    },
    customerLink: { findMany: jest.fn().mockResolvedValue([]) },
    $transaction: jest.fn(async (fn: (t: typeof tx) => Promise<unknown>) => {
      order.push("transaction");
      return fn(tx);
    }),
  } as any;
  const email = { sendMergeCompleteEmail: jest.fn().mockResolvedValue(undefined) } as any;
  const apple = {
    revokeRefreshToken: jest.fn(async (_enc: string | null, id: string) => {
      order.push(`revoke:${id}`);
    }),
    revokeForBuyer: jest.fn(),
  } as any;
  return { service: new BuyerMergeService(prisma, email, apple), calls, apple, order, prisma };
}

describe("BuyerMergeService.executeMerge — appleId (follow-up on #2486)", () => {
  it("clears the secondary's appleId and token, then hands them to a primary that has none (secondary FIRST)", async () => {
    const { service, calls } = build(
      acct({ id: "P" }),
      acct({ id: "S", appleId: "apple-sub-S", appleRefreshTokenEnc: "enc:tok" }),
    );
    await service.executeMerge("req-1");

    const clearIdx = calls.findIndex(
      (c) => c.id === "S" && c.data.appleId === null && c.data.appleRefreshTokenEnc === null,
    );
    const giveIdx = calls.findIndex(
      (c) =>
        c.id === "P" &&
        c.data.appleId === "apple-sub-S" &&
        c.data.appleRefreshTokenEnc === "enc:tok",
    );
    expect(clearIdx).toBeGreaterThanOrEqual(0);
    expect(giveIdx).toBeGreaterThan(clearIdx); // unique index: free the id before reusing it
  });

  it("a primary that already has its own appleId keeps it; the secondary's is still cleared", async () => {
    const { service, calls } = build(
      acct({ id: "P", appleId: "apple-sub-P" }),
      acct({ id: "S", appleId: "apple-sub-S", appleRefreshTokenEnc: "enc:tok" }),
    );
    await service.executeMerge("req-1");
    expect(calls.some((c) => c.id === "S" && c.data.appleId === null)).toBe(true);
    expect(calls.some((c) => c.id === "P" && "appleId" in c.data)).toBe(false);
  });

  it("no Apple identity on the secondary: no appleId writes at all", async () => {
    const { service, calls } = build(acct({ id: "P" }), acct({ id: "S" }));
    await service.executeMerge("req-1");
    expect(calls.some((c) => "appleId" in c.data)).toBe(false);
  });

  it("the soft-delete itself never leaves the secondary with an appleId", async () => {
    const { service, calls } = build(
      acct({ id: "P", appleId: "apple-sub-P" }),
      acct({ id: "S", appleId: "apple-sub-S" }),
    );
    await service.executeMerge("req-1");
    const deleted = calls.find((c) => c.id === "S" && c.data.status === "DELETED");
    expect(deleted).toBeTruthy();
    const lastS = [...calls].reverse().find((c) => c.id === "S" && "appleId" in c.data);
    expect(lastS?.data.appleId).toBeNull();
  });
});

describe("BuyerMergeService.executeMerge — revokes the discarded Apple grant at Apple (B944)", () => {
  it("both have an Apple identity: the SECONDARY's stored token is revoked AFTER the merge commits", async () => {
    const { service, apple, order } = build(
      acct({ id: "P", appleId: "apple-sub-P" }),
      acct({ id: "S", appleId: "apple-sub-S", appleRefreshTokenEnc: "enc:tok" }),
    );
    await service.executeMerge("req-1");
    expect(apple.revokeRefreshToken).toHaveBeenCalledTimes(1);
    expect(apple.revokeRefreshToken).toHaveBeenCalledWith("enc:tok", "S");
    expect(order.indexOf("revoke:S")).toBeGreaterThan(order.indexOf("transaction"));
    expect(apple.revokeForBuyer).not.toHaveBeenCalled(); // it would read the DB after the clear
  });

  it("if the merge transaction FAILS, nothing is revoked (the secondary keeps its grant)", async () => {
    const { service, apple, prisma } = build(
      acct({ id: "P", appleId: "apple-sub-P" }),
      acct({ id: "S", appleId: "apple-sub-S", appleRefreshTokenEnc: "enc:tok" }),
    );
    prisma.$transaction.mockRejectedValueOnce(new Error("P2002"));
    await expect(service.executeMerge("req-1")).rejects.toThrow("P2002");
    expect(apple.revokeRefreshToken).not.toHaveBeenCalled();
  });

  it("the primary inherits the secondary's grant (it had none): nothing is revoked", async () => {
    const { service, apple } = build(
      acct({ id: "P" }),
      acct({ id: "S", appleId: "apple-sub-S", appleRefreshTokenEnc: "enc:tok" }),
    );
    await service.executeMerge("req-1");
    expect(apple.revokeRefreshToken).not.toHaveBeenCalled();
  });

  it("no Apple identity on the secondary: nothing is revoked", async () => {
    const { service, apple } = build(acct({ id: "P", appleId: "apple-sub-P" }), acct({ id: "S" }));
    await service.executeMerge("req-1");
    expect(apple.revokeRefreshToken).not.toHaveBeenCalled();
  });

  it("a failing revoke never fails the merge", async () => {
    const { service, apple, calls } = build(
      acct({ id: "P", appleId: "apple-sub-P" }),
      acct({ id: "S", appleId: "apple-sub-S", appleRefreshTokenEnc: "enc:tok" }),
    );
    apple.revokeRefreshToken.mockRejectedValue(new Error("apple down"));
    await expect(service.executeMerge("req-1")).resolves.toBeDefined();
    expect(calls.some((c) => c.id === "S" && c.data.status === "DELETED")).toBe(true);
  });
});
