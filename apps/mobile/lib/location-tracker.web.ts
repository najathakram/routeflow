// Web stub. Background location is a native-only feature; on web we report
// the sharing intent to nothing and never attempt to call expo-location
// (whose internals don't ship a web build for the version on this SDK).

export interface StartTrackingResult {
  ok: boolean;
  reason?: "platform" | "permission";
}

export async function startLocationTracking(_runId: string): Promise<StartTrackingResult> {
  return { ok: false, reason: "platform" };
}

export async function stopLocationTracking(): Promise<void> {
  // no-op on web
}

export async function isTracking(): Promise<boolean> {
  return false;
}
