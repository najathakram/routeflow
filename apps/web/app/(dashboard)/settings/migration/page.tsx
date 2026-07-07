"use client";

import React from "react";
import { usePageTitle } from "@/lib/page-title-context";
import { useToast } from "@routeflow/ui/web";
import { cn } from "@routeflow/ui/web";
import { Database, FileText, Camera, Shield, Check, Undo2, ArrowRight } from "lucide-react";
import {
  useMigrationJobs,
  useMigrationJob,
  useCreateMigrationJob,
  useConfirmMigration,
  useUndoMigration,
  type MigrationSource,
  type MigrationJob,
} from "@/lib/api/migration";

const SOURCES: {
  key: MigrationSource;
  label: string;
  desc: string;
  icon: React.ComponentType<{ className?: string }>;
  connected: boolean;
}[] = [
  {
    key: "ZOHO",
    label: "Zoho Books",
    desc: "Export a CSV — connector coming soon",
    icon: Database,
    connected: false,
  },
  {
    key: "QUICKBOOKS",
    label: "QuickBooks",
    desc: "Export a CSV — connector coming soon",
    icon: Database,
    connected: false,
  },
  {
    key: "CSV",
    label: "CSV files",
    desc: "Exports from any system",
    icon: FileText,
    connected: true,
  },
  {
    key: "PAPER",
    label: "Paper or PDF",
    desc: "Batch AI import, reviewed after",
    icon: Camera,
    connected: true,
  },
];

function isUndoable(job: MigrationJob): boolean {
  if (job.status !== "CONFIRMED" || !job.undoDeadline) return false;
  return new Date(job.undoDeadline).getTime() > Date.now();
}

function StatusBadge({ status }: { status: MigrationJob["status"] }) {
  const map: Record<MigrationJob["status"], string> = {
    FETCHING: "bg-navy/10 text-navy/70",
    STAGED: "bg-warning/15 text-warning",
    CONFIRMED: "bg-success-bg text-success",
    UNDONE: "bg-navy/10 text-navy/50",
    FAILED: "bg-danger-bg text-danger",
  };
  return (
    <span className={cn("rounded-full px-2 py-0.5 text-[11px] font-semibold", map[status])}>
      {status.toLowerCase()}
    </span>
  );
}

export default function MigrationHubPage() {
  const { setTitle } = usePageTitle();
  const { toast } = useToast();
  React.useEffect(() => setTitle("Migration"), [setTitle]);

  const [source, setSource] = React.useState<MigrationSource>("CSV");
  const [activeJobId, setActiveJobId] = React.useState<string | undefined>();

  const jobs = useMigrationJobs();
  const activeJob = useMigrationJob(activeJobId);
  const createJob = useCreateMigrationJob();
  const confirm = useConfirmMigration();
  const undo = useUndoMigration();

  const start = () => {
    createJob.mutate(
      { source },
      {
        onSuccess: (job) => {
          setActiveJobId(job.id);
          toast({
            title: "Migration started",
            description: `Job for ${source} created`,
            variant: "success",
          });
        },
        onError: (e: any) =>
          toast({
            title: "Could not start",
            description: e?.response?.data?.message ?? e.message,
            variant: "error",
          }),
      },
    );
  };

  const doConfirm = (id: string) =>
    confirm.mutate(
      { id },
      {
        onSuccess: (r) =>
          toast({
            title: "Migration confirmed",
            description: `${r.committed} committed${r.skipped ? `, ${r.skipped} deferred` : ""} · undo for 24h`,
            variant: "success",
          }),
        onError: (e: any) =>
          toast({
            title: "Confirm failed",
            description: e?.response?.data?.message ?? e.message,
            variant: "error",
          }),
      },
    );

  const doUndo = (id: string) =>
    undo.mutate(
      { id },
      {
        onSuccess: (r) =>
          toast({
            title: "Migration undone",
            description: `${r.reversed} records removed`,
            variant: "success",
          }),
        onError: (e: any) =>
          toast({
            title: "Undo failed",
            description: e?.response?.data?.message ?? e.message,
            variant: "error",
          }),
      },
    );

  const detail = activeJob.data;

  return (
    <div className="space-y-6 p-6">
      <div>
        <h1 className="text-xl font-semibold text-navy">Move to RouteFlow</h1>
        <p className="mt-1 text-sm text-navy/70">
          Bring your history over. Nothing goes live until you review and confirm, and every
          migration can be undone for 24 hours.
        </p>
      </div>

      <div className="grid grid-cols-[1.5fr_1fr] gap-5">
        <div className="space-y-5">
          {/* Source picker */}
          <div className="rounded-xl border border-surface-border bg-white p-4">
            <p className="mb-3 font-semibold text-navy">Where are you coming from?</p>
            <div className="grid grid-cols-2 gap-3">
              {SOURCES.map((s) => {
                const Icon = s.icon;
                return (
                  <button
                    key={s.key}
                    onClick={() => setSource(s.key)}
                    className={cn(
                      "flex items-center gap-3 rounded-lg border p-3 text-left transition-colors",
                      source === s.key
                        ? "border-brand-400 bg-brand-50 outline outline-1 outline-brand-400"
                        : "border-surface-border hover:border-brand-300",
                    )}
                  >
                    <span className="flex h-9 w-9 items-center justify-center rounded-lg bg-surface-raised text-navy/60">
                      <Icon className="h-4 w-4" />
                    </span>
                    <span className="min-w-0">
                      <span className="block text-sm font-semibold text-navy">{s.label}</span>
                      <span className="block text-[11px] text-navy/60">{s.desc}</span>
                    </span>
                  </button>
                );
              })}
            </div>
            <button
              onClick={start}
              disabled={createJob.isPending}
              className="mt-4 flex w-full items-center justify-center gap-2 rounded-lg bg-brand-500 py-2.5 text-sm font-medium text-white hover:bg-brand-600 disabled:opacity-40"
            >
              {createJob.isPending ? "Starting…" : "Start migration"}
              <ArrowRight className="h-4 w-4" />
            </button>
            <p className="mt-2 text-center text-[11px] text-navy/50">
              Read-only. We never write back to your old system.
            </p>
          </div>

          {/* Active job / staging review */}
          {detail && (
            <div className="rounded-xl border border-brand-200 bg-white p-4">
              <div className="mb-3 flex items-center justify-between">
                <p className="font-semibold text-navy">
                  Staging · {detail.job.source} <StatusBadge status={detail.job.status} />
                </p>
              </div>
              <div className="grid grid-cols-2 gap-2">
                {Object.entries(detail.job.scopeCounts ?? {}).map(([k, n]) => (
                  <div
                    key={k}
                    className="flex items-center justify-between rounded-lg bg-surface-raised px-3 py-2 text-sm"
                  >
                    <span className="capitalize text-navy/70">{k.toLowerCase()}</span>
                    <span className="font-mono font-semibold text-navy">{n}</span>
                  </div>
                ))}
                {Object.keys(detail.job.scopeCounts ?? {}).length === 0 && (
                  <p className="col-span-2 text-sm text-navy/50">Nothing staged yet.</p>
                )}
              </div>
              {(detail.statusCounts?.DUPLICATE ?? 0) > 0 && (
                <p className="mt-2 text-xs text-warning">
                  {detail.statusCounts.DUPLICATE} duplicate(s) detected — they will be skipped and
                  linked.
                </p>
              )}
              {detail.job.status === "STAGED" && (
                <button
                  onClick={() => doConfirm(detail.job.id)}
                  disabled={confirm.isPending}
                  className="mt-4 flex w-full items-center justify-center gap-2 rounded-lg bg-success py-2.5 text-sm font-medium text-white hover:opacity-90 disabled:opacity-40"
                >
                  <Check className="h-4 w-4" />
                  {confirm.isPending ? "Confirming…" : "Confirm — make it live"}
                </button>
              )}
            </div>
          )}
        </div>

        {/* Right rail: guarantees + history */}
        <div className="space-y-5">
          <div className="rounded-xl border border-surface-border bg-white p-4">
            <p className="mb-2 font-semibold text-navy">No duplicates, guaranteed</p>
            <ul className="space-y-2 text-xs leading-relaxed text-navy/70">
              <li className="flex gap-2">
                <Shield className="mt-0.5 h-3.5 w-3.5 shrink-0 text-brand-500" /> Each record keeps
                its source id — re-running updates instead of duplicating.
              </li>
              <li className="flex gap-2">
                <Shield className="mt-0.5 h-3.5 w-3.5 shrink-0 text-brand-500" /> Invoices also
                match on number + amount + date, so the same one from CSV and connector counts once.
              </li>
              <li className="flex gap-2">
                <Shield className="mt-0.5 h-3.5 w-3.5 shrink-0 text-brand-500" /> Anything skipped
                is listed with a link to what it matched.
              </li>
            </ul>
          </div>

          <div className="rounded-xl border border-surface-border bg-white overflow-hidden">
            <div className="border-b border-surface-border p-4">
              <p className="font-semibold text-navy">Import history</p>
            </div>
            {jobs.isLoading ? (
              <p className="p-4 text-sm text-navy/50">Loading…</p>
            ) : !jobs.data?.length ? (
              <p className="p-4 text-sm text-navy/50">No migrations yet.</p>
            ) : (
              jobs.data.map((job) => (
                <div
                  key={job.id}
                  className="flex items-center gap-3 border-b border-surface-border px-4 py-3 last:border-b-0"
                >
                  <div className="min-w-0 flex-1">
                    <p className="text-sm font-medium text-navy">
                      {job.source} <StatusBadge status={job.status} />
                    </p>
                    <p className="font-mono text-[11px] text-navy/50">
                      {new Date(job.createdAt).toLocaleString()}
                    </p>
                  </div>
                  {isUndoable(job) && (
                    <button
                      onClick={() => doUndo(job.id)}
                      disabled={undo.isPending}
                      className="flex items-center gap-1 rounded-lg border border-surface-border px-2.5 py-1.5 text-xs font-medium text-navy hover:bg-surface-raised disabled:opacity-40"
                    >
                      <Undo2 className="h-3.5 w-3.5" /> Undo
                    </button>
                  )}
                </div>
              ))
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
