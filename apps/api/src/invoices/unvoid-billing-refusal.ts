/**
 * SA-814d: the 409 ORDER_BILLING_CHANGED an unvoid answers with. `reason` is the machine-readable part (clients pick
 * copy from it, never by string match); `message` is the same copy for clients that show the server message.
 * Literal copies of `ORDER_BILLING_CHANGED_REASONS` / `UNVOID_BILLING_COPY` in `@routeflow/types` (the API never
 * value-imports that package), pinned equal by `unvoid-billing-refusal-parity.spec.ts`.
 */
export const UNVOID_REFUSAL_REASONS = {
  OTHER_INVOICE: "OTHER_INVOICE",
  LINE_REDUCED: "LINE_REDUCED",
} as const;

export type UnvoidRefusalReason =
  (typeof UNVOID_REFUSAL_REASONS)[keyof typeof UNVOID_REFUSAL_REASONS];

export const UNVOID_REFUSAL_COPY: Record<UnvoidRefusalReason, string> = {
  OTHER_INVOICE: "Another invoice now bills these items. Void it first.",
  LINE_REDUCED:
    "The order line now holds less than this invoice bills. Raise the order line, or create a new invoice from the order.",
};
