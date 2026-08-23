"use client";

import React from "react";
import { usePageTitle } from "@/lib/page-title-context";
import { useToast } from "@routeflow/ui/web";
import { cn } from "@routeflow/ui/web";
import { Upload, Check, AlertTriangle, Copy, FileWarning, CheckCircle2 } from "lucide-react";
import {
  useBatch,
  useBatches,
  useCreateBatch,
  useScanFile,
  useResolveItem,
  usePostBatch,
  type ImportFileStatus,
  type ImportQueueItem,
} from "@/lib/api/batch-import";
import { BatchItemReviewModal } from "@/components/BatchItemReviewModal";

const STATUS_META: Record<
  ImportFileStatus,
  { label: string; cls: string; icon: React.ComponentType<{ className?: string }> }
> = {
  QUEUED: { label: "Queued", cls: "bg-navy/10 text-navy/60", icon: Upload },
  PROCESSING: { label: "Scanning", cls: "bg-navy/10 text-navy/60", icon: Upload },
  CLEAN: { label: "Clean", cls: "bg-success-bg text-success", icon: CheckCircle2 },
  NEEDS_REVIEW: { label: "Review", cls: "bg-warning/15 text-warning", icon: AlertTriangle },
  DUPLICATE: { label: "Duplicate", cls: "bg-navy/10 text-navy/50", icon: Copy },
  FAILED: { label: "Failed", cls: "bg-danger-bg text-danger", icon: FileWarning },
  POSTED: { label: "Posted", cls: "bg-success-bg text-success", icon: Check },
};

type Filter = "ALL" | "NEEDS_REVIEW" | "CLEAN" | "DUPLICATE";

// Remembers which batch the operator is working on so a page refresh doesn't
// strand it (batchId used to live only in React state).
const ACTIVE_BATCH_KEY = "rf:batch-import:active-batch-id";

export default function BatchImportPage() {
  const { setTitle } = usePageTitle();
  const { toast } = useToast();
  React.useEffect(() => setTitle("Batch import"), [setTitle]);

  const [batchId, setBatchIdState] = React.useState<string | undefined>(() =>
    typeof window === "undefined"
      ? undefined
      : (localStorage.getItem(ACTIVE_BATCH_KEY) ?? undefined),
  );
  const setBatchId = React.useCallback((id: string | undefined) => {
    setBatchIdState(id);
    if (typeof window === "undefined") return;
    if (id) localStorage.setItem(ACTIVE_BATCH_KEY, id);
    else localStorage.removeItem(ACTIVE_BATCH_KEY);
  }, []);

  const [uploading, setUploading] = React.useState(false);
  const [isDragging, setIsDragging] = React.useState(false);
  const [filter, setFilter] = React.useState<Filter>("ALL");
  const [reviewItemId, setReviewItemId] = React.useState<string | null>(null);
  const inputRef = React.useRef<HTMLInputElement>(null);

  const batches = useBatches();
  const batch = useBatch(batchId);
  const createBatch = useCreateBatch();
  const scanFile = useScanFile();
  const resolveItem = useResolveItem();
  const postBatch = usePostBatch();

  // No locally-remembered batch — restore the most recent one still in
  // progress rather than dropping the operator back into an empty state.
  // Gated to run at most once per page load: without this, clicking "Start
  // new batch" (which clears batchId) would immediately re-trigger this
  // effect and restore the very batch the operator just dismissed, since
  // the stale batches.data cache still lists it as active.
  const triedRestoreRef = React.useRef(false);
  React.useEffect(() => {
    if (triedRestoreRef.current) return;
    if (batchId) {
      triedRestoreRef.current = true;
      return;
    }
    if (!batches.data) return; // wait for the list to load before giving up
    triedRestoreRef.current = true;
    const active = batches.data.find((b) => b.status === "PROCESSING" || b.status === "READY");
    if (active) setBatchId(active.id);
  }, [batchId, batches.data, setBatchId]);

  // The remembered batch no longer exists (or belongs to another tenant) — drop it.
  React.useEffect(() => {
    if (batchId && batch.isError) setBatchId(undefined);
  }, [batchId, batch.isError, setBatchId]);

  const handleFiles = async (files: FileList | null) => {
    if (!files?.length) return;
    setUploading(true);
    try {
      let id = batchId;
      if (!id) {
        const b = await createBatch.mutateAsync();
        id = b.id;
        setBatchId(id);
      }
      let ok = 0;
      let failed = 0;
      for (const file of Array.from(files)) {
        try {
          await scanFile.mutateAsync({ batchId: id, file });
          ok++;
        } catch {
          failed++; // per-file failure is recorded as a FAILED queue item; keep going
        }
      }
      toast({
        title: failed === 0 ? `${ok} scanned` : `${ok} scanned, ${failed} failed`,
        description:
          failed === 0 ? "Review and post the clean ones" : "Failed files are kept in the queue",
        variant: failed === 0 ? "success" : ok === 0 ? "error" : "warning",
      });
    } finally {
      setUploading(false);
      if (inputRef.current) inputRef.current.value = "";
    }
  };

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault();
    setIsDragging(false);
    void handleFiles(e.dataTransfer.files);
  };

  const doPost = () => {
    if (!batchId) return;
    postBatch.mutate(
      { id: batchId },
      {
        onSuccess: (r) =>
          toast({
            title: `Posted ${r.posted} bill${r.posted === 1 ? "" : "s"}`,
            description: [
              "Stock and costs updated",
              r.adopted > 0 ? `${r.adopted} linked to existing bills` : "",
              r.duplicates > 0 ? `${r.duplicates} held as duplicates` : "",
            ]
              .filter(Boolean)
              .join(" · "),
            variant: "success",
          }),
        onError: (e: any) =>
          toast({
            title: "Post failed",
            description: e?.response?.data?.message ?? e.message,
            variant: "error",
          }),
      },
    );
  };

  const b = batch.data?.batch;
  const items = batch.data?.items ?? [];
  const shown = items.filter((i) => (filter === "ALL" ? true : i.status === filter));
  const cleanCount = b?.cleanCount ?? 0;
  const reviewItem = items.find((i) => i.id === reviewItemId) ?? null;

  return (
    <div className="space-y-6 p-6">
      <div className="flex items-start justify-between">
        <div>
          <h2 className="text-xl font-semibold text-navy">Batch invoice import</h2>
          <p className="mt-1 text-sm text-navy/70">
            Drop many invoices (PDF/photos). We scan and match them, then you post the clean ones in
            one click. Duplicates are skipped and linked.
          </p>
        </div>
        <div className="flex items-center gap-3">
          {b && (
            <span className="self-center font-mono text-[11px] text-navy/50">
              AI scans: {b.meteredScans}
            </span>
          )}
          {batchId && (
            <button
              onClick={() => setBatchId(undefined)}
              className="text-sm text-navy/70 transition-colors hover:text-navy"
              title="Leave this batch open in the list and start a fresh one"
            >
              Start new batch
            </button>
          )}
          <button
            onClick={() => inputRef.current?.click()}
            disabled={uploading}
            className="flex items-center gap-2 rounded-lg border border-surface-border bg-white px-3 py-2 text-sm font-medium text-navy hover:bg-surface-raised disabled:opacity-40"
          >
            <Upload className="h-4 w-4" />
            {uploading ? "Uploading…" : "Add files"}
          </button>
          <button
            onClick={doPost}
            disabled={!batchId || cleanCount === 0 || postBatch.isPending}
            className="flex items-center gap-2 rounded-lg bg-brand-500 px-3 py-2 text-sm font-medium text-white hover:bg-brand-600 disabled:opacity-40"
          >
            <Check className="h-4 w-4" />
            {postBatch.isPending ? "Posting…" : `Finish: post ${cleanCount} bills`}
          </button>
          <input
            ref={inputRef}
            type="file"
            multiple
            accept=".pdf,image/*"
            className="hidden"
            onChange={(e) => handleFiles(e.target.files)}
          />
        </div>
      </div>

      {!batchId ? (
        <div
          onClick={() => inputRef.current?.click()}
          onDragOver={(e) => {
            e.preventDefault();
            setIsDragging(true);
          }}
          onDragLeave={() => setIsDragging(false)}
          onDrop={handleDrop}
          className={cn(
            "flex min-h-[220px] cursor-pointer flex-col items-center justify-center gap-2 rounded-xl border-2 border-dashed text-center transition-colors",
            isDragging
              ? "border-brand-500 bg-brand-50"
              : "border-surface-border hover:border-brand-300 hover:bg-brand-50/30",
          )}
        >
          <Upload className="h-8 w-8 text-navy/30" />
          <p className="text-sm text-navy/70">
            Drop invoices here or <span className="text-brand-500">browse</span>
          </p>
          <p className="text-xs text-navy/50">PDF or photos · mixed OK · reviewed after</p>
        </div>
      ) : (
        <>
          {/* Summary + filters */}
          <div className="flex items-center gap-2">
            {(
              [
                ["ALL", `All ${b?.totalFiles ?? 0}`],
                ["NEEDS_REVIEW", `Review ${b?.reviewCount ?? 0}`],
                ["CLEAN", `Clean ${b?.cleanCount ?? 0}`],
                ["DUPLICATE", `Dupes ${b?.dupeCount ?? 0}`],
              ] as [Filter, string][]
            ).map(([f, label]) => (
              <button
                key={f}
                onClick={() => setFilter(f)}
                className={cn(
                  "rounded-full px-3 py-1 text-xs font-medium transition-colors",
                  filter === f
                    ? "bg-brand-500 text-white"
                    : "border border-surface-border text-navy/70 hover:bg-surface-raised",
                )}
              >
                {label}
              </button>
            ))}
          </div>

          {/* Queue */}
          <div className="rounded-xl border border-surface-border bg-white overflow-hidden">
            {shown.length === 0 ? (
              <p className="p-6 text-sm text-navy/50">
                {items.length === 0 ? "No files yet — add some above." : "Nothing in this filter."}
              </p>
            ) : (
              shown.map((item) => (
                <QueueRow
                  key={item.id}
                  item={item}
                  onReview={() => setReviewItemId(item.id)}
                  onResolve={() => resolveItem.mutate({ batchId: batchId!, itemId: item.id })}
                  resolving={resolveItem.isPending && resolveItem.variables?.itemId === item.id}
                />
              ))
            )}
          </div>
        </>
      )}

      {reviewItem && batchId && (
        <BatchItemReviewModal
          batchId={batchId}
          item={reviewItem}
          onClose={() => setReviewItemId(null)}
        />
      )}
    </div>
  );
}

function QueueRow({
  item,
  onReview,
  onResolve,
  resolving,
}: {
  item: ImportQueueItem;
  onReview: () => void;
  onResolve: () => void;
  resolving: boolean;
}) {
  const meta = STATUS_META[item.status];
  const Icon = meta.icon;
  const readyToResolve =
    item.status === "NEEDS_REVIEW" && !item.unreviewedLines && !item.supplierUnresolved;
  const needsAttention =
    item.status === "NEEDS_REVIEW" && (item.unreviewedLines > 0 || item.supplierUnresolved);

  return (
    <div className="flex items-center gap-3 border-b border-surface-border px-4 py-3 last:border-b-0">
      <Icon className="h-4 w-4 shrink-0 text-navy/40" />
      <div className="min-w-0 flex-1">
        <p className="truncate text-sm font-medium text-navy">
          {item.supplierName ?? item.filename ?? "Invoice"}
          {item.invoiceNumber ? ` · ${item.invoiceNumber}` : ""}
        </p>
        <p className="text-xs text-navy/50">
          {item.total ? `$${item.total}` : "—"}
          {item.status === "NEEDS_REVIEW" && item.unreviewedLines > 0
            ? ` · ${item.unreviewedLines} line(s) need review`
            : ""}
          {item.status === "NEEDS_REVIEW" && item.supplierUnresolved
            ? " · supplier not linked"
            : ""}
          {item.status === "DUPLICATE" ? " · matches an existing bill" : ""}
          {item.status === "FAILED" && item.errorMessage ? ` · ${item.errorMessage}` : ""}
        </p>
      </div>
      {needsAttention && (
        <button
          onClick={onReview}
          className="rounded-lg border border-surface-border px-2.5 py-1.5 text-xs font-medium text-navy hover:bg-surface-raised"
        >
          Review
        </button>
      )}
      {readyToResolve && (
        <button
          onClick={onResolve}
          disabled={resolving}
          className="rounded-lg border border-surface-border px-2.5 py-1.5 text-xs font-medium text-navy hover:bg-surface-raised disabled:opacity-40"
        >
          Mark resolved
        </button>
      )}
      <span className={cn("rounded-full px-2 py-0.5 text-[11px] font-semibold", meta.cls)}>
        {meta.label}
      </span>
    </div>
  );
}
