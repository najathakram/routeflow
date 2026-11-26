/**
 * SA-1507 (the history-import tenant contract): the GUARDED tables of the QuickBooks history import. Each one has a
 * `<Model>_tenant_guard` BEFORE INSERT OR UPDATE OR DELETE row trigger on the shared `legacy_import_tenant_guard()`
 * function (migration 20261126000000_legacy_import_stage1): a write lands only in the transaction's session tenant
 * (`app.current_tenant_id`), and none lands when no session tenant is set.
 *
 * Every later `Legacy*` table (A5, Sitting 2) joins this list, gets its own trigger line and a composite (tenantId, id)
 * FK to its guarded parent. `common/import-history-guard.pin.spec.ts` (P6) is red until it does. A plain, frozen list of
 * names: no runtime import from Prisma, so a script or a pin can read it without the client.
 */
export const IMPORT_HISTORY_MODELS = Object.freeze([
  "LegacyImportBatch",
  "LegacyImportFile",
  "LegacyImportIssue",
  "LegacySalesDocument",
  "LegacySalesLine",
  "SourceItemAlias",
] as const);

export type ImportHistoryModel = (typeof IMPORT_HISTORY_MODELS)[number];
