"use client";

import * as React from "react";
import { AlertTriangle, ChevronDown, ChevronUp, Download } from "lucide-react";
import { Button, Card, useToast } from "@routeflow/ui/web";
import {
  useRegulatedReportPreview,
  fetchRegulatedReportCsv,
  type RegulatedReportParams,
} from "@/lib/api/tracked-categories";
import { presetRange, type ReportRangePreset } from "@/lib/regulated-format";

const TEMPLATE_OPTIONS = ["TX_COMPTROLLER", "GENERIC", "CA_CDTFA", "CA_ABC", "CALRECYCLE"];

const PRESETS: { value: ReportRangePreset; label: string }[] = [
  { value: "last-month", label: "Last month" },
  { value: "this-month", label: "This month" },
  { value: "last-quarter", label: "Last quarter" },
  { value: "year-to-date", label: "Year to date" },
];

const inputCls =
  "w-full rounded border border-surface-border px-3 py-2 text-sm text-navy focus:outline-none focus:ring-2 focus:ring-brand-500 disabled:bg-surface-raised disabled:text-navy/50";

/** Filename-safe slug — used only for the client-built download filename, doesn't
 *  need to byte-match the server's `<category-slug>-<template>-<from>-<to>.csv`. */
function slugify(s: string): string {
  return (
    s
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/(^-+|-+$)/g, "") || "report"
  );
}

interface Props {
  categoryId: string;
  categoryName: string;
  /** The category's own `reportTemplate`, shown as the "Category default" option. */
  categoryDefaultTemplate: string;
}

/**
 * Arbitrary-range regulated report: preview in-app (server-computed JSON, WP11's
 * `GET /regulated/reports/preview`) or download the same data as CSV
 * (`GET /regulated/reports/csv`). Nothing here is persisted — this is separate from
 * the "Prepare filing" flow, which stays the period-keyed compliance archive.
 */
export function RegulatedReportPanel({ categoryId, categoryName, categoryDefaultTemplate }: Props) {
  const { toast } = useToast();

  const [preset, setPreset] = React.useState<ReportRangePreset | "custom">("last-month");
  const [range, setRange] = React.useState(() => presetRange("last-month"));
  const [template, setTemplate] = React.useState<string>("");
  const [previewParams, setPreviewParams] = React.useState<RegulatedReportParams | null>(null);
  const [warningsExpanded, setWarningsExpanded] = React.useState(false);
  const [downloading, setDownloading] = React.useState(false);

  const handlePresetChange = (value: string) => {
    if (value === "custom") {
      setPreset("custom");
      return;
    }
    const p = value as ReportRangePreset;
    setPreset(p);
    setRange(presetRange(p));
  };

  const currentParams: RegulatedReportParams = {
    category: categoryId,
    from: range.from,
    to: range.to,
    ...(template ? { template } : {}),
  };

  const preview = useRegulatedReportPreview(previewParams);

  const validateRange = () => {
    if (!range.from || !range.to) {
      toast({ title: "Pick a start and end date", variant: "error" });
      return false;
    }
    if (range.from > range.to) {
      toast({ title: "The start date must be on or before the end date", variant: "error" });
      return false;
    }
    return true;
  };

  const handlePreview = () => {
    if (!validateRange()) return;
    setWarningsExpanded(false);
    setPreviewParams(currentParams);
  };

  const handleDownload = async () => {
    if (!validateRange()) return;
    setDownloading(true);
    try {
      // Never window.open the CSV endpoint directly — it needs the auth header, so
      // the bytes are fetched through the authenticated client and downloaded from
      // an in-memory blob URL instead.
      const blob = await fetchRegulatedReportCsv(currentParams);
      const blobUrl = URL.createObjectURL(blob);
      const usedTemplate = template || preview.data?.template || categoryDefaultTemplate;
      const a = document.createElement("a");
      a.href = blobUrl;
      a.download = `${slugify(categoryName)}-${slugify(usedTemplate)}-${range.from}-${range.to}.csv`;
      a.rel = "noopener noreferrer";
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(blobUrl), 60_000);
    } catch {
      toast({
        title: "Couldn't download the report",
        description: "Please try again.",
        variant: "error",
      });
    } finally {
      setDownloading(false);
    }
  };

  const report = preview.data;
  const warnings = report?.warnings ?? [];
  const visibleWarnings = warningsExpanded ? warnings : warnings.slice(0, 5);

  return (
    <Card title="Reports">
      <div className="flex flex-wrap items-end gap-3">
        <div>
          <label className="mb-1 block text-xs font-medium text-navy">Range</label>
          <select
            value={preset}
            onChange={(e) => handlePresetChange(e.target.value)}
            className={inputCls}
          >
            {PRESETS.map((p) => (
              <option key={p.value} value={p.value}>
                {p.label}
              </option>
            ))}
            <option value="custom">Custom</option>
          </select>
        </div>
        <div>
          <label className="mb-1 block text-xs font-medium text-navy">From</label>
          <input
            type="date"
            value={range.from}
            disabled={preset !== "custom"}
            onChange={(e) => setRange((r) => ({ ...r, from: e.target.value }))}
            className={inputCls}
          />
        </div>
        <div>
          <label className="mb-1 block text-xs font-medium text-navy">To</label>
          <input
            type="date"
            value={range.to}
            disabled={preset !== "custom"}
            onChange={(e) => setRange((r) => ({ ...r, to: e.target.value }))}
            className={inputCls}
          />
        </div>
        <div>
          <label className="mb-1 block text-xs font-medium text-navy">Template</label>
          <select
            value={template}
            onChange={(e) => setTemplate(e.target.value)}
            className={inputCls}
          >
            <option value="">Category default ({categoryDefaultTemplate})</option>
            {TEMPLATE_OPTIONS.map((t) => (
              <option key={t} value={t}>
                {t}
              </option>
            ))}
          </select>
        </div>
        <div className="flex gap-2">
          <Button variant="secondary" loading={preview.isFetching} onClick={handlePreview}>
            Preview
          </Button>
          <Button
            variant="secondary"
            leftIcon={<Download className="h-4 w-4" />}
            loading={downloading}
            onClick={handleDownload}
          >
            Download CSV
          </Button>
        </div>
      </div>

      {preview.isError && (
        <p className="mt-4 text-sm text-red-600">
          Couldn&apos;t load the preview. Check the date range and try again.
        </p>
      )}

      {report && (
        <div className="mt-4 space-y-3">
          {warnings.length > 0 && (
            <div className="rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-800">
              <div className="flex items-center gap-2 font-medium">
                <AlertTriangle className="h-4 w-4" />
                {warnings.length} {warnings.length === 1 ? "warning" : "warnings"}
              </div>
              <ul className="mt-1.5 list-disc space-y-0.5 pl-5">
                {visibleWarnings.map((w, i) => (
                  <li key={i}>{w.message}</li>
                ))}
              </ul>
              {warnings.length > 5 && (
                <button
                  type="button"
                  onClick={() => setWarningsExpanded((v) => !v)}
                  className="mt-1.5 inline-flex items-center gap-1 text-xs font-medium text-amber-700 hover:underline"
                >
                  {warningsExpanded ? (
                    <>
                      <ChevronUp className="h-3.5 w-3.5" /> Show fewer
                    </>
                  ) : (
                    <>
                      <ChevronDown className="h-3.5 w-3.5" /> Show all {warnings.length}
                    </>
                  )}
                </button>
              )}
            </div>
          )}

          {report.rows.length === 0 ? (
            <p className="rounded-lg border border-dashed border-surface-border bg-surface-raised/40 px-4 py-8 text-center text-sm text-navy/60">
              No regulated sales in this range.
            </p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-surface-border text-left text-xs text-navy/60">
                    {report.columns.map((col) => (
                      <th
                        key={col.key}
                        className={`py-2 pr-3 font-medium${col.align === "right" ? " text-right" : ""}`}
                      >
                        {col.label}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {report.rows.map((row, i) => (
                    <tr key={i} className="border-b border-surface-border/60 last:border-0">
                      {row.map((cell, j) => (
                        <td
                          key={j}
                          className={`py-2 pr-3 text-navy${
                            report.columns[j]?.align === "right" ? " text-right tabular-nums" : ""
                          }`}
                        >
                          {cell}
                        </td>
                      ))}
                    </tr>
                  ))}
                </tbody>
                {report.totalsRow && (
                  <tfoot>
                    <tr className="border-t border-surface-border font-medium text-navy">
                      {report.totalsRow.map((cell, j) => (
                        <td
                          key={j}
                          className={`py-2 pr-3${
                            report.columns[j]?.align === "right" ? " text-right tabular-nums" : ""
                          }`}
                        >
                          {cell}
                        </td>
                      ))}
                    </tr>
                  </tfoot>
                )}
              </table>
            </div>
          )}

          {report.displayTotals.length > 0 && (
            <div className="flex flex-wrap gap-4 border-t border-surface-border pt-3">
              {report.displayTotals.map((t) => (
                <div key={t.label}>
                  <p className="text-xs text-navy/60">{t.label}</p>
                  <p className="text-sm font-semibold text-navy">{t.value}</p>
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </Card>
  );
}
