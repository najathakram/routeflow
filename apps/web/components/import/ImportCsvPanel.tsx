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
import { genericToastCopy } from "@/lib/generic-toast-copy";
import {
  IMPORT_LOST_CONTACT_COPY,
  importJobErrorCopy,
  importRefusalCopy,
} from "@/lib/import-job-copy";

/** A 400 (unreadable / malformed file) or a 413 (too large) says what to fix; anything else is the shared generic copy. */
const FILE_PROBLEM_COPY =
  "The file couldn't be read. Check that it is a CSV that follows the template, and split a very large file into smaller ones.";
function importFailureCopy(err: unknown): string {
  const status = (err as { response?: { status?: number } } | null)?.response?.status;
  return status === 400 || status === 413 ? FILE_PROBLEM_COPY : genericToastCopy(err);
}
import { Upload, AlertCircle, CheckCircle2, ChevronDown, ChevronUp } from "lucide-react";
import { cn, useToast } from "@routeflow/ui/web";
import type { ImportColumnAlias } from "@routeflow/types";
import type { ImportFamilyRowInfo, ImportFamilySummary } from "@routeflow/types";
import { apiClient } from "@/lib/api-client";

interface ImportRowPlan {
  row: number;
  label: string;
  action: "create" | "update" | "skip";
  /** field -> { from, to }; `from` is null on a create. */
  changes?: Record<string, { from: unknown; to: unknown }>;
  reason?: string;
  warnings?: string[];
  /** SA-823: the family detail of a row that carried a Family cell. */
  family?: ImportFamilyRowInfo;
}

/** The running counts a queued import keeps in its progress data. */
interface JobCounts {
  created: number;
  updated: number;
  unchanged: number;
  skipped: number;
}

/** GET /import/products/jobs/:id */
interface JobStatus {
  id: string;
  state: "queued" | "running" | "done" | "failed";
  progress: number;
  counts?: JobCounts;
  result?: ImportCsvResult;
  /** A closed code (B980): the page maps it to fixed copy and never prints server text. */
  errorCode?: string;
}

/** What the panel shows for a large apply that the server queued (SA-823 section 5). */
interface JobView {
  jobId: string;
  rows: number;
  state: JobStatus["state"];
  progress: number;
  counts?: JobCounts;
  errorCode?: string;
  /** The page stopped hearing from the job: it may still be running. */
  lostContact?: boolean;
}

/** What the page treats as the result when a finished job did not bring one. */
const EMPTY_RESULT: ImportCsvResult = {
  errors: [],
  rows: [],
  skippedRows: [],
  warnings: [],
  unknownColumns: [],
  dryRun: false,
};

/** How often a queued import is asked how far it got. */
const JOB_POLL_MS = 2000;
/** Poll failures in a row before the page stops waiting. */
const JOB_MAX_MISSES = 5;

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
  /** SA-823: the family block of a file with a Family column. */
  families?: ImportFamilySummary;
  /** SA-823: set INSTEAD of a result when the server queued a large apply. */
  queued?: { jobId: string; rows: number };
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

function summarize(
  result: Pick<ImportCsvResult, "created" | "updated" | "unchanged" | "skipped" | "imported">,
): string {
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

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/** The family part of the preview and of the result: what groups, what is new, what moves, what was left out. */
function FamilyBlock({
  summary,
  done,
  testIdPrefix,
}: {
  summary: ImportFamilySummary;
  done: boolean;
  testIdPrefix: string;
}) {
  const lines: string[] = [];
  if (summary.grouped > 0) {
    lines.push(
      done
        ? `${plural(summary.grouped, "product joined", "products joined")} a family`
        : `${plural(summary.grouped, "product", "products")} will join a family`,
    );
  }
  if (summary.newVariants > 0) {
    lines.push(
      done
        ? `${plural(summary.newVariants, "new item was", "new items were")} added to families`
        : `${plural(summary.newVariants, "new item", "new items")} will be added to families`,
    );
  }
  if (summary.moves > 0) {
    lines.push(
      done
        ? `${plural(summary.moves, "product moved", "products moved")} to another family`
        : `${plural(summary.moves, "product", "products")} will move to another family`,
    );
  }
  const removed = summary.deactivated ?? [];
  const stuck = summary.cleanupFailed ?? [];
  const nothing =
    lines.length === 0 &&
    summary.familiesToCreate.length === 0 &&
    summary.skipsByReason.length === 0 &&
    removed.length === 0 &&
    stuck.length === 0;
  if (nothing) return null;
  return (
    <div
      data-testid={`${testIdPrefix}-families`}
      className="rounded-lg border border-surface-border bg-white px-3 py-2 text-xs text-navy/80"
    >
      <p className="font-medium text-navy">Families</p>
      {summary.familiesToCreate.length > 0 && (
        <p data-testid={`${testIdPrefix}-families-new`} className="mt-1">
          {done ? "New families: " : "New families to create: "}
          {summary.familiesToCreate
            .map((f) => `${f.name} (${plural(f.rows, "item", "items")})`)
            .join(", ")}
        </p>
      )}
      {lines.length > 0 && (
        <ul className="mt-1 space-y-0.5">
          {lines.map((l) => (
            <li key={l}>{l}</li>
          ))}
        </ul>
      )}
      {summary.skipsByReason.length > 0 && (
        <div data-testid={`${testIdPrefix}-families-skips`} className="mt-1">
          <p className="text-navy/70">Left out:</p>
          <ul className="space-y-0.5">
            {summary.skipsByReason.map((s) => (
              <li key={s.reason}>
                {s.reason} ({s.count})
              </li>
            ))}
          </ul>
        </div>
      )}
      {removed.length > 0 && (
        <p data-testid={`${testIdPrefix}-families-removed`} className="mt-1 text-warning">
          No item could be saved, so we took these new families out again:{" "}
          {removed.map((f) => f.name).join(", ")}
        </p>
      )}
      {stuck.length > 0 && (
        <p data-testid={`${testIdPrefix}-families-stuck`} role="alert" className="mt-1 text-danger">
          These families were created but couldn&apos;t be removed. Remove them in the product
          editor: {stuck.map((f) => f.name).join(", ")}
        </p>
      )}
    </div>
  );
}

/** A queued import: how far it got while it runs, and what it did if it stopped. */
function JobBanner({
  job,
  testIdPrefix,
  bannerRef,
}: {
  job: JobView;
  testIdPrefix: string;
  bannerRef: React.RefObject<HTMLDivElement | null>;
}) {
  if (job.state === "done") return null;
  const so_far = job.counts ? summarize(job.counts) : null;
  if (job.state === "failed") {
    return (
      <div
        ref={bannerRef}
        tabIndex={-1}
        data-testid={`${testIdPrefix}-job`}
        role="alert"
        className="rounded-lg border border-danger/40 bg-danger-bg/50 px-3 py-2.5 text-sm text-danger focus:outline-none focus-visible:ring-2 focus-visible:ring-danger/40"
      >
        {job.lostContact ? (
          <p className="font-medium">{IMPORT_LOST_CONTACT_COPY}</p>
        ) : (
          <>
            <p className="font-medium">The import stopped before it finished.</p>
            <p className="mt-0.5">{importJobErrorCopy(job.errorCode)}</p>
          </>
        )}
        {so_far && <p className="mt-0.5">Saved before it stopped: {so_far}.</p>}
        {!job.lostContact && <p className="mt-0.5">Re-running the same file is safe.</p>}
      </div>
    );
  }
  return (
    <div
      ref={bannerRef}
      tabIndex={-1}
      data-testid={`${testIdPrefix}-job`}
      className="rounded-lg border border-brand-200 bg-brand-50 px-3 py-2.5 text-sm text-brand-700 focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-300"
    >
      <p className="font-medium">Importing {plural(job.rows, "row", "rows")} in the background</p>
      <div
        role="progressbar"
        aria-label="Import progress"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={job.progress}
        className="mt-2 h-1.5 w-full overflow-hidden rounded-full bg-white"
      >
        <div className="h-full bg-brand-500 transition-all" style={{ width: `${job.progress}%` }} />
      </div>
      <p
        data-testid={`${testIdPrefix}-job-progress-text`}
        aria-live="polite"
        className="mt-1 text-xs"
      >
        {job.progress}% done{so_far ? ` · ${so_far} so far` : ""}
      </p>
      <p className="mt-0.5 text-xs text-brand-700/80">
        This can take a few minutes. Keep this page open to see the result.
      </p>
    </div>
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
              <td className="max-w-[180px] px-3 py-2 text-navy" title={r.label}>
                <span className="block truncate">{r.label}</span>
                {r.family && (
                  <span className="block truncate text-[11px] text-navy/50">
                    {r.family.displayName}
                    {r.family.movesFrom ? ` · moves from ${r.family.movesFrom}` : ""}
                  </span>
                )}
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
  const [job, setJob] = React.useState<JobView | null>(null);
  const [showColumns, setShowColumns] = React.useState(false);
  const [noResult, setNoResult] = React.useState(false);
  const summaryRef = React.useRef<HTMLDivElement>(null);
  const bannerRef = React.useRef<HTMLDivElement>(null);
  const gateRef = React.useRef<HTMLDivElement>(null);
  const jobRunning = job !== null && (job.state === "queued" || job.state === "running");
  // the polling loop reads the latest callbacks without restarting
  const latest = React.useRef({ onImported, toast, title, endpoint });
  latest.current = { onImported, toast, title, endpoint };
  const inputRef = React.useRef<HTMLInputElement>(null);

  const pickFile = (f: File | null | undefined) => {
    if (!f) return;
    setFile(f);
    setPreview(null);
    setFinal(null);
    setGateError(null);
    setJob(null);
    setNoResult(false);
  };

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault();
    if (jobRunning) return;
    const f = e.dataTransfer.files?.[0];
    if (f && f.name.endsWith(".csv")) pickFile(f);
  };

  const resetFile = () => {
    setFile(null);
    setPreview(null);
    setFinal(null);
    setGateError(null);
    setJob(null);
    setNoResult(false);
    if (inputRef.current) inputRef.current.value = "";
  };

  const run = async (dryRun: boolean) => {
    if (!file) return;
    setLoading(dryRun ? "preview" : "import");
    if (dryRun) {
      setGateError(null);
      setJob(null);
    }
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
      } else if (data.queued) {
        // a large apply: the server queued it; the polling effect below follows it to the end
        setJob({ jobId: data.queued.jobId, rows: data.queued.rows, state: "queued", progress: 0 });
      } else {
        setFinal(data);
        onImported?.(data);
        toast({ title: `${title} imported`, description: summarize(data), variant: "success" });
      }
    } catch (err: any) {
      const refusal = importRefusalCopy(err?.response?.data?.code);
      if (refusal) {
        // the whole file is refused (family pricing on / too many rows): say why on the page, in fixed words
        setGateError(refusal);
        setPreview(null);
      } else if (err?.response?.status === 403) {
        // Today's behaviour, deliberately: the server names WHICH add-on or flag is needed (and a role 403 reads differently).
        // Moving this to fixed copy needs codes + structured fields first (B991).
        setGateError(err?.response?.data?.message ?? "This column needs an add-on to import");
        setPreview(null);
      } else {
        toast({
          title: dryRun ? "Preview failed" : "Import failed",
          description: importFailureCopy(err),
          variant: "error",
        });
      }
    } finally {
      setLoading(null);
    }
  };

  React.useEffect(() => {
    if (!job || !jobRunning) return undefined;
    const jobId = job.jobId;
    let cancelled = false;
    let finished = false; // synchronous: onImported can only ever fire once
    let misses = 0;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const schedule = () => {
      timer = setTimeout(() => void tick(), JOB_POLL_MS);
    };
    const tick = async () => {
      try {
        const res = await apiClient.get(`${latest.current.endpoint}/jobs/${jobId}`);
        if (cancelled || finished) return;
        misses = 0;
        const status = res.data as JobStatus;
        if (status.state === "done") {
          finished = true;
          const result = status.result ?? EMPTY_RESULT;
          setJob((j) => (j ? { ...j, state: "done", progress: 100 } : j));
          setNoResult(!status.result);
          setFinal(result);
          latest.current.onImported?.(result);
          latest.current.toast({
            title: `${latest.current.title} imported`,
            description: summarize(result),
            variant: "success",
          });
          return;
        }
        setJob((j) =>
          j
            ? {
                ...j,
                state: status.state,
                progress: status.progress,
                counts: status.counts ?? j.counts,
                errorCode: status.state === "failed" ? status.errorCode : undefined,
              }
            : j,
        );
        if (status.state === "failed") {
          finished = true;
          return;
        }
        schedule();
      } catch {
        if (cancelled) return;
        misses += 1;
        if (misses >= JOB_MAX_MISSES) {
          setJob((j) => (j ? { ...j, state: "failed", lostContact: true } : j));
          return;
        }
        schedule();
      }
    };
    schedule();
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [job?.jobId, jobRunning]);

  // After Preview, Import and a stop, focus lands on the thing that changed (the banner or the result), not on body.
  const focusKey = gateError
    ? "gate"
    : job && job.state !== "done"
      ? jobRunning
        ? "job:running"
        : "job:stopped"
      : final
        ? "final"
        : preview
          ? "preview"
          : "none";
  React.useEffect(() => {
    if (focusKey === "none") return;
    (focusKey === "gate"
      ? gateRef
      : focusKey.startsWith("job:")
        ? bannerRef
        : summaryRef
    ).current?.focus();
  }, [focusKey]);

  const active = final ?? preview;

  return (
    <div className="space-y-3">
      {/* Accepted columns help */}
      <div className="rounded-lg border border-surface-border">
        <button
          type="button"
          data-testid={`${prefix}-columns-toggle`}
          onClick={() => setShowColumns((v) => !v)}
          className="flex min-h-[44px] w-full items-center justify-between px-3 py-2 text-xs font-medium text-navy/70"
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
        data-testid={`${prefix}-dropzone`}
        aria-disabled={jobRunning}
        onDrop={handleDrop}
        onDragOver={(e) => e.preventDefault()}
        onClick={() => {
          if (!jobRunning) inputRef.current?.click();
        }}
        className={cn(
          "flex cursor-pointer flex-col items-center justify-center gap-2 rounded-lg border-2 border-dashed p-6 transition-colors min-h-[96px]",
          jobRunning && "pointer-events-none opacity-50",
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
          disabled={jobRunning}
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
      <div data-testid={`${prefix}-actions`} className="flex flex-wrap gap-2">
        <button
          type="button"
          data-testid={`${prefix}-preview-button`}
          onClick={() => run(true)}
          disabled={!file || loading !== null || jobRunning}
          className="min-h-[44px] min-w-[8rem] flex-1 rounded-lg border border-brand-300 py-2 text-sm font-medium text-brand-600 hover:bg-brand-50 disabled:opacity-40 transition-colors"
        >
          {loading === "preview" ? "Previewing…" : "Preview"}
        </button>
        <button
          type="button"
          data-testid={`${prefix}-import-button`}
          onClick={() => run(false)}
          disabled={!file || loading !== null || !preview || !!gateError || !!final || jobRunning}
          className="min-h-[44px] min-w-[10rem] flex-1 rounded-lg bg-brand-500 px-3 py-2 text-center text-sm font-medium leading-tight text-white hover:bg-brand-600 disabled:opacity-40 transition-colors"
        >
          {loading === "import" ? "Importing…" : jobRunning ? "Importing…" : `Import ${title}`}
        </button>
        {(final || gateError) && (
          <button
            type="button"
            data-testid={`${prefix}-reset-button`}
            onClick={resetFile}
            className="min-h-[44px] rounded-lg border border-surface-border px-3 py-2 text-sm text-navy hover:bg-surface-raised transition-colors"
          >
            Choose another file
          </button>
        )}
      </div>

      {/* Gate refusal — blocking, no retry-without-the-column affordance (FIX5) */}
      {gateError && (
        <div
          ref={gateRef}
          tabIndex={-1}
          data-testid={`${prefix}-gate-error`}
          role="alert"
          className="flex items-start gap-2 rounded-lg border border-danger/40 bg-danger-bg/50 px-3 py-2.5 text-sm text-danger focus:outline-none focus-visible:ring-2 focus-visible:ring-danger/40"
        >
          <AlertCircle className="h-4 w-4 mt-0.5 shrink-0" />
          <span>{gateError}</span>
        </div>
      )}

      {job && <JobBanner job={job} testIdPrefix={prefix} bannerRef={bannerRef} />}

      {/* Summary */}
      {active && (
        <div
          ref={summaryRef}
          tabIndex={-1}
          data-testid={`${prefix}-summary`}
          className={cn(
            "flex items-center gap-2 rounded-lg border px-3 py-2 text-sm focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-300",
            final
              ? "border-success/30 bg-success-bg/50 text-success"
              : "border-brand-200 bg-brand-50 text-brand-700",
          )}
        >
          <CheckCircle2 className="h-4 w-4 shrink-0" />
          <span>
            {final && noResult ? (
              "Import finished. Check Products to see what changed."
            ) : (
              <>
                {final ? "Import complete — " : job ? "Last preview — " : "Preview — "}
                {summarize(active)}
              </>
            )}
          </span>
        </div>
      )}

      {active?.families && (
        <FamilyBlock summary={active.families} done={!!final} testIdPrefix={prefix} />
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
