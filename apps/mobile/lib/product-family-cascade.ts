import { API_ERROR_CODES } from "@routeflow/types";

/**
 * Mobile mirror of the web handling of `409 FAMILY_HAS_ACTIVE_VARIANTS`: deactivating or deleting a product family
 * that still has ACTIVE variants is refused until the caller confirms; the confirmed resend (`confirmCascade`)
 * deactivates the variants with it. The copy is fixed text built from the count, never the server `message`.
 */
export interface FamilyCascadePrompt {
  variantCount: number;
  title: string;
  body: string;
  confirmText: string;
}

/** The prompt to show, or null when `err` is anything other than that 409 (the caller shows its generic line). */
export function getFamilyCascadePrompt(err: unknown): FamilyCascadePrompt | null {
  const res = (err as { response?: { status?: number; data?: unknown } } | null)?.response;
  if (res?.status !== 409) return null;
  const data = res.data as { code?: unknown; variantCount?: unknown } | null | undefined;
  if (data?.code !== API_ERROR_CODES.FAMILY_HAS_ACTIVE_VARIANTS) return null;
  const n =
    typeof data.variantCount === "number" && data.variantCount > 0 ? data.variantCount : null;
  const what = n === null ? "active variants" : `${n} active variant${n === 1 ? "" : "s"}`;
  return {
    variantCount: n ?? 0,
    title: "Deactivate the variants too?",
    body: `This product has ${what}. Continuing deactivates them along with it.`,
    confirmText: "Deactivate all",
  };
}
