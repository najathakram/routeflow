// ─── Customers / authorizations (wave E / imp-10b) ─────────────────────────────
//
// Names identical or near-identical between web/mobile `lib/api/{authorizations,customers,buyer}.ts`.

import type { AuthorizationSource, AuthorizationStatus } from "./enums";

export interface CustomerAuthorization {
  id: string;
  customerId: string;
  trackedCategoryId: string;
  status: AuthorizationStatus;
  source: AuthorizationSource;
  licenseNumber: string | null;
  expiresAt: string | null;
  documentKey: string | null;
  verifiedById: string | null;
  verifiedByName: string | null;
  verifiedAt: string | null;
  createdAt: string;
  updatedAt: string;
  trackedCategory: { id: string; name: string; requiresLicense: boolean };
}

/** A license expiring soon (30/7/1) or already expired. Identical on the operator
 *  header bell (web + mobile) and the buyer's own bell (mobile `buyer.ts`). */
export interface ExpiringAuthorization {
  id: string;
  customerId: string;
  customerName: string;
  trackedCategoryId: string;
  categoryName: string;
  status: "VERIFIED" | "EXPIRED";
  expiresAt: string | null;
  bucket: 30 | 7 | 1 | null;
  expired: boolean;
}

/** Near-identical: web carries `customerId`/`userId`, mobile's is a subset (both
 *  optional here so either app's response shape satisfies the type). */
export interface CustomerComment {
  id: string;
  customerId?: string;
  userId?: string;
  content: string;
  createdAt: string;
}

export interface CustomerDocument {
  id: string;
  docType: string;
  originalName: string;
  mimeType: string;
  sizeBytes: number;
  createdAt: string;
  /** Freshly presigned on every list call — safe to open directly, no auth header needed. */
  url: string;
}

export interface SubmitBuyerAuthorizationInput {
  trackedCategoryId: string;
  licenseNumber: string;
  /** ISO 8601 (@IsISO8601 server-side). */
  expiresAt: string;
  documentKey?: string;
  /** Must be true (@Equals(true) server-side). */
  shareConsent: boolean;
}
