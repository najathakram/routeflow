"use client";

import * as React from "react";
import { Button, useToast } from "@routeflow/ui/web";
import { useAuth } from "@/lib/auth-context";
import { useUpdateFamilyVariants } from "@/lib/api/product-families";
import { getFamilyConflicts, familyCellKey } from "@/lib/family-conflicts";
import {
  CANNOT_CLEAR_MSG,
  MAX_FAMILY_ROWS,
  diffVariantUpdates,
  patchRowToGridIndex,
  requestRowCount,
  validateRows,
  type GridRow,
} from "@/lib/family-grid";
import { FamilyVariantsGrid, type CellMessage } from "./FamilyVariantsGrid";

export interface FamilyVariantSource {
  id: string;
  name: string;
  variantName?: string | null;
  sku?: string | null;
  barcode?: string | null;
  unitSku?: string | null;
  unitsPerBox?: number | null;
  pricePerUnit: string | number;
  standardCost?: string | number | null;
  isActive?: boolean;
}

const str = (v: unknown) => (v == null ? "" : String(v));

export function variantToRow(v: FamilyVariantSource): GridRow {
  return {
    key: v.id,
    id: v.id,
    name: v.variantName ?? v.name,
    sku: str(v.sku),
    barcode: str(v.barcode),
    unitSku: str(v.unitSku),
    unitsPerBox: str(v.unitsPerBox),
    pricePerUnit: str(v.pricePerUnit),
    standardCost: str(v.standardCost),
  };
}

/**
 * WS8: the family detail's variants — read-only until "Edit variants", then the shared grid. Save sends
 * ONE all-or-nothing PATCH (changed fields only; removed rows are deactivated, new rows added); a refused
 * write marks every conflicting cell, mapped back to the grid row that produced it.
 */
export function FamilyVariantsEditor({
  familyId,
  variants,
}: {
  familyId: string;
  variants: FamilyVariantSource[];
}) {
  const { user } = useAuth();
  const { toast } = useToast();
  const update = useUpdateFamilyVariants(familyId);
  // K13 F18: /products/<family>?variant=<id> (Create with a parent) brings that variant row into view.
  const [focusId, setFocusId] = React.useState<string | undefined>();
  React.useEffect(() => {
    setFocusId(new URLSearchParams(window.location.search).get("variant") ?? undefined);
  }, []);
  const live = React.useMemo(
    () => variants.filter((v) => v.isActive !== false).map(variantToRow),
    [variants],
  );
  const [editing, setEditing] = React.useState(false);
  // Taken when Edit is clicked: a refetch mid-edit must not make a variant added elsewhere look removed.
  const [baseline, setBaseline] = React.useState<GridRow[]>(live);
  const original = editing ? baseline : live;
  const [rows, setRows] = React.useState<GridRow[]>(live);
  const [showErrors, setShowErrors] = React.useState(false);
  const [serverCells, setServerCells] = React.useState<Record<string, CellMessage>>({});
  const [summary, setSummary] = React.useState<string | null>(null);
  const [unmapped, setUnmapped] = React.useState(false);

  const canEdit = user?.role === "OPERATOR" || user?.role === "TENANT_ADMIN";
  const request = React.useMemo(() => diffVariantUpdates(original, rows), [original, rows]);
  const changed = Object.keys(request).length > 0;
  const validation = React.useMemo(
    () => validateRows(rows, { original: baseline, capRows: false }),
    [rows, baseline],
  );

  const begin = () => {
    setBaseline(live);
    setRows(live);
    setShowErrors(false);
    setServerCells({});
    setSummary(null);
    setEditing(true);
  };

  const cellMessages: Record<string, CellMessage> = { ...serverCells };
  {
    // "Can't be cleared" shows at once: an emptied cell sends nothing, so Save would stay disabled and the
    // operator would never learn why. Every other rule waits for a Save attempt.
    for (const [i, fields] of Object.entries(validation.rows)) {
      for (const [field, message] of Object.entries(fields ?? {})) {
        if (showErrors || message === CANNOT_CLEAR_MSG) {
          cellMessages[`${i}:${field}`] = { message: message as string };
        }
      }
    }
  }

  const onRowsChange = (next: GridRow[]) => {
    setServerCells((prev) => {
      const out = { ...prev };
      for (const key of Object.keys(prev)) {
        const [i, field] = key.split(":");
        const before = rows[Number(i)];
        const after = next[Number(i)];
        if (!before || !after || before[field as keyof GridRow] !== after[field as keyof GridRow])
          delete out[key];
      }
      return out;
    });
    setRows(next);
  };

  const cancel = () => {
    setEditing(false);
    setShowErrors(false);
    setServerCells({});
    setSummary(null);
    setUnmapped(false);
  };

  const [tooMany, setTooMany] = React.useState(false);
  const save = () => {
    setShowErrors(true);
    setSummary(null);
    setTooMany(false);
    if (!changed || !validation.valid) return;
    if (requestRowCount(request) > MAX_FAMILY_ROWS) {
      setTooMany(true);
      return;
    }
    const sent = request;
    const sentRows = rows;
    update.mutate(sent, {
      onSuccess: () => {
        toast({
          title: `Variants saved (${sent.add?.length ?? 0} added, ${sent.update?.length ?? 0} changed)`,
          variant: "success",
        });
        setEditing(false);
        setServerCells({});
      },
      onError: (err) => {
        const conflicts = getFamilyConflicts(err);
        if (conflicts?.kind === "ROWS") {
          const mapped: Record<string, CellMessage> = {};
          for (const [key, msg] of Object.entries(conflicts.cells)) {
            const [row, field] = key.split(":");
            const gi = patchRowToGridIndex(Number(row), sent, sentRows);
            if (gi != null) mapped[familyCellKey(gi, field as never)] = msg;
          }
          setServerCells(mapped);
          // A row that maps to no cell must not leave a silent failure: say so, whatever the cell count.
          const unmatched = Object.keys(mapped).length === 0;
          setUnmapped(unmatched);
          setSummary(
            unmatched
              ? "Nothing was saved. A conflicting row could not be matched to a cell. Reload the page and try again."
              : conflicts.summary,
          );
          return;
        }
        if (conflicts?.kind === "PRICE_AUTHORITY") {
          toast({
            title: "Prices are set on the family",
            description: "Change the family price to change its variants' prices.",
            variant: "error",
          });
          return;
        }
        if (conflicts?.kind === "NOT_FOUND") {
          toast({ title: "This family no longer exists.", variant: "error" });
          return;
        }
        toast({ title: "Couldn't save the variants. Please try again.", variant: "error" });
      },
    });
  };

  return (
    <div
      className="space-y-3 rounded-lg border border-surface-border bg-white p-5 shadow-card"
      data-testid="family-variants-editor"
    >
      <div className="flex items-center justify-between gap-2">
        <h3 className="text-[11px] font-semibold uppercase tracking-[0.08em] text-navy/70">
          Variants
        </h3>
        {canEdit && !editing && (
          <Button size="sm" variant="secondary" onClick={begin}>
            Edit variants
          </Button>
        )}
        {editing && (
          <div className="flex gap-2">
            <Button
              size="sm"
              variant="secondary"
              onClick={() => setEditing(false)}
              disabled={update.isPending}
            >
              Cancel
            </Button>
            <Button size="sm" onClick={save} disabled={!changed} loading={update.isPending}>
              Save variants
            </Button>
          </div>
        )}
      </div>
      {editing && tooMany && (
        <p role="alert" className="text-sm text-danger">
          A single save takes up to {MAX_FAMILY_ROWS} changes. Save in smaller batches.
        </p>
      )}
      {editing && summary && (unmapped || Object.keys(serverCells).length > 0) && (
        <p role="alert" className="rounded bg-danger-bg px-3 py-2 text-sm text-danger">
          {summary}
        </p>
      )}
      {editing && showErrors && validation.formError && (
        <p role="alert" className="text-sm text-danger">
          {validation.formError}
        </p>
      )}
      <FamilyVariantsGrid
        focusId={focusId}
        rows={editing ? rows : live}
        showCostHint={false}
        maxRows={Infinity}
        onChange={onRowsChange}
        cellMessages={editing ? cellMessages : {}}
        readOnly={!editing}
        disabled={update.isPending}
      />
    </div>
  );
}
