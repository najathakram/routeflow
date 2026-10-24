/**
 * SA-775 (row 381): what the "End trial" confirmation toasts once `POST /billing/subscription/cancel` answers.
 * While the platform pauses automatic locks the server records the request instead of locking the workspace at
 * once and answers `{ cancelled: "trial_recorded" }`; the toast then says so, in neutral words, instead of
 * "Trial ended". Any other answer keeps today's copy. A pure function: the body is read defensively.
 */
export function endTrialToast(result: unknown): { title: string; description?: string } {
  const cancelled = (result as { cancelled?: unknown } | null | undefined)?.cancelled;
  if (cancelled === "trial_recorded") {
    return {
      title: "Request received",
      description:
        "We've recorded your request to end the trial. Your workspace stays as it is for now.",
    };
  }
  return { title: "Trial ended" };
}
