/**
 * F03 slice 2 (SA-1096): unit-spec stand-in for the interactive transaction a link claim runs in.
 * `$transaction(cb)` runs `cb` against the mock itself, with `$queryRaw` answering the locked account read.
 * The real proof of "one winner" is `auth/link-claims.db.spec.ts`; these only pin the shape of the writes.
 */
export interface LockedAccount {
  status: string;
  deletedAt: Date | null;
}

export function mockClaimTransaction(
  prisma: { $transaction: unknown },
  account: LockedAccount | null = { status: "ACTIVE", deletedAt: null },
): void {
  (prisma.$transaction as jest.Mock).mockImplementation((cb: (tx: unknown) => unknown) =>
    cb({ ...prisma, $queryRaw: jest.fn().mockResolvedValue(account ? [account] : []) }),
  );
}
