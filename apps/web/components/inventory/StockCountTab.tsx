"use client";

import * as React from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { Camera, History, RefreshCw, Trash2, Undo2 } from "lucide-react";
import { Button, Card, Modal, cn, useToast } from "@routeflow/ui/web";

import { BarcodeScannerButton } from "@/components/BarcodeScannerButton";
import { InlineCreateProductModal } from "@/components/InlineCreateProductModal";
import { archivedMessage, resolveProductByCode } from "@/lib/barcode-resolve";
import { useAuth } from "@/lib/auth-context";
import { fmtDate } from "@/lib/formatting";
import { unitsLabel } from "@/lib/stock-label";
import { useStockOverview } from "@/lib/api/inventory";
import {
  computeQtyVariance,
  useCommitStockCountSession,
  useDiscardStockCountSession,
  useRemoveStockCountLine,
  useStartStockCount,
  useStockCountSession,
  useStockCountSessions,
  useUpsertStockCountLine,
  type StockCountLocalRow as Row,
  type StockCountMode,
  type StockCountSessionRef,
  type StockCountStatus,
  type UpsertStockCountLineInput,
} from "@/lib/api/stock-count";

import { StockCountBulkBar } from "./StockCountBulkBar";
import { StockCountRow } from "./StockCountRow";
import { StockCountReviewModal } from "./StockCountReviewModal";

/** What's queued to reach the server for one product. `increment` accumulates
 *  additively (the live scan path — never idempotent, by design); `absolute`
 *  carries the running total (review-screen edits, bulk apply, undo reconciles
 *  as a negative increment). See `queueIncrement`/`queueAbsolute` below for how
 *  the two interact with an in-flight request for the same product. */
type PendingWrite =
  | { kind: "increment"; delta: number; mode: StockCountMode }
  | {
      kind: "absolute";
      countedQty: number;
      mode: StockCountMode;
      unitCostOverride?: number | null;
    };

interface SessionMeta {
  id: string;
  name: string | null;
  status: StockCountStatus;
  startedAt: string;
  startedById: string;
}

export function StockCountTab() {
  const { toast } = useToast();
  const { user } = useAuth();
  const router = useRouter();
  const searchParams = useSearchParams();

  const startStockCount = useStartStockCount();
  const upsertLine = useUpsertStockCountLine();
  const removeLine = useRemoveStockCountLine();
  const commitSession = useCommitStockCountSession();
  const discardSession = useDiscardStockCountSession();

  const [sessionId, setSessionId] = React.useState<string | null>(null);
  const [sessionMeta, setSessionMeta] = React.useState<SessionMeta | null>(null);
  const [rows, setRows] = React.useState<Row[]>([]);
  const rowsRef = React.useRef<Row[]>(rows);
  rowsRef.current = rows;

  const { data: sessionDetail } = useStockCountSession(sessionId);
  const { data: openSessionsData } = useStockCountSessions({ status: "OPEN", limit: 5 });
  const openSessions = (openSessionsData?.data ?? []).filter((s) => s.id !== sessionId);

  const [selected, setSelected] = React.useState<Set<string>>(new Set());
  const [flashId, setFlashId] = React.useState<string | null>(null);
  const [qtyPerScan, setQtyPerScan] = React.useState(1);
  const [defaultMode, setDefaultMode] = React.useState<StockCountMode>("ADD");

  const [scanInput, setScanInput] = React.useState("");
  const scanInputRef = React.useRef<HTMLInputElement>(null);
  const scanContainerRef = React.useRef<HTMLDivElement>(null);
  const [resolving, setResolving] = React.useState(false);

  const [suggestOpen, setSuggestOpen] = React.useState(false);
  const [suggestIndex, setSuggestIndex] = React.useState(0);
  const { data: stockOverview } = useStockOverview();

  const [unknownCode, setUnknownCode] = React.useState<string | null>(null);
  const [reviewOpen, setReviewOpen] = React.useState(false);
  const [commitNotes, setCommitNotes] = React.useState("");
  const [otherOpenWarning, setOtherOpenWarning] = React.useState<StockCountSessionRef[] | null>(
    null,
  );

  // ─── Autosave queue: pending writes not yet confirmed saved ────────────────
  const pendingRef = React.useRef<Map<string, PendingWrite>>(new Map());
  const inFlightRef = React.useRef<Set<string>>(new Set());
  const flushTimerRef = React.useRef<ReturnType<typeof setTimeout> | null>(null);
  const retryTimerRef = React.useRef<ReturnType<typeof setTimeout> | null>(null);
  const [unsavedCount, setUnsavedCount] = React.useState(0);
  const [syncError, setSyncError] = React.useState(false);

  const lastActionRef = React.useRef<{ productId: string; delta: number; wasNew: boolean } | null>(
    null,
  );
  const [canUndo, setCanUndo] = React.useState(false);

  const updateUnsavedCount = () =>
    setUnsavedCount(pendingRef.current.size + inFlightRef.current.size);

  /**
   * Send every queued write once (skipping anything already in flight for that
   * product — a second in-flight write per product would race). Successes are
   * merged back into local rows (server-assigned line id, frozen expectedQty,
   * live averageCost); failures stay queued and retry on a backoff timer. A
   * connectivity drop therefore never loses a counted line — it just sits in
   * `pendingRef` until the network (or the operator, via "Retry sync") comes
   * back, and the local `rows` state the operator sees never depends on it.
   */
  const flush = async () => {
    const sid = sessionId;
    if (!sid) return;
    const candidates = Array.from(pendingRef.current.entries()).filter(
      ([pid]) => !inFlightRef.current.has(pid),
    );
    if (candidates.length === 0) return;
    candidates.forEach(([pid]) => inFlightRef.current.add(pid));
    updateUnsavedCount();

    const results = await Promise.all(
      candidates.map(async ([productId, entry]) => {
        try {
          const dto: UpsertStockCountLineInput =
            entry.kind === "increment"
              ? { productId, increment: true, countedQty: entry.delta, mode: entry.mode }
              : {
                  productId,
                  countedQty: entry.countedQty,
                  mode: entry.mode,
                  unitCostOverride: entry.unitCostOverride,
                };
          const saved = await upsertLine.mutateAsync({ sessionId: sid, ...dto });
          return { ok: true as const, productId, entry, saved };
        } catch (err) {
          return { ok: false as const, productId, entry, err };
        }
      }),
    );

    const anyFailed = results.some((r) => !r.ok);

    setRows((prev) =>
      prev.map((r) => {
        const res = results.find((x) => x.productId === r.productId);
        if (!res || !res.ok) return r;
        return {
          ...r,
          lineId: res.saved.id,
          expectedQty: Number(res.saved.expectedQty),
          countedById: res.saved.countedById,
          updatedAt: res.saved.updatedAt,
          averageCost:
            res.saved.product.averageCost != null
              ? Number(res.saved.product.averageCost)
              : r.averageCost,
        };
      }),
    );

    for (const res of results) {
      inFlightRef.current.delete(res.productId);
      // Reference equality: only clear the entry we just sent — if a newer
      // write replaced it while this request was in flight, leave the newer
      // one queued so it flushes next (see `queueIncrement`/`queueAbsolute`).
      if (res.ok && pendingRef.current.get(res.productId) === res.entry) {
        pendingRef.current.delete(res.productId);
      }
    }
    updateUnsavedCount();
    setSyncError(anyFailed);

    if (anyFailed) {
      if (retryTimerRef.current) clearTimeout(retryTimerRef.current);
      retryTimerRef.current = setTimeout(() => {
        retryTimerRef.current = null;
        flushRef.current();
      }, 4000);
    } else if (pendingRef.current.size > 0) {
      scheduleFlush(150);
    }
  };

  // Always-latest ref so debounce/retry timers never call a stale closure.
  const flushRef = React.useRef(flush);
  flushRef.current = flush;

  const scheduleFlush = (delay = 900) => {
    if (flushTimerRef.current) clearTimeout(flushTimerRef.current);
    flushTimerRef.current = setTimeout(() => {
      flushTimerRef.current = null;
      flushRef.current();
    }, delay);
  };

  // Retry immediately when connectivity comes back, instead of waiting out
  // whatever backoff was in progress when it dropped.
  React.useEffect(() => {
    const onOnline = () => flushRef.current();
    window.addEventListener("online", onOnline);
    return () => window.removeEventListener("online", onOnline);
  }, []);

  /** +1-per-scan path. Merges into an existing NOT-yet-sent entry; if the
   *  product currently has a request in flight, starts a fresh entry instead
   *  of layering onto the in-flight one — merging there would double-count
   *  whichever portion the in-flight request already applies. */
  const queueIncrement = (productId: string, delta: number, mode: StockCountMode) => {
    const inFlight = inFlightRef.current.has(productId);
    const existing = inFlight ? undefined : pendingRef.current.get(productId);
    if (existing?.kind === "absolute") {
      pendingRef.current.set(productId, {
        ...existing,
        countedQty: existing.countedQty + delta,
        mode,
      });
    } else if (existing?.kind === "increment") {
      pendingRef.current.set(productId, { kind: "increment", delta: existing.delta + delta, mode });
    } else {
      pendingRef.current.set(productId, { kind: "increment", delta, mode });
    }
    updateUnsavedCount();
    scheduleFlush();
  };

  /** Running-total path (review edits, bulk apply, mode changes). Always
   *  resolves defaults from the live local row, not from an in-flight pending
   *  entry — an absolute write is last-write-wins by nature, so basing it on
   *  what's on screen right now is always correct. */
  const queueAbsolute = (
    productId: string,
    patch: Partial<{ countedQty: number; mode: StockCountMode; unitCostOverride: number | null }>,
  ) => {
    const inFlight = inFlightRef.current.has(productId);
    const existing = inFlight ? undefined : pendingRef.current.get(productId);
    const row = rowsRef.current.find((r) => r.productId === productId);
    const base: PendingWrite =
      existing?.kind === "absolute"
        ? existing
        : {
            kind: "absolute",
            countedQty: row?.countedQty ?? 0,
            mode: row?.mode ?? "REPLACE",
            unitCostOverride: row?.unitCostOverride ?? null,
          };
    pendingRef.current.set(productId, { ...base, ...patch });
    updateUnsavedCount();
    scheduleFlush();
  };

  // ─── Session lifecycle ──────────────────────────────────────────────────────
  const hydratedSessionRef = React.useRef<string | null>(null);

  const resetLocalSession = () => {
    hydratedSessionRef.current = null;
    pendingRef.current.clear();
    inFlightRef.current.clear();
    lastActionRef.current = null;
    setCanUndo(false);
    updateUnsavedCount();
    setSelected(new Set());
    setRows([]);
    setSessionMeta(null);
  };

  const beginNewSession = async (amendsSessionId?: string): Promise<string | null> => {
    try {
      const res = await startStockCount.mutateAsync(amendsSessionId ? { amendsSessionId } : {});
      resetLocalSession();
      // A fresh session is created EMPTY server-side, so there is nothing to
      // hydrate — and letting the detail query's empty line list through would
      // wipe a row added in the same breath (scan → local row → hydration
      // replaces rows with []). Amend sessions ARE seeded server-side from the
      // amended count's lines, so those must still hydrate.
      if (!amendsSessionId) hydratedSessionRef.current = res.id;
      setSessionId(res.id);
      if (res.otherOpenSessions?.length) {
        setOtherOpenWarning(res.otherOpenSessions.filter((s) => s.id !== res.id));
      }
      return res.id;
    } catch {
      toast({
        title: "Couldn't start a count",
        description: "Check your connection and try again.",
        variant: "error",
      });
      return null;
    }
  };

  const ensureSession = async (): Promise<string | null> => {
    if (sessionId) return sessionId;
    return beginNewSession();
  };

  const resumeSession = (id: string) => {
    resetLocalSession();
    setSessionId(id);
  };

  const switchToOtherSession = async (targetId: string) => {
    const abandonedId = sessionId;
    setOtherOpenWarning(null);
    if (abandonedId) {
      try {
        await discardSession.mutateAsync(abandonedId);
      } catch {
        // Best-effort — the abandoned session just stays open; harmless.
      }
    }
    resumeSession(targetId);
  };

  // Hydrate local rows from the server once per session id.
  React.useEffect(() => {
    if (!sessionDetail || hydratedSessionRef.current === sessionDetail.id) return;
    hydratedSessionRef.current = sessionDetail.id;
    setSessionMeta({
      id: sessionDetail.id,
      name: sessionDetail.name ?? null,
      status: sessionDetail.status,
      startedAt: sessionDetail.startedAt,
      startedById: sessionDetail.startedById,
    });
    setRows(
      sessionDetail.lines.map((l) => ({
        productId: l.productId,
        name: l.product.name,
        sku: l.product.sku ?? null,
        unit: l.product.unit,
        currentStock: Number(l.product.currentStock),
        expectedQty: Number(l.expectedQty),
        countedQty: Number(l.countedQty),
        mode: l.mode,
        unitCostOverride: l.unitCostOverride != null ? Number(l.unitCostOverride) : null,
        averageCost: l.product.averageCost != null ? Number(l.product.averageCost) : null,
        countedById: l.countedById,
        updatedAt: l.updatedAt,
        lineId: l.id,
      })),
    );
  }, [sessionDetail]);

  // "Amend" deep-link from the count-history detail page: /inventory?tab=count&amend=<id>
  const amendConsumedRef = React.useRef(false);
  React.useEffect(() => {
    if (amendConsumedRef.current || sessionId) return;
    const amendId = searchParams.get("amend");
    if (!amendId) return;
    amendConsumedRef.current = true;
    beginNewSession(amendId).then(() => {
      router.replace("/inventory?tab=count");
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [searchParams, sessionId]);

  // ─── Suggestion list (unchanged from the pre-PR-C behaviour) ───────────────
  const suggestions = React.useMemo(() => {
    const q = scanInput.trim().toLowerCase();
    if (!q)
      return [] as Array<{
        id: string;
        name: string;
        sku?: string | null;
        unit: string;
        currentStock: number;
        unitsPerBox?: number | null;
        category?: string | null;
        averageCost?: number | null;
      }>;
    const items = (stockOverview ?? []) as Array<{
      id: string;
      name: string;
      sku?: string | null;
      unit: string;
      currentStock: number;
      unitsPerBox?: number | null;
      category?: string | null;
      averageCost?: number | null;
      isActive?: boolean;
    }>;
    const skuExact: typeof items = [];
    const skuPrefix: typeof items = [];
    const nameMatch: typeof items = [];
    const other: typeof items = [];
    for (const p of items) {
      if (p.isActive === false) continue;
      const sku = (p.sku ?? "").toLowerCase();
      const name = p.name.toLowerCase();
      const cat = (p.category ?? "").toLowerCase();
      if (sku === q) skuExact.push(p);
      else if (sku.startsWith(q)) skuPrefix.push(p);
      else if (name.includes(q)) nameMatch.push(p);
      else if (sku.includes(q) || cat.includes(q)) other.push(p);
    }
    return [...skuExact, ...skuPrefix, ...nameMatch, ...other].slice(0, 8);
  }, [scanInput, stockOverview]);

  React.useEffect(() => setSuggestIndex(0), [scanInput]);

  React.useEffect(() => {
    if (!suggestOpen) return;
    const handler = (e: MouseEvent) => {
      if (!scanContainerRef.current?.contains(e.target as Node)) setSuggestOpen(false);
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [suggestOpen]);

  const totalActiveProducts = React.useMemo(() => {
    const items = (stockOverview ?? []) as Array<{ isActive?: boolean }>;
    return items.filter((p) => p.isActive !== false).length;
  }, [stockOverview]);
  const uncountedCount = Math.max(0, totalActiveProducts - rows.length);

  // ─── Mutators ──────────────────────────────────────────────────────────────
  const addOrIncrementProduct = (
    product: {
      id: string;
      name: string;
      sku?: string | null;
      unit: string;
      currentStock?: number | string | null;
      averageCost?: number | string | null;
    },
    increment: number,
  ) => {
    const existingRow = rowsRef.current.find((r) => r.productId === product.id);
    const wasNew = !existingRow;

    setRows((prev) => {
      const existing = prev.find((r) => r.productId === product.id);
      if (existing) {
        const nextQty = existing.countedQty + increment;
        setFlashId(existing.productId);
        toast({
          title: "Updated",
          description: `${existing.name}: ${existing.countedQty} → ${nextQty}`,
          variant: "success",
        });
        return prev.map((r) => (r.productId === product.id ? { ...r, countedQty: nextQty } : r));
      }
      const row: Row = {
        productId: product.id,
        name: product.name,
        sku: product.sku ?? null,
        unit: product.unit,
        currentStock: Number(product.currentStock ?? 0),
        expectedQty: Number(product.currentStock ?? 0),
        countedQty: increment,
        mode: defaultMode,
        unitCostOverride: null,
        averageCost: product.averageCost != null ? Number(product.averageCost) : null,
        countedById: user?.id ?? "",
        updatedAt: new Date().toISOString(),
        lineId: undefined,
      };
      setFlashId(row.productId);
      return [row, ...prev];
    });

    lastActionRef.current = { productId: product.id, delta: increment, wasNew };
    setCanUndo(true);
    queueIncrement(product.id, increment, defaultMode);
  };

  const pickSuggestion = async (p: {
    id: string;
    name: string;
    sku?: string | null;
    unit: string;
    currentStock: number;
    averageCost?: number | null;
  }) => {
    const sid = await ensureSession();
    if (!sid) return;
    addOrIncrementProduct(p, qtyPerScan);
    setScanInput("");
    setSuggestOpen(false);
  };

  const handleScan = async (rawCode: string) => {
    const code = rawCode.trim();
    if (!code) return;
    setScanInput("");
    setResolving(true);
    try {
      const sid = await ensureSession();
      if (!sid) return;
      const result = await resolveProductByCode(code);
      if (result.archived) {
        // F30 / R5: counting a retired product would post variance movements
        // against something the tenant has taken out of service — say what it
        // actually is instead of counting it or claiming it doesn't exist.
        toast({
          title: archivedMessage(result.product),
          description: "Reactivate it on the Products page to count it.",
          variant: "error",
        });
        return;
      }
      if (result.notFound) {
        setUnknownCode(code);
        return;
      }
      addOrIncrementProduct(result.product, qtyPerScan);
      if (result.source !== "barcode") {
        toast({
          title: "Matched by " + (result.source === "sku" ? "SKU" : "search"),
          description: `Linked to ${result.product.name}.`,
          variant: "info",
        });
      }
    } catch {
      toast({
        title: "Lookup failed",
        description: "Network or server error — try again.",
        variant: "error",
      });
    } finally {
      setResolving(false);
      scanInputRef.current?.focus();
    }
  };

  const onUndoLastScan = async () => {
    const last = lastActionRef.current;
    if (!last) return;
    lastActionRef.current = null;
    setCanUndo(false);
    if (last.wasNew) {
      setRows((prev) => prev.filter((r) => r.productId !== last.productId));
      pendingRef.current.delete(last.productId);
      if (sessionId) {
        try {
          await removeLine.mutateAsync({ sessionId, productId: last.productId });
        } catch {
          // Best-effort — worst case an empty/stale line lingers until next commit review.
        }
      }
    } else {
      setRows((prev) =>
        prev.map((r) =>
          r.productId === last.productId ? { ...r, countedQty: r.countedQty - last.delta } : r,
        ),
      );
      const currentMode =
        rowsRef.current.find((r) => r.productId === last.productId)?.mode ?? defaultMode;
      queueIncrement(last.productId, -last.delta, currentMode);
    }
    updateUnsavedCount();
    toast({ title: "Scan undone", variant: "info" });
  };

  const onChangeQty = (productId: string, qty: number) => {
    setRows((prev) => prev.map((r) => (r.productId === productId ? { ...r, countedQty: qty } : r)));
    queueAbsolute(productId, { countedQty: qty });
  };

  const onChangeMode = (productId: string, mode: StockCountMode) => {
    setRows((prev) => prev.map((r) => (r.productId === productId ? { ...r, mode } : r)));
    queueAbsolute(productId, { mode });
  };

  const onChangeUnitCost = (productId: string, unitCost: number | null) => {
    setRows((prev) =>
      prev.map((r) => (r.productId === productId ? { ...r, unitCostOverride: unitCost } : r)),
    );
    queueAbsolute(productId, { unitCostOverride: unitCost });
  };

  const removeRowEverywhere = async (productId: string) => {
    pendingRef.current.delete(productId);
    setRows((prev) => prev.filter((r) => r.productId !== productId));
    setSelected((prev) => {
      if (!prev.has(productId)) return prev;
      const next = new Set(prev);
      next.delete(productId);
      return next;
    });
    if (sessionId) {
      try {
        await removeLine.mutateAsync({ sessionId, productId });
      } catch {
        toast({
          title: "Couldn't remove that line",
          description: "It may still be counted on the server — try again.",
          variant: "error",
        });
      }
    }
    updateUnsavedCount();
  };

  const onToggleSelect = (productId: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(productId)) next.delete(productId);
      else next.add(productId);
      return next;
    });
  };

  const onApplyModeToSelection = (mode: StockCountMode) => {
    setRows((prev) => prev.map((r) => (selected.has(r.productId) ? { ...r, mode } : r)));
    selected.forEach((productId) => queueAbsolute(productId, { mode }));
  };

  const onApplyQtyToSelection = (qty: number) => {
    setRows((prev) => prev.map((r) => (selected.has(r.productId) ? { ...r, countedQty: qty } : r)));
    selected.forEach((productId) => queueAbsolute(productId, { countedQty: qty }));
  };

  const onRemoveSelected = async () => {
    const ids = Array.from(selected);
    for (const id of ids) await removeRowEverywhere(id);
  };

  const onDiscardSession = async () => {
    if (!sessionId) return;
    if (
      !window.confirm(
        "Discard this stock count? Everything counted so far will be lost — this can't be undone.",
      )
    )
      return;
    try {
      await discardSession.mutateAsync(sessionId);
    } catch {
      toast({
        title: "Couldn't discard",
        description: "Check your connection and try again.",
        variant: "error",
      });
      return;
    }
    setSessionId(null);
    resetLocalSession();
    setCommitNotes("");
    toast({ title: "Count discarded", variant: "info" });
  };

  const onCommit = async () => {
    if (!sessionId) return;
    try {
      const result = await commitSession.mutateAsync({
        sessionId,
        notes: commitNotes.trim() || undefined,
      });
      setReviewOpen(false);
      const applied = result.applied;
      setSessionId(null);
      resetLocalSession();
      setCommitNotes("");
      toast({
        title: result.alreadyCommitted
          ? "Already committed"
          : `Committed ${applied} change${applied === 1 ? "" : "s"}`,
        description:
          result.skipped > 0 ? `${result.skipped} no-op row(s) were skipped.` : undefined,
        variant: "success",
      });
    } catch (err: any) {
      const missing: string[] | undefined = err?.response?.data?.missingProductIds;
      if (Array.isArray(missing) && missing.length) {
        toast({
          title: "Some products no longer exist",
          description: `${missing.length} row(s) reference deleted products — remove them and retry.`,
          variant: "error",
        });
      } else {
        toast({
          title: "Commit failed",
          description: "Your count is safe on the server — try again or check the connection.",
          variant: "error",
        });
      }
    }
  };

  // ─── Derived ───────────────────────────────────────────────────────────────
  const summary = React.useMemo(() => {
    let deltaSum = 0;
    let changes = 0;
    for (const r of rows) {
      const d = computeQtyVariance(r);
      if (d !== 0) changes += 1;
      deltaSum += d;
    }
    return { deltaSum, changes };
  }, [rows]);

  // ─── Render ────────────────────────────────────────────────────────────────
  return (
    <div className="space-y-4">
      <div className="flex items-center justify-end">
        <Link
          href="/inventory/stock-counts"
          className="flex items-center gap-1.5 text-sm text-navy/70 hover:text-navy hover:underline"
        >
          <History className="h-4 w-4" />
          Count history
        </Link>
      </div>

      {!sessionId && openSessions.length > 0 && (
        <Card className="space-y-2 border-brand-200 bg-brand-50/50">
          <p className="text-sm font-medium text-navy">
            {openSessions.length === 1
              ? "A stock count is already open"
              : `${openSessions.length} stock counts are already open`}
          </p>
          {openSessions.map((s) => (
            <div
              key={s.id}
              className="flex items-center justify-between gap-3 rounded border border-brand-200 bg-white px-3 py-2"
            >
              <div className="text-sm">
                <span className="font-medium text-navy">{s.name || "Stock count"}</span>
                <span className="text-navy/70">
                  {" "}
                  · started {fmtDate(s.startedAt)}
                  {s.startedBy
                    ? ` by ${s.startedById === user?.id ? "you" : s.startedBy.username}`
                    : ""}{" "}
                  · {s._count?.lines ?? 0} item{(s._count?.lines ?? 0) === 1 ? "" : "s"}
                </span>
              </div>
              <Button size="sm" variant="secondary" onClick={() => resumeSession(s.id)}>
                Resume
              </Button>
            </div>
          ))}
          <p className="text-[11px] text-navy/70">
            Scanning below starts a brand-new count instead — you can always resume one of these
            later from Count history.
          </p>
        </Card>
      )}

      <Card className="space-y-3">
        <div className="flex flex-wrap items-end gap-3">
          <div ref={scanContainerRef} className="relative flex-1 min-w-[260px]">
            <label className="mb-1 block text-xs font-medium text-navy">
              Scan or type SKU / barcode
            </label>
            <div className="flex gap-2">
              <input
                ref={scanInputRef}
                type="text"
                value={scanInput}
                onChange={(e) => {
                  setScanInput(e.target.value);
                  setSuggestOpen(true);
                }}
                onFocus={() => {
                  if (scanInput.trim()) setSuggestOpen(true);
                }}
                onKeyDown={(e) => {
                  if (e.key === "ArrowDown") {
                    e.preventDefault();
                    setSuggestOpen(true);
                    setSuggestIndex((i) => Math.min(i + 1, Math.max(0, suggestions.length - 1)));
                  } else if (e.key === "ArrowUp") {
                    e.preventDefault();
                    setSuggestIndex((i) => Math.max(0, i - 1));
                  } else if (e.key === "Escape") {
                    setSuggestOpen(false);
                  } else if (e.key === "Enter") {
                    e.preventDefault();
                    if (suggestOpen && suggestions[suggestIndex]) {
                      pickSuggestion(suggestions[suggestIndex]);
                    } else {
                      handleScan(scanInput);
                      setSuggestOpen(false);
                    }
                  }
                }}
                placeholder="Scan with USB or webcam, or type to search"
                autoFocus
                className="flex-1 rounded border border-surface-border px-3 py-2 text-sm text-navy focus:outline-none focus:ring-2 focus:ring-brand-500"
              />
              <BarcodeScannerButton inputRef={scanInputRef} onScan={handleScan} />
            </div>
            {resolving && <p className="mt-1 text-xs text-navy/70">Looking up product…</p>}

            {suggestOpen && suggestions.length > 0 && (
              <ul
                role="listbox"
                className="absolute left-0 right-12 top-full z-20 mt-1 max-h-72 overflow-y-auto rounded-md border border-surface-border bg-white shadow-lg"
              >
                {suggestions.map((p, idx) => (
                  <li
                    key={p.id}
                    role="option"
                    aria-selected={idx === suggestIndex}
                    onMouseEnter={() => setSuggestIndex(idx)}
                    onMouseDown={(e) => {
                      e.preventDefault();
                      pickSuggestion(p);
                      scanInputRef.current?.focus();
                    }}
                    className={cn(
                      "cursor-pointer px-3 py-2 text-sm",
                      idx === suggestIndex ? "bg-brand-50" : "hover:bg-surface-raised",
                    )}
                  >
                    <div className="font-medium text-navy">{p.name}</div>
                    <div className="flex items-center gap-2 text-xs text-navy/70">
                      {p.sku && <span>SKU {p.sku}</span>}
                      <span>·</span>
                      {/* PIECE count — never labelled with `p.unit` (the box noun). */}
                      <span>{unitsLabel(p.currentStock, p.unitsPerBox, p.unit)}</span>
                      {p.category && (
                        <>
                          <span>·</span>
                          <span>{p.category}</span>
                        </>
                      )}
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </div>

          <div className="w-28">
            <label className="mb-1 block text-xs font-medium text-navy">Qty per scan</label>
            <input
              type="number"
              min={0}
              step={0.001}
              value={qtyPerScan}
              onChange={(e) => setQtyPerScan(Number(e.target.value) || 0)}
              className="w-full rounded border border-surface-border px-3 py-2 text-right text-sm text-navy focus:outline-none focus:ring-2 focus:ring-brand-500"
            />
          </div>

          <div className="w-44">
            <label className="mb-1 block text-xs font-medium text-navy">
              Default mode for new rows
            </label>
            <select
              value={defaultMode}
              onChange={(e) => setDefaultMode(e.target.value as StockCountMode)}
              className="w-full rounded border border-surface-border px-3 py-2 text-sm text-navy focus:outline-none focus:ring-2 focus:ring-brand-500"
            >
              <option value="ADD">Add to existing</option>
              <option value="REPLACE">Replace count</option>
            </select>
          </div>

          <Button
            type="button"
            variant="ghost"
            onClick={onUndoLastScan}
            disabled={!canUndo}
            leftIcon={<Undo2 size={16} />}
          >
            Undo last scan
          </Button>

          <Button
            type="button"
            variant="ghost"
            onClick={onDiscardSession}
            disabled={!sessionId || !rows.length}
            leftIcon={<Trash2 size={16} />}
          >
            Discard session
          </Button>
        </div>

        {sessionId ? (
          <div className="flex flex-wrap items-center gap-2 text-[11px] text-navy/70">
            <span>
              Counting {sessionMeta?.name ? `"${sessionMeta.name}"` : "(untitled)"}
              {sessionMeta ? ` · started ${fmtDate(sessionMeta.startedAt)}` : ""} — autosaved to the
              server as you go.
            </span>
            {unsavedCount > 0 ? (
              <span className="inline-flex items-center gap-1 rounded-full bg-warning-bg px-2 py-0.5 font-medium text-[#B45309]">
                <RefreshCw size={11} className="animate-spin" />
                {unsavedCount} unsaved
              </span>
            ) : syncError ? (
              <button
                type="button"
                onClick={() => flushRef.current()}
                className="inline-flex items-center gap-1 rounded-full bg-danger-bg px-2 py-0.5 font-medium text-[#B91C1C]"
              >
                <RefreshCw size={11} />
                Sync failed — retry
              </button>
            ) : (
              <span className="inline-flex items-center gap-1 rounded-full bg-success-bg px-2 py-0.5 font-medium text-[#15803D]">
                All changes saved
              </span>
            )}
          </div>
        ) : (
          <p className="text-[11px] text-navy/70">
            Scanning starts a new count. Pause any time — you can pick it up later from any device
            via the strip above or Count history.
          </p>
        )}
      </Card>

      <StockCountBulkBar
        selectedCount={selected.size}
        onApplyMode={onApplyModeToSelection}
        onApplyQty={onApplyQtyToSelection}
        onClearSelection={() => setSelected(new Set())}
        onRemoveSelected={onRemoveSelected}
      />

      {rows.length === 0 ? (
        <Card className="flex flex-col items-center justify-center gap-2 py-12 text-center">
          <Camera className="h-8 w-8 text-navy/30" />
          <p className="text-sm font-medium text-navy">No items scanned yet</p>
          <p className="max-w-md text-xs text-navy/70">
            Scan a barcode, type a SKU, or use a USB scanner. Unknown codes will prompt you to add a
            new product.
          </p>
        </Card>
      ) : (
        <Card className="overflow-hidden p-0">
          <table className="w-full">
            <thead>
              <tr className="border-b border-surface-border bg-surface-raised text-left text-xs uppercase tracking-wide text-navy/70">
                <th className="px-3 py-2 w-10"></th>
                <th className="px-3 py-2">Product</th>
                <th className="px-3 py-2 text-right">Expected</th>
                <th className="px-3 py-2">Counted</th>
                <th className="px-3 py-2">Mode</th>
                <th className="px-3 py-2 text-right">Δ</th>
                <th className="px-3 py-2 w-10"></th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <StockCountRow
                  key={r.productId}
                  row={r}
                  selected={selected.has(r.productId)}
                  flashing={flashId === r.productId}
                  onToggleSelect={onToggleSelect}
                  onChangeQty={onChangeQty}
                  onChangeMode={onChangeMode}
                  onRemove={removeRowEverywhere}
                />
              ))}
            </tbody>
          </table>
        </Card>
      )}

      {rows.length > 0 && (
        <div className="flex items-center justify-between">
          <p className="text-sm text-navy/70">
            {rows.length} item{rows.length === 1 ? "" : "s"} · {summary.changes} change
            {summary.changes === 1 ? "" : "s"} · ΣΔ ={" "}
            <span
              className={cn(
                "font-medium",
                summary.deltaSum > 0
                  ? "text-success"
                  : summary.deltaSum < 0
                    ? "text-danger"
                    : "text-navy",
              )}
            >
              {summary.deltaSum > 0 ? "+" : ""}
              {summary.deltaSum}
            </span>
          </p>
          <Button
            type="button"
            onClick={() => setReviewOpen(true)}
            disabled={summary.changes === 0}
          >
            Review &amp; Commit
          </Button>
        </div>
      )}

      <StockCountReviewModal
        isOpen={reviewOpen}
        rows={rows}
        notes={commitNotes}
        onChangeNotes={setCommitNotes}
        onClose={() => setReviewOpen(false)}
        onConfirm={onCommit}
        isSubmitting={commitSession.isPending}
        unsavedCount={unsavedCount}
        syncError={syncError}
        onRetrySync={() => flushRef.current()}
        onChangeQty={onChangeQty}
        onChangeUnitCost={onChangeUnitCost}
        onRemoveRow={removeRowEverywhere}
        uncountedCount={uncountedCount}
      />

      <InlineCreateProductModal
        isOpen={!!unknownCode}
        initialSku={unknownCode ?? ""}
        onClose={() => setUnknownCode(null)}
        onCreated={async (product) => {
          setUnknownCode(null);
          const sid = await ensureSession();
          if (!sid) return;
          addOrIncrementProduct({ ...product, currentStock: 0 }, qtyPerScan);
        }}
      />

      <Modal
        open={!!otherOpenWarning}
        onClose={() => setOtherOpenWarning(null)}
        title="Another count is already open"
        description="You can keep counting in this new one, or switch to a count already in progress."
        footer={
          <Button variant="secondary" onClick={() => setOtherOpenWarning(null)}>
            Keep this new count
          </Button>
        }
      >
        <div className="space-y-2">
          {(otherOpenWarning ?? []).map((s) => (
            <div
              key={s.id}
              className="flex items-center justify-between gap-3 rounded border border-surface-border px-3 py-2"
            >
              <div className="text-sm">
                <div className="font-medium text-navy">{s.name || "Stock count"}</div>
                <div className="text-xs text-navy/70">started {fmtDate(s.startedAt)}</div>
              </div>
              <Button size="sm" onClick={() => switchToOtherSession(s.id)}>
                Open instead
              </Button>
            </div>
          ))}
        </div>
      </Modal>
    </div>
  );
}
