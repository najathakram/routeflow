import { autoLockClassProtected, type AutoLockSwitch } from "./auto-lock-gate";

/**
 * Row 412 (SA-775): a dunning final notice sent BEFORE the rollout pause started must not count as "sent" once the
 * switch is unpaused again - the lock it threatened was held, the tenant's banners dropped the threat, and 24 h of
 * notice is long since used up, so the first sweep after the unpause would lock with no fresh warning.
 *
 * THE RULE. For a tenant the pause protects (`autoLockClassProtected`: not TEST / DEMO / INTERNAL), a
 * `DUNNING_FINAL` claim counts as sent only if its `sentAt` is >= U, the switch's last unpause instant
 * (`AutoLockSwitch.unpausedSince()`). Older claims are STALE: the real final goes out again with a new 24 h lead.
 *
 * THE KEYS. `BillingNotificationLog` is unique on (tenantId, milestone, key). The first final of an episode keeps
 * its key (`<invoiceId>:<pastDueSince ISO>`, so unprotected tenants and a never-paused rollout are unchanged); a
 * re-issued final is claimed under `<episode key>:u<U ISO>` - one claim per (episode, unpause), so later sweeps
 * never resend and a later pause -> unpause (a new U) re-issues exactly once more.
 */

/** Marks a final claim re-issued for one unpause instant: `<episode key>:u<U ISO>`. */
export const FINAL_REISSUE_INFIX = ":u";

/** The claim key of the final re-issued for unpause instant `unpausedAt`. */
export function finalReissueKey(episode: string, unpausedAt: Date): string {
  return `${episode}${FINAL_REISSUE_INFIX}${unpausedAt.toISOString()}`;
}

/** Is `claimKey` a final claim of THIS episode (the first one, or a re-issue)? */
export function isFinalKeyOfEpisode(claimKey: string, episode: string): boolean {
  return claimKey === episode || claimKey.startsWith(`${episode}${FINAL_REISSUE_INFIX}`);
}

/** The prefix a lookup uses to find the re-issued final claims of an episode. */
export const finalReissuePrefix = (episode: string): string => `${episode}${FINAL_REISSUE_INFIX}`;

/**
 * The unpause boundary that applies to a tenant, or null when none does: the tenant is unprotected (TEST / DEMO /
 * INTERNAL keep today's behaviour), no switch is injected (a bare unit spec), the injected switch reports no
 * boundary, or the switch is paused (the pause holds the lock; nothing is judged stale yet).
 */
export async function staleFinalBoundary(
  autoLocks: AutoLockSwitch | null | undefined,
  tenantClass: string | null | undefined,
): Promise<Date | null> {
  if (!autoLocks?.unpausedSince || !autoLockClassProtected(tenantClass)) return null;
  return autoLocks.unpausedSince();
}

/** The latest sentAt that still counts under `boundary` (null = none counts, or there is no claim). */
export function latestCountingFinal(
  claims: ReadonlyArray<{ sentAt: Date }>,
  boundary: Date | null,
): Date | null {
  let best: Date | null = null;
  for (const c of claims) {
    if (boundary && c.sentAt.getTime() < boundary.getTime()) continue;
    if (!best || c.sentAt.getTime() > best.getTime()) best = c.sentAt;
  }
  return best;
}
