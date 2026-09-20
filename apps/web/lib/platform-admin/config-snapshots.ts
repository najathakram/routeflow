// Tenant "Configuration snapshots" API client (Lane B A2 step c) — plain async functions over
// `superAdminClient`, the same shape as ./features.ts. Types are the shared wire contract.
import { superAdminClient } from "@/lib/admin-api";
import type {
  ConfigSnapshotListItem,
  ConfigSnapshotPreview,
  ConfigSnapshotRestoreResult,
} from "@routeflow/types";

const base = (tenantId: string) => `/platform-admin/tenants/${tenantId}/config-snapshots`;

/** `GET …/config-snapshots` — newest first, restored/superseded ones included. */
export async function fetchConfigSnapshots(tenantId: string): Promise<ConfigSnapshotListItem[]> {
  const res = await superAdminClient.get<ConfigSnapshotListItem[]>(base(tenantId));
  return res.data;
}

/** `GET …/config-snapshots/:id/preview` — writes nothing. */
export async function previewConfigSnapshotRestore(
  tenantId: string,
  snapshotId: string,
): Promise<ConfigSnapshotPreview> {
  const res = await superAdminClient.get<ConfigSnapshotPreview>(
    `${base(tenantId)}/${snapshotId}/preview`,
  );
  return res.data;
}

/** `POST …/config-snapshots/:id/restore` — "Restore now" (409 if already restored). */
export async function restoreConfigSnapshot(
  tenantId: string,
  snapshotId: string,
): Promise<ConfigSnapshotRestoreResult> {
  const res = await superAdminClient.post<ConfigSnapshotRestoreResult>(
    `${base(tenantId)}/${snapshotId}/restore`,
  );
  return res.data;
}
