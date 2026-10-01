"use client";

import * as React from "react";
import { Button, useToast } from "@routeflow/ui/web";
import { useAuth } from "@/lib/auth-context";
import { useUpdateFamilyVariants } from "@/lib/api/product-families";
import { getFamilyConflicts, familyCellKey } from "@/lib/family-conflicts";
import {
  diffVariantUpdates,
  patchRowToGridIndex,
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
  const original = React.useMemo(
    () => variants.filter((v) => v.isActive !== false).map(variantToRow),
    [variants],
  );
  const [editing, setEditing] = React.useState(false);
  const [rows, setRows] = React.useState<GridRow[]>(original);
  const [showErrors, setShowErrors] = React.useState(false);
  const [serverCells, setServerCells] = React.useState<Record<string, CellMessage>>({});
  const [summary, setSummary] = React.useState<string | null>(null);

  const canEdit = user?.role === "OPERATOR" || user?.role === "TENANT_ADMIN";
  const request = React.useMemo(() => diffVariantUpdates(original, rows), [original, rows]);
  const changed = Object.keys(request).length > 0;
  const validation = React.useMemo(() => validateRows(rows), [rows]);

  const begin = () => {
    setRows(original);
    setShowErrors(false);
    setServerCells({});
    setSummary(null);
    setEditing(true);
  };

  const cellMessages: Record<string, CellMessage> = { ...serverCells };
  if (showErrors) {
    for (const [i, fields] of Object.entries(validation.rows)) {
      for (const [field, message] of Object.entries(fields ?? {})) {
        cellMessages[`${i}:${field}`] = { message: message as string };
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

  const save = () => {
    setShowErrors(true);
    setSummary(null);
    if (!changed || !validation.valid) return;
    const sent = request;
    const sentRows = rows;
    update.mutate(sent, {
      onSuccess: () => {
        toast({ title: "Variants saved", variant: "success" });
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
          setSummary(conflicts.summary);
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
    <div className="space-y-3" data-testid="family-variants-editor">
      <div className="flex items-center justify-between gap-2">
        <h3 className="text-sm font-semibold text-navy">Variants</h3>
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
      {summary && (
        <p role="alert" className="rounded bg-danger-bg px-3 py-2 text-sm text-danger">
          {summary}
        </p>
      )}
      {showErrors && validation.formError && (
        <p role="alert" className="text-sm text-danger">
          {validation.formError}
        </p>
      )}
      <FamilyVariantsGrid
        rows={editing ? rows : original}
        onChange={onRowsChange}
        cellMessages={editing ? cellMessages : {}}
        readOnly={!editing}
        disabled={update.isPending}
      />
    </div>
  );
}
