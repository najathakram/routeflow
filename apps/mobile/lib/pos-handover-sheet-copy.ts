/**
 * W-818 (apple-write score of the mobile counter screens): the hand-over sheet's fixed copy. Pure, so it is unit-testable
 * without React Native. The primary button always names the action it takes; a balance that is loading or failed keeps
 * the action (disabled) and the sheet's error line beside Retry says why.
 */
export const HAND_OVER_SHEET_COPY = {
  /** The cash field: what the cashier enters (it also drives the change due, W-814). */
  cashReceived: "Cash received",
  saving: "Saving…",
} as const;

export function handOverPrimaryLabel(p: {
  action: string;
  submitting: boolean;
  ready: boolean;
  nothingOwed: boolean;
}): string {
  if (p.submitting) return HAND_OVER_SHEET_COPY.saving;
  return p.ready && !p.nothingOwed ? `${p.action} and take payment` : p.action;
}
