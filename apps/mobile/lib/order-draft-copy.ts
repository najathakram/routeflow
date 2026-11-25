/** Row 699 (699-preread): what the operator is told when they leave Create Order and the order stays parked as a draft. */
export const DRAFT_SAVED_ON_LEAVE = "Draft saved. Find it in Orders.";

export type ResumeFailKind = "items" | "failed" | "denied";

/** W-1424: what a failed resume tells the operator. "denied" (a role 403) has no Retry: it cannot help. */
export function resumeFailureCopy(kind: ResumeFailKind) {
  if (kind === "denied") {
    const body = "Ask a manager to finish this order.";
    return { title: "You can't see this customer's prices", body, canRetry: false };
  }
  const body =
    kind === "failed"
      ? "Prices didn't load. Try again in a moment."
      : "Some items couldn't be loaded. Check your connection and try again.";
  return { title: "Couldn't restore your order", body, canRetry: true };
}
