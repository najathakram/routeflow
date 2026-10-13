/**
 * Pure regulated-authorization helpers + types (no api-client import, so they
 * stay unit-testable). The hooks live in lib/api/authorizations.ts, which
 * re-exports everything here.
 */

/**
 * CQ-06: the ONE sentence for a license refusal (expired / none on file + the next step), shared with web through
 * `@routeflow/types` so the strings cannot drift. A fallback that has no guard modal to open uses it instead of a raw
 * server message. SUBPATH import: jest stubs the types package ROOT and resolves this subpath to source (jest.config.js).
 */
export { regulatedAuthCopy, regulatedAuthErrorCopy } from "@routeflow/types/regulated-auth-copy";

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

/** The override-reason options — kept BYTE-IDENTICAL to web's LicenseGuardModal
 *  OVERRIDE_REASONS (the reason is a free string server-side, but drifted
 *  vocabularies make the audit trail read as two different policies). */
export const OVERRIDE_REASONS = [
  "License on file but not yet recorded",
  "Verbal confirmation from customer",
  "Time-sensitive / emergency order",
  "Other",
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
