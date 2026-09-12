/**
 * CRM (GoHighLevel) status enums — re-exported from `@prisma/client` now that WP1 has landed
 * the schema. Superseded the TP2 skeleton's plain-string unions (kept until the migration
 * existed so tests never imported a not-yet-generated Prisma enum).
 */

import type { GoHighLevelClient } from "./gohighlevel/gohighlevel.client";

export type { CrmConnectionStatus, CrmTriggerMode, CrmHandoffStatus } from "@prisma/client";

/**
 * GHL wire shapes live on the client; re-exported here so specs and services import one
 * module for every CRM type (F2 — two specs already import these three from this file).
 */
export type { GhlContact, GhlOpportunity, GhlCustomField } from "./gohighlevel/gohighlevel.client";

/** The minimum of a `CrmConnection` row needed to build a correctly-scoped client (F4). */
export interface GhlConnectionCreds {
  secretCipher?: string | null;
  locationId: string;
}

/**
 * Injectable per-tenant client factory. Every service that talks to GoHighLevel for a
 * specific tenant resolves its client through this — never through a shared, empty-creds
 * singleton (F4).
 */
export interface GhlClientFactory {
  forConnection(connection: GhlConnectionCreds): GoHighLevelClient;
}

/** DI token for {@link GhlClientFactory} (provided by `crm.module.ts`). */
export const GHL_CLIENT_FACTORY = "GHL_CLIENT_FACTORY";
