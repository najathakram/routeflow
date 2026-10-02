// ─── Per-tenant POLICY layer (SA-138 phase 1) ──────────────────────────────────
//
// Request/response shapes for `/policies` (apps/api/src/policy/policy.controller.ts). The
// registry itself lives server-side in apps/api/src/policy/policy-registry.ts; clients render
// from `GET /policies`, never from a hand-copied key list.

import type { PolicyScopeTypeValue } from "./enums";

export type PolicyKindValue = "enum" | "money" | "set";

/** A policy value as stored/served: an enum string, a money number (or null), or a set array. */
export type PolicyJsonValue = string | number | null | string[];

/** One stored `PolicyValue` row (active or superseded). Dates are ISO strings on the wire. */
export interface PolicyValueRow {
  id: string;
  key: string;
  scopeType: PolicyScopeTypeValue;
  scopeId: string | null;
  value: PolicyJsonValue;
  reason: string;
  setById: string | null;
  setByName: string | null;
  createdAt: string;
  supersededAt: string | null;
  supersededById: string | null;
}

/** One registry entry plus its tenant's active rows — `GET /policies` element. */
export interface PolicyDescriptor {
  key: string;
  area: string;
  kind: PolicyKindValue;
  /** JSON-schema of the value (the admin UI maps `kind` → control and validates with this). */
  schema: Record<string, unknown>;
  default: PolicyJsonValue;
  scopes: PolicyScopeTypeValue[];
  description: string;
  added: string;
  pilotPending: boolean;
  /** Active (non-superseded) rows for this tenant, one per scope target at most. */
  active: PolicyValueRow[];
}

export interface PoliciesResponse {
  policies: PolicyDescriptor[];
}

/** `PUT /policies/:key` body. `scopeId` is required for CATEGORY/CUSTOMER, forbidden for TENANT. */
export interface SetPolicyRequest {
  scopeType: PolicyScopeTypeValue;
  scopeId?: string | null;
  value: PolicyJsonValue;
  reason: string;
}

/** `DELETE /policies/:key?scopeType=&scopeId=` body. */
export interface ClearPolicyRequest {
  reason: string;
}

/** `PUT` / `DELETE` response: the row written (set) or the row superseded (clear). */
export interface PolicyWriteResponse {
  row: PolicyValueRow;
}

/** `GET /policies/:key/history`: superseded rows, newest first. */
export interface PolicyHistoryResponse {
  key: string;
  history: PolicyValueRow[];
}
