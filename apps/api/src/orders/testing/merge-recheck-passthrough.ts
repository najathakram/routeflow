/**
 * B1053: the fold-MATH specs (b297 / b776 / promo-bogo / idempotency / fulfil-path / warn / the
 * service spec) script ONE eligibility read and a mocked tx, so they run the merge with the row guard
 * (`merge-lock-recheck.ts`: lock + under-lock re-read + guarded loser delete) passed through — it is
 * pinned on its own in `merge-lock-recheck.spec.ts` and `merge-eligibility-race-b1053.db.spec.ts`.
 * Use as: `jest.mock("./merge-lock-recheck", () => require("./testing/merge-recheck-passthrough").passthrough());`
 */
export function passthrough() {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const actual = jest.requireActual("../merge-lock-recheck");
  return {
    ...actual,
    lockAndRecheckMergeInputs: jest.fn(async () => undefined),
    deleteLoserGuarded: jest.fn(async (tx: any, id: string) => tx.order.delete({ where: { id } })),
  };
}
