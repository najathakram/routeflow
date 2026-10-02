"use client";

/**
 * B858/B859 (FIX5) — shared CSV-import panel: pick a file → Preview (dryRun) → review the plan
 * (per-row action/changes/reason, warnings, unknown columns, a blocking gate error) → Import
 * (the same endpoint with dryRun=false) → the same renderer shows the final counts.
 *
 * One renderer for one result shape (cause-ruling.md §2.C) — used by both the settings/import
 * Products/Customers cards and the customers-page ImportCustomersModal.
 */

import * as React from "react";
import { Upload, AlertCircle, CheckCircle2, ChevronDown, ChevronUp } from "lucide-react";
import { cn, useToast } from "@routeflow/ui/web";
import type { ImportColumnAlias } from "@routeflow/types";
import { apiClient } from "@/lib/api-client";

interface ImportRowPlan {
  row: number;
  label: string;
  action: "create" | "update" | "skip";
  /** field -> { from, to }; `from` is null on a create. */
  changes?: Record<string, { from: unknown; to: unknown }>;
  reason?: string;
  warnings?: string[];
}

export interface ImportCsvResult {
  imported?: number;
  created?: number;
  updated?: number;
  unchanged?: number;
  skipped?: number;
  errors: string[];
  rows: ImportRowPlan[];
  skippedRows: { row: number; label: string; reason: string }[];
  warnings: string[];
  unknownColumns: string[];
  dryRun: boolean;
}

export interface ImportCsvPanelProps {
  /** API path, e.g. "/import/products" or "/import/contacts". */
  endpoint: string;
  /** Display title used in toasts and headings, e.g. "Products". */
  title: string;
  /** Accepted-column help (canonical header + its aliases) — from PRODUCT/CUSTOMER_IMPORT_COLUMNS. */
  columns: ImportColumnAlias[];
  /** Fired once after a successful (non-dry-run) import. */
  onImported?: (result: ImportCsvResult) => void;
  /** Namespaces data-testid hooks when more than one panel renders on the same page. Defaults to a
   *  slug derived from `endpoint`. */
  testIdPrefix?: string;
}

function slugify(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function summarize(result: ImportCsvResult): string {
  const parts: string[] = [];
  if (result.created !== undefined) parts.push(`${result.created} created`);
  if (result.updated !== undefined) parts.push(`${result.updated} updated`);
  if (result.unchanged) parts.push(`${result.unchanged} unchanged`);
  if (result.skipped) parts.push(`${result.skipped} skipped`);
  if (parts.length === 0 && result.imported !== undefined) {
    parts.push(`${result.imported} imported`);
  }
  return parts.join(", ") || "Done";
}

const ACTION_STYLES: Record<ImportRowPlan["action"], string> = {
  create: "text-success bg-success-bg",
  update: "text-brand-600 bg-brand-50",
  skip: "text-warning bg-warning-bg",
};

function ActionBadge({ action }: { action: ImportRowPlan["action"] }) {
  return (
    <span
      className={cn(
        "inline-flex items-center rounded-full px-2 py-0.5 text-[11px] font-semibold uppercase tracking-wide",
        ACTION_STYLES[action],
      )}
    >
      {action}
    </span>
  );
}

function formatCell(value: unknown): string {
  if (value === null || value === undefined || value === "") return "—";
  if (typeof value === "string")
    return value.length >= 10 && !isNaN(Date.parse(value)) && /^\d{4}-\d{2}-\d{2}/.test(value)
      ? value.slice(0, 10)
      : value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return JSON.stringify(value);
}

function ChangesCell({ changes }: { changes?: Record<string, { from: unknown; to: unknown }> }) {
  if (!changes || Object.keys(changes).length === 0) {
    return <span className="text-navy/40">—</span>;
  }
  return (
    <ul className="space-y-0.5">
      {Object.entries(changes).map(([field, { from, to }]) => (
        <li key={field} className="whitespace-nowrap">
          <span className="font-medium text-navy/70">{field}</span>{" "}
          <span className="font-mono text-navy/50">{formatCell(from)}</span>
          <span className="text-navy/40"> → </span>
          <span className="font-mono text-navy">{formatCell(to)}</span>
        </li>
      ))}
    </ul>
  );
}

function ResultTable({ result, testIdPrefix }: { result: ImportCsvResult; testIdPrefix: string }) {
  return (
    <div className="overflow-x-auto rounded-lg border border-surface-border">
      <table
        data-testid={`${testIdPrefix}-results-table`}
        className="w-full min-w-[560px] text-left text-xs"
      >
        <thead className="bg-surface-raised text-[11px] uppercase tracking-wide text-navy/50">
          <tr>
            <th className="px-3 py-2 font-semibold">Row</th>
            <th className="px-3 py-2 font-semibold">Name</th>
            <th className="px-3 py-2 font-semibold">Action</th>
            <th className="px-3 py-2 font-semibold">Changes</th>
            <th className="px-3 py-2 font-semibold">Reason</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-surface-border bg-white">
          {result.rows.map((r) => (
            <tr key={r.row} data-testid={`${testIdPrefix}-row-${r.row}`}>
              <td className="px-3 py-2 font-mono text-navy/50">{r.row}</td>
              <td className="max-w-[180px] truncate px-3 py-2 text-navy" title={r.label}>
                {r.label}
              </td>
              <td className="px-3 py-2">
                <ActionBadge action={r.action} />
              </td>
              <td className="px-3 py-2">
                <ChangesCell changes={r.changes} />
              </td>
              <td className="px-3 py-2 text-navy/70">
                {r.reason ?? ""}
                {r.warnings && r.warnings.length > 0 && (
                  <ul className="mt-0.5 text-warning">
                    {r.warnings.map((w, i) => (
                      <li key={i}>⚠ {w}</li>
                    ))}
                  </ul>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function ImportCsvPanel({
  endpoint,
  title,
  columns,
  onImported,
  testIdPrefix,
}: ImportCsvPanelProps) {
  const { toast } = useToast();
  const prefix = testIdPrefix ?? `import-${slugify(endpoint)}`;
  const [file, setFile] = React.useState<File | null>(null);
  const [preview, setPreview] = React.useState<ImportCsvResult | null>(null);
  const [final, setFinal] = React.useState<ImportCsvResult | null>(null);
  const [loading, setLoading] = React.useState<"preview" | "import" | null>(null);
  const [gateError, setGateError] = React.useState<string | null>(null);
  const [showColumns, setShowColumns] = React.useState(false);
  const inputRef = React.useRef<HTMLInputElement>(null);

  const pickFile = (f: File | null | undefined) => {
    if (!f) return;
    setFile(f);
    setPreview(null);
    setFinal(null);
    setGateError(null);
  };

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault();
    const f = e.dataTransfer.files?.[0];
    if (f && f.name.endsWith(".csv")) pickFile(f);
  };

  const resetFile = () => {
    setFile(null);
    setPreview(null);
    setFinal(null);
    setGateError(null);
    if (inputRef.current) inputRef.current.value = "";
  };

  const run = async (dryRun: boolean) => {
    if (!file) return;
    setLoading(dryRun ? "preview" : "import");
    if (dryRun) setGateError(null);
    try {
      const formData = new FormData();
      formData.append("file", file);
      const res = await apiClient.post(`${endpoint}?dryRun=${dryRun}`, formData, {
        headers: { "Content-Type": "multipart/form-data" },
        timeout: 300_000, // 5 min for large files
      });
      const data = res.data as ImportCsvResult;
      if (dryRun) {
        setPreview(data);
      } else {
        setFinal(data);
        onImported?.(data);
        toast({ title: `${title} imported`, description: summarize(data), variant: "success" });
      }
    } catch (err: any) {
      if (err?.response?.status === 403) {
        setGateError(err?.response?.data?.message ?? "This column needs an add-on to import");
        setPreview(null);
      } else {
        toast({
          title: dryRun ? "Preview failed" : "Import failed",
          description:
            err?.response?.data?.message ?? "Please check your file format and try again",
          variant: "error",
        });
      }
    } finally {
      setLoading(null);
    }
  };

  const active = final ?? preview;

  return (
    <div className="space-y-3">
      {/* Accepted columns help */}
      <div className="rounded-lg border border-surface-border">
        <button
          type="button"
          data-testid={`${prefix}-columns-toggle`}
          onClick={() => setShowColumns((v) => !v)}
          className="flex w-full items-center justify-between px-3 py-2 text-xs font-medium text-navy/70"
        >
          <span>Accepted columns ({columns.length})</span>
          {showColumns ? (
            <ChevronUp className="h-3.5 w-3.5" />
          ) : (
            <ChevronDown className="h-3.5 w-3.5" />
          )}
        </button>
        {showColumns && (
          <ul
            data-testid={`${prefix}-columns-help`}
            className="space-y-1 border-t border-surface-border px-3 py-2 text-xs text-navy/70"
          >
            {columns.map((c) => (
              <li key={c.field}>
                <span className="font-medium text-navy">{c.canonical}</span>
                {c.aliases.length > 1 && (
                  <span className="text-navy/40">
                    {" "}
                    (also: {c.aliases.filter((a) => a !== c.canonical).join(", ")})
                  </span>
                )}
              </li>
            ))}
          </ul>
        )}
      </div>

      {/* Drop zone */}
      <div
        onDrop={handleDrop}
        onDragOver={(e) => e.preventDefault()}
        onClick={() => inputRef.current?.click()}
        className={cn(
          "flex cursor-pointer flex-col items-center justify-center gap-2 rounded-lg border-2 border-dashed p-6 transition-colors min-h-[96px]",
          file
            ? "border-brand-300 bg-brand-50"
            : "border-surface-border hover:border-brand-300 hover:bg-brand-50/30",
        )}
      >
        <input
          ref={inputRef}
          data-testid={`${prefix}-file-input`}
          type="file"
          accept=".csv"
          className="hidden"
          onChange={(e) => pickFile(e.target.files?.[0])}
        />
        <Upload className={cn("h-6 w-6", file ? "text-brand-500" : "text-navy/30")} />
        {file ? (
          <div className="text-center">
            <p className="text-sm font-medium text-brand-600">{file.name}</p>
            <p className="text-xs text-navy/70">
              {(file.size / 1024).toFixed(1)} KB · Click to change
            </p>
          </div>
        ) : (
          <div className="text-center">
            <p className="text-sm text-navy/70">
              Drop CSV file here or <span className="text-brand-500">browse</span>
            </p>
          </div>
        )}
      </div>

      {/* Actions */}
      <div className="flex gap-2">
        <button
          type="button"
          data-testid={`${prefix}-preview-button`}
          onClick={() => run(true)}
          disabled={!file || loading !== null}
          className="flex-1 rounded-lg border border-brand-300 py-2 text-sm font-medium text-brand-600 hover:bg-brand-50 disabled:opacity-40 transition-colors"
        >
          {loading === "preview" ? "Previewing…" : "Preview"}
        </button>
        <button
          type="button"
          data-testid={`${prefix}-import-button`}
          onClick={() => run(false)}
          disabled={!file || loading !== null || !preview || !!gateError || !!final}
          className="flex-1 rounded-lg bg-brand-500 py-2 text-sm font-medium text-white hover:bg-brand-600 disabled:opacity-40 transition-colors"
        >
          {loading === "import" ? "Importing…" : `Import ${title}`}
        </button>
        {(final || gateError) && (
          <button
            type="button"
            data-testid={`${prefix}-reset-button`}
            onClick={resetFile}
            className="rounded-lg border border-surface-border px-3 py-2 text-sm text-navy hover:bg-surface-raised transition-colors"
          >
            Choose another file
          </button>
        )}
      </div>

      {/* Gate refusal — blocking, no retry-without-the-column affordance (FIX5) */}
      {gateError && (
        <div
          data-testid={`${prefix}-gate-error`}
          role="alert"
          className="flex items-start gap-2 rounded-lg border border-danger/40 bg-danger-bg/50 px-3 py-2.5 text-sm text-danger"
        >
          <AlertCircle className="h-4 w-4 mt-0.5 shrink-0" />
          <span>{gateError}</span>
        </div>
      )}

      {/* Summary */}
      {active && (
        <div
          data-testid={`${prefix}-summary`}
          className={cn(
            "flex items-center gap-2 rounded-lg border px-3 py-2 text-sm",
            final
              ? "border-success/30 bg-success-bg/50 text-success"
              : "border-brand-200 bg-brand-50 text-brand-700",
          )}
        >
          <CheckCircle2 className="h-4 w-4 shrink-0" />
          <span>
            {final ? "Import complete — " : "Preview — "}
            {summarize(active)}
          </span>
        </div>
      )}

      {/* Unknown columns — "not imported" */}
      {active && active.unknownColumns.length > 0 && (
        <div
          data-testid={`${prefix}-unknown-columns`}
          className="rounded-lg border border-surface-border bg-surface-raised px-3 py-2 text-xs text-navy/70"
        >
          <p className="font-medium text-navy/70">Not imported (unrecognized column):</p>
          <p className="mt-0.5">{active.unknownColumns.join(", ")}</p>
        </div>
      )}

      {/* Warnings */}
      {active && active.warnings.length > 0 && (
        <div
          data-testid={`${prefix}-warnings`}
          className="rounded-lg border border-warning/30 bg-warning-bg/50 px-3 py-2 text-xs text-warning"
        >
          <ul className="space-y-0.5">
            {active.warnings.map((w, i) => (
              <li key={i}>⚠ {w}</li>
            ))}
          </ul>
        </div>
      )}

      {/* I4: skipped rows + raw error strings — a dedicated, always-visible surface. `rows`
          (below) already carries a "skip" badge + reason per row, but skippedRows/errors are
          rendered directly too so nothing that reached either array is only reachable via the
          "N skipped" summary count. */}
      {active && active.skippedRows.length > 0 && (
        <div
          data-testid={`${prefix}-skipped-rows`}
          className="rounded-lg border border-warning/30 bg-warning-bg/50 px-3 py-2 text-xs text-warning"
        >
          <p className="font-medium">Skipped rows:</p>
          <ul className="mt-0.5 space-y-0.5">
            {active.skippedRows.map((r) => (
              <li key={r.row}>
                Row {r.row} ({r.label}): {r.reason}
              </li>
            ))}
          </ul>
        </div>
      )}
      {active && active.errors.length > 0 && (
        <div
          data-testid={`${prefix}-errors`}
          className="rounded-lg border border-danger/30 bg-danger-bg/50 px-3 py-2 text-xs text-danger"
        >
          <ul className="space-y-0.5">
            {active.errors.map((e, i) => (
              <li key={i}>{e}</li>
            ))}
          </ul>
        </div>
      )}

      {/* Row-level plan table */}
      {active && active.rows.length > 0 && <ResultTable result={active} testIdPrefix={prefix} />}
    </div>
  );
}
