// ─── Tenant time zone resolver context (SA-738r) ────────────────────────────────
//
// The API resolves a tenant's IANA zone through ONE function (`resolveZone` in
// apps/api/src/common/tenant-time-zone.ts). Every caller hands it a context object, never a
// positional tenant id, so adding a dimension later (a per-location zone) is a compile-safe, small
// diff. `locationId` is the documented seam: accepted and IGNORED in v1.

export interface ZoneContext {
  tenantId: string;
  /** Reserved for per-location zones. Accepted and ignored in v1. */
  locationId?: string;
}

export interface ResolvedZone {
  /** A valid IANA zone. */
  zone: string;
  /** True when the stored value was missing or invalid and the UTC fallback was used. */
  fallback: boolean;
}
