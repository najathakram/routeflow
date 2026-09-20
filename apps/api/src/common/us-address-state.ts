import { resolveStateText } from "./us-state-resolver";
import { zip3Prefix, zip3States } from "./us-zip3";

/**
 * The ADDRESS-level resolution: a free-text `state` plus the row's `zip` -> a state code, or an
 * UNRESOLVED reason. An API-side port of the backfill's local classification with its two zip rules
 * (`classifyLocal` + `settle` in `apps/api/scripts/lib/address-state-normalize.mjs`, pinned by
 * `us-address-state.parity.spec.ts`, Google off):
 *   ZIP_CONFLICT        — the resolved code is NOT in the state set of a usable zip's ZIP3 (the zip column
 *                         OR one written inside the text): "Washington" with a DC zip, "L.A." with a CA zip;
 *   AMBIGUOUS_NEEDS_ZIP — an AMBIGUOUS text (also a city's name) with no valid CIVILIAN zip whose ZIP3
 *                         CONFIRMS the state: a blank, invalid, military or unassigned zip never confirms;
 *   EMPTY / UNPARSEABLE — nothing resolves.
 * Never a guess: a wrong `stateCode` silently changes which jurisdiction's selling rules apply.
 */
export type AddressStateReason = "EMPTY" | "UNPARSEABLE" | "ZIP_CONFLICT" | "AMBIGUOUS_NEEDS_ZIP";
export type AddressStateVerdict =
  { code: string; reason: null } | { code: null; reason: AddressStateReason };

export function resolveAddressState(
  state: string | null | undefined,
  zip: string | null | undefined,
): AddressStateVerdict {
  if (typeof state !== "string" || state.trim() === "") return { code: null, reason: "EMPTY" };
  const local = resolveStateText(state);
  if (!local) return { code: null, reason: "UNPARSEABLE" };
  const allowed = [zip, local.embeddedZip].map((z) => (zip3Prefix(z) ? zip3States(z) : null));
  if (allowed.some((a) => a !== null && !a.includes(local.code)))
    return { code: null, reason: "ZIP_CONFLICT" };
  if (local.ambiguous && !allowed.some((a) => a !== null && a.includes(local.code)))
    return { code: null, reason: "AMBIGUOUS_NEEDS_ZIP" };
  return { code: local.code, reason: null };
}
