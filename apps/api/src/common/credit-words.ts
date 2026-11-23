/**
 * SA-1211 A1.4: the api's copy of `CREDIT_WORDS` (packages/types/api/credit-words.ts). The api may not load a runtime value
 * from @routeflow/types (no-runtime-types-import.spec.ts), so it keeps this mirror, pinned set-equal to the shared map by
 * credit-words.spec.ts. Every credit word an api renderer prints (the receipt model, an email, a PDF) reads it here.
 */
export const CREDIT_WORDS_API = {
  noun: "Credit",
  balance: "Credit {amount}",
  apply: "Apply {amount} credit",
  returnGiven: "Credit given",
  kept: "Kept as credit",
} as const;
