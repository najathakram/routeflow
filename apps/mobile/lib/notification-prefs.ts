/**
 * B04 (train 2, cause-ruling.md §2/§3, D2): binds the operator Settings →
 * Push notifications switch to the existing generic per-user preference
 * store (`UserPreference`, `GET/PATCH /users/me/preferences` — the same
 * store `locale` already uses on web) under the key `pushEnabled`. No
 * migration, no new model.
 *
 * The server is the authoritative gate (notifications.service.ts skips
 * delivery + no-ops registration for a disabled user), so a stale client
 * can't re-enable delivery — this module is what lets the mobile client
 * itself avoid the round-trip when it already knows the answer.
 */
import { apiClient } from "./api-client";

const PUSH_ENABLED_KEY = "pushEnabled" as const;

/** Missing row (never toggled) reads as ENABLED — this is an opt-out. */
export async function getPushEnabled(): Promise<boolean> {
  const { data } = await apiClient.get<Record<string, string>>("/users/me/preferences");
  return data?.[PUSH_ENABLED_KEY] !== "false";
}

export async function setPushEnabled(enabled: boolean): Promise<void> {
  await apiClient.patch("/users/me/preferences", {
    [PUSH_ENABLED_KEY]: enabled ? "true" : "false",
  });
}
