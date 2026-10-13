import { API_ERROR_CODES } from "./api/error-codes";

/**
 * CQ-06: the ONE sentence for the regulated-sale license refusal (409 `REGULATED_AUTH_REQUIRED`), shared by web
 * (the generic toast, the counter) and mobile so the strings cannot drift. The server blocks a sale line whose
 * tracked category `requiresLicense` when the CUSTOMER has no VERIFIED, unexpired authorization (and no active
 * override): the body carries `blockedCategories: [{ categoryName, reason: "NO_AUTH" | "EXPIRED" }]`.
 *
 * The copy says what is wrong (expired / none on file) and the next step, and names the item group from the
 * STRUCTURED `categoryName` only when it passes a conservative text check - never the server's `message`, and
 * never a formula-led, over-long or markup-bearing string (the same discipline as `safe-text-error-copy`).
 *
 * Pure: no React, no DOM, no network. Web re-uses it through `lib/generic-toast-copy.ts` and `lib/counter-sale.ts`;
 * mobile through `lib/authorizations-logic.ts`.
 */

/** A name worth showing: starts alphanumeric, short, plain punctuation only (no `= + - @`, no markup). */
const SAFE_CATEGORY_NAME = /^[A-Za-z0-9][A-Za-z0-9 &'.,()/-]{0,39}$/;
const MAX_NAMES = 3;

interface BlockedLike {
  trackedCategoryId?: unknown;
  categoryName?: unknown;
  reason?: unknown;
}

export interface RegulatedAuthCopyOptions {
  /**
   * The sale is to the system walk-in (the counter's anonymous buyer). A walk-in has no Licenses tab to fix, so the
   * only next step is to choose a customer who holds a valid license.
   */
  walkIn?: boolean;
}

function asBlocked(input: unknown): BlockedLike[] {
  if (!Array.isArray(input)) return [];
  return input.filter((b): b is BlockedLike => !!b && typeof b === "object");
}

/** The shown names (safe, de-duplicated, at most three) and how many blocked categories are NOT named. */
function describeNames(blocked: BlockedLike[]): { names: string[]; more: number } {
  const names: string[] = [];
  const seen = new Set<string>();
  for (const b of blocked) {
    const id = typeof b.trackedCategoryId === "string" ? b.trackedCategoryId : "";
    const raw = typeof b.categoryName === "string" ? b.categoryName.trim() : "";
    seen.add(`${id}|${raw}`);
    if (SAFE_CATEGORY_NAME.test(raw) && !names.includes(raw) && names.length < MAX_NAMES) {
      names.push(raw);
    }
  }
  return { names, more: Math.max(0, seen.size - names.length) };
}

/**
 * The sentence for a `blockedCategories` list (any shape: an empty / missing / malformed list gets the nameless line).
 * A name that is filtered out, or beyond the third, is counted ("and 2 more"), never silently dropped.
 */
export function regulatedAuthCopy(
  blockedCategories?: unknown,
  options: RegulatedAuthCopyOptions = {},
): string {
  const blocked = asBlocked(blockedCategories);
  const { names, more } = describeNames(blocked);
  const list = names.length > 0 ? `${names.join(", ")}${more > 0 ? ` and ${more} more` : ""}` : "";
  const items = list ? `regulated items (${list})` : "regulated items";
  if (options.walkIn)
    return `This sale includes ${items}, which need a customer with a valid license. Choose a customer who has a valid license, then try again.`;
  const allExpired = blocked.length > 0 && blocked.every((b) => b.reason === "EXPIRED");
  const noneVerified = blocked.length > 0 && blocked.every((b) => b.reason === "NO_AUTH");
  if (allExpired)
    return `This sale includes ${items}, and the customer's license has expired. Renew it on the customer's Licenses tab, then try again.`;
  // NO_AUTH is the guard's reason for every non-VERIFIED status (none, pending review, rejected, already expired).
  if (noneVerified)
    return `This sale includes ${items}, and the customer has no verified license on file. Add, verify or renew it on the customer's Licenses tab, or choose a customer who has one, then try again.`;
  return `This sale includes ${items} that need a valid license on file for the customer. Add, verify or renew it on the customer's Licenses tab, then try again.`;
}

/** The sentence for a thrown axios-style error when it IS the 409 license refusal, else null. */
export function regulatedAuthErrorCopy(
  err: unknown,
  options: RegulatedAuthCopyOptions = {},
): string | null {
  const res = (
    err as
      | { response?: { status?: number; data?: { code?: unknown; blockedCategories?: unknown } } }
      | null
      | undefined
  )?.response;
  if (res?.status !== 409 || res.data?.code !== API_ERROR_CODES.REGULATED_AUTH_REQUIRED)
    return null;
  return regulatedAuthCopy(res.data.blockedCategories, options);
}
