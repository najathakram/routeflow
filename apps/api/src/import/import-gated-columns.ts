import type { ImportColumnRequirement, ImportSkippedColumn } from "@routeflow/types";
import { normalizeHeader, type ColumnDef, type ResolvedColumns } from "./import-columns";

/** The entitlement gate keys a product column can carry (`ColumnDef.gate`). */
export type ImportColumnGate = NonNullable<ColumnDef["gate"]>;

/** What each gate key needs, as the result names it. */
export const IMPORT_GATE_REQUIREMENT: Record<ImportColumnGate, ImportColumnRequirement> = {
  msrp: "MSRP",
  tobacco: "TOBACCO_DEALER",
  forecasting: "FORECASTING",
};

/** Longest `column` a skipped entry carries: a header is the user's own text, data only (B987-E). */
export const SKIPPED_COLUMN_MAX = 120;

/**
 * SA-1193 K1 (B1377): ask every gate whose column the file carries, with no short-circuit, before any row is parsed.
 *
 * - A genuine denial drops every field behind that gate from a COPY of `byField`, so `parseRow` never reads, diffs or
 *   writes it. Each header in the file that maps to a denied field is named once, in file order, aliases and duplicates
 *   included (`resolveColumns` keeps only the first header per field).
 * - Anything that is not a denial (an outage) is rethrown and refuses the whole file, as before.
 * - The per-row service walls are untouched: an absent field is never sent to create() or update().
 */
export async function skipDeniedGatedColumns(
  headers: string[],
  resolved: ResolvedColumns,
  registry: ColumnDef[],
  asks: Record<ImportColumnGate, () => Promise<void>>,
  isDenial: (e: unknown) => boolean,
): Promise<{ resolved: ResolvedColumns; skippedColumns: ImportSkippedColumn[] }> {
  const present = new Set<ImportColumnGate>();
  for (const col of registry) {
    if (col.gate && resolved.byField[col.field]) present.add(col.gate);
  }

  const denied = new Set<ImportColumnGate>();
  for (const gate of present) {
    try {
      await asks[gate]();
    } catch (e) {
      if (!isDenial(e)) throw e;
      denied.add(gate);
    }
  }
  if (denied.size === 0) return { resolved, skippedColumns: [] };

  const byField = { ...resolved.byField };
  const deniedKeys = new Map<string, ImportColumnRequirement>();
  for (const col of registry) {
    if (!col.gate || !denied.has(col.gate)) continue;
    delete byField[col.field];
    for (const alias of col.aliases) {
      deniedKeys.set(normalizeHeader(alias), IMPORT_GATE_REQUIREMENT[col.gate]);
    }
  }

  const skippedColumns: ImportSkippedColumn[] = [];
  const skippedHeaders = new Set<string>();
  for (const header of headers) {
    const requires = deniedKeys.get(normalizeHeader(header));
    if (!requires) continue;
    skippedHeaders.add(header);
    skippedColumns.push({ column: header.slice(0, SKIPPED_COLUMN_MAX), requires });
  }

  return {
    resolved: {
      byField,
      unknownColumns: resolved.unknownColumns.filter((h) => !skippedHeaders.has(h)),
    },
    skippedColumns,
  };
}
