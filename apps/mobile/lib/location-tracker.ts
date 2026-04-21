// TypeScript type-stub — Metro overrides this with .native.ts or .web.ts at bundle time.
export interface StartTrackingResult {
  ok: boolean;
  reason?: "platform" | "permission";
}

export async function startLocationTracking(_runId: string): Promise<StartTrackingResult> {
  return { ok: false, reason: "platform" };
}

export async function stopLocationTracking(): Promise<void> {
  // no-op
}

export async function isTracking(): Promise<boolean> {
  return false;
}
