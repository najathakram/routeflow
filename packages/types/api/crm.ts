// ─── CRM (GoHighLevel lead handoff) — 2026-09-11-crm-gohighlevel-handoff (WP1) ────────────────

import type { CrmConnectionStatus, CrmHandoffStatus, CrmTriggerMode } from "./enums";

/** `GET /crm/gohighlevel` response shape (spec R7). */
export interface CrmStatusResponse {
  connection: {
    status: CrmConnectionStatus;
    enabled: boolean;
    dryRun: boolean;
    triggerMode: CrmTriggerMode;
    pipelineId: string | null;
    stageId: string | null;
    stageName: string | null;
    locationId: string;
    locationName: string | null;
    tokenLast4: string | null;
    startFrom: string;
    writeBackFields: boolean;
    writeBackTag: boolean;
    writeBackNote: boolean;
    markWon: boolean;
    defaultRegion: string;
    lastPollAt: string | null;
    lastSuccessAt: string | null;
    lastError: string | null;
  } | null;
  counts: {
    pending: number;
    needsReview: number;
    created: number;
    linked: number;
    dryRun: number;
    failed: number;
  };
}

/** `PATCH /crm/gohighlevel/config` request shape (spec R4). */
export interface CrmConfigPatch {
  enabled?: boolean;
  dryRun?: boolean;
  triggerMode?: CrmTriggerMode;
  pipelineId?: string;
  stageId?: string;
  stageName?: string;
  startFrom?: string;
  writeBackFields?: boolean;
  writeBackTag?: boolean;
  writeBackNote?: boolean;
  markWon?: boolean;
  defaultRegion?: string;
}

/** One row of `GET /crm/gohighlevel/handoffs` (spec R22). */
export interface CrmHandoffRow {
  id: string;
  opportunityId: string;
  opportunityName: string | null;
  contactId: string;
  contactName: string | null;
  status: CrmHandoffStatus;
  matchedBy: string | null;
  reason: string | null;
  customerId: string | null;
  attempts: number;
  createdAt: string;
  processedAt: string | null;
}

/** `POST /crm/gohighlevel/sync` response shape — same shape `pollTenant` returns (spec R8). */
export interface CrmSyncCounts {
  fetched: number;
  new: number;
  created: number;
  linked: number;
  needsReview: number;
  dryRun: number;
  failed: number;
}

/** One entry of `GET /crm/gohighlevel/pipelines` (spec R3); stages missing `id`/`name` are dropped. */
export interface CrmPipeline {
  id: string;
  name: string;
  stages: Array<{ id: string; name: string; position: number }>;
}

/** Result of POST /crm/gohighlevel/connection/test (HTTP 200 in both outcomes). */
export interface CrmTestConnectionResult {
  ok: boolean;
  locationName?: string;
  reason?: string;
  connection: CrmStatusResponse["connection"];
}
