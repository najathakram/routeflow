/**
 * Pure regulated-authorization helpers + types (no api-client import, so they
 * stay unit-testable). The hooks live in lib/api/authorizations.ts, which
 * re-exports everything here.
 */

export type AuthorizationStatus = "NONE" | "PENDING_REVIEW" | "VERIFIED" | "EXPIRED" | "REJECTED";

/** One category blocking a regulated sale, from the 409 REGULATED_AUTH_REQUIRED body. */
export interface BlockedCategory {
  trackedCategoryId: string;
  categoryName: string;
  reason: "NO_AUTH" | "EXPIRED";
}

export interface CreateAuthorizationInput {
  trackedCategoryId: string;
  licenseNumber?: string;
  /** Full ISO 8601 — convert a YYYY-MM-DD field via new Date(text).toISOString(). */
  expiresAt?: string;
  documentKey?: string;
}

export interface CreateOverrideInput {
  trackedCategoryId: string;
  reason: string;
  /** "ORDER:<orderId>" (order exists) or "UNTIL:<iso>" (pre-create, +24h). */
  scope: string;
  /** The operator types the business name to acknowledge responsibility (§8). */
  acknowledgedTenant: string;
}

/**
 * Detects the server's regulated-sale block. Returns the blocked categories, or
 * null when this isn't a REGULATED_AUTH_REQUIRED error.
 */
export function parseRegulatedAuthError(err: unknown): BlockedCategory[] | null {
  const res = (
    err as {
      response?: {
        status?: number;
        data?: { code?: string; blockedCategories?: BlockedCategory[] };
      };
    }
  )?.response;
  if (res?.status === 409 && res.data?.code === "REGULATED_AUTH_REQUIRED") {
    return res.data.blockedCategories ?? [];
  }
  return null;
}

/** The override-reason options (mirror web's OVERRIDE_REASONS). */
export const OVERRIDE_REASONS = [
  "Existing customer, license on file offline",
  "License renewal in progress",
  "Verbal confirmation from management",
  "Other (see acknowledgement)",
] as const;

/**
 * ORDER-scope when the order already exists, else a 24h UNTIL window. Getting
 * this backwards would either expire an order override after 24h or leak a
 * time-boxed override into an unrelated order — so it's locked by a test.
 */
export function overrideScope(orderId: string | undefined, now: number): string {
  return orderId
    ? `ORDER:${orderId}`
    : `UNTIL:${new Date(now + 24 * 60 * 60 * 1000).toISOString()}`;
}
