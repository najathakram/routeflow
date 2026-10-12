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
  categoryName?: unknown;
  reason?: unknown;
}

function asBlocked(input: unknown): BlockedLike[] {
  if (!Array.isArray(input)) return [];
  return input.filter((b): b is BlockedLike => !!b && typeof b === "object");
}

function namesOf(blocked: BlockedLike[]): string[] {
  const out: string[] = [];
  for (const b of blocked) {
    if (typeof b.categoryName !== "string") continue;
    const name = b.categoryName.trim();
    if (!SAFE_CATEGORY_NAME.test(name) || out.includes(name)) continue;
    out.push(name);
    if (out.length === MAX_NAMES) break;
  }
  return out;
}

/** The sentence for a `blockedCategories` list (any shape: an empty / missing / malformed list gets the nameless line). */
export function regulatedAuthCopy(blockedCategories?: unknown): string {
  const blocked = asBlocked(blockedCategories);
  const names = namesOf(blocked);
  const items = names.length > 0 ? `regulated items (${names.join(", ")})` : "regulated items";
  const allExpired = blocked.length > 0 && blocked.every((b) => b.reason === "EXPIRED");
  const noneOnFile = blocked.length > 0 && blocked.every((b) => b.reason === "NO_AUTH");
  if (allExpired)
    return `This sale includes ${items}, and the customer's license has expired. Renew it on the customer's Licenses tab, then try again.`;
  if (noneOnFile)
    return `This sale includes ${items}, and the customer has no verified license on file. Add it on the customer's Licenses tab, or choose a customer who has one, then try again.`;
  return `This sale includes ${items} that need a valid license on file for the customer. Add or renew it on the customer's Licenses tab, then try again.`;
}

/** The sentence for a thrown axios-style error when it IS the 409 license refusal, else null. */
export function regulatedAuthErrorCopy(err: unknown): string | null {
  const res = (
    err as
      | { response?: { status?: number; data?: { code?: unknown; blockedCategories?: unknown } } }
      | null
      | undefined
  )?.response;
  if (res?.status !== 409 || res.data?.code !== API_ERROR_CODES.REGULATED_AUTH_REQUIRED)
    return null;
  return regulatedAuthCopy(res.data.blockedCategories);
}
