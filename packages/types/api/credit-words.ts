/**
 * SA-1211 A1.4: one word for credit, on every screen and document the staff, the buyer and the paper read. The owner's
 * answer (11-22): "Credit". The old names ("Store credit", "in wallet", "Unallocated (→ advance)", "Advance balance") are
 * retired; credit-words.census.test.ts (web) and credit-words.census.spec.ts (api) fail on any of them in a renderer
 * string outside their allow-lists, which shrink as each site's PR lands. `{amount}` is the formatted money.
 *
 * The api may not load a runtime value from this package (no-runtime-types-import.spec.ts), so it keeps
 * CREDIT_WORDS_API in apps/api/src/common/credit-words.ts, pinned set-equal to this map by credit-words.spec.ts.
 */
export const CREDIT_WORDS = {
  noun: "Credit",
  balance: "Credit {amount}",
  apply: "Apply {amount} credit",
  /** the outcome line of a recorded return: the credit stays on the customer's account */
  returnGiven: "Credit given",
  /** a payment received above what was allocated: the excess stays on the account as credit */
  kept: "Kept as credit",
} as const;

export type CreditWordKey = keyof typeof CREDIT_WORDS;
