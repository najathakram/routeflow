"use client";

import * as React from "react";
import { Camera, Plus, Trash2 } from "lucide-react";
import { Button, Card, cn, useToast } from "@routeflow/ui/web";

import { BarcodeScannerButton } from "@/components/BarcodeScannerButton";
import { InlineCreateProductModal } from "@/components/InlineCreateProductModal";
import { resolveProductByCode } from "@/lib/barcode-resolve";
import { useStockOverview } from "@/lib/api/inventory";
import { useCommitStockCount } from "@/lib/api/stock-count";
import {
  clearSession,
  loadSession,
  makeId,
  saveSession,
  type StockCountMode,
  type StockCountRow as Row,
  type StockCountSession,
} from "@/lib/stock-count-storage";

import { StockCountBulkBar } from "./StockCountBulkBar";
import { StockCountRow } from "./StockCountRow";
import { StockCountReviewModal } from "./StockCountReviewModal";

/** Read the tenant-slug cookie set by the Next.js middleware so the session key
 *  is scoped per tenant — otherwise super-admin impersonations would leak. */
function readTenantSlug(): string | null {
  if (typeof document === "undefined") return null;
  const impersonation =
    typeof window !== "undefined" ? window.localStorage.getItem("impersonationTenantSlug") : null;
  if (impersonation) return impersonation;
  const match = document.cookie.match(/(?:^|;\s*)tenant-slug=([^;]+)/);
  return match ? decodeURIComponent(match[1]) : null;
}

function newSession(): StockCountSession {
  return {
    sessionId: makeId(),
    startedAt: new Date().toISOString(),
    defaultMode: "ADD",
    qtyPerScan: 1,
    rows: [],
  };
}

export function StockCountTab() {
  const { toast } = useToast();
  const commit = useCommitStockCount();

  const [tenantSlug, setTenantSlug] = React.useState<string | null>(null);
  const [hydrated, setHydrated] = React.useState(false);

  const [session, setSession] = React.useState<StockCountSession>(() => newSession());
  const [selected, setSelected] = React.useState<Set<string>>(new Set());
  const [flashId, setFlashId] = React.useState<string | null>(null);

  const [scanInput, setScanInput] = React.useState("");
  const scanInputRef = React.useRef<HTMLInputElement>(null);
  const scanContainerRef = React.useRef<HTMLDivElement>(null);
  const [resolving, setResolving] = React.useState(false);

  // Typeahead dropdown — mirrors the Stock tab's behaviour at inventory/page.tsx
  // so operators can pick a product partway through typing without scanning a
  // full code or hitting Enter.
  const [suggestOpen, setSuggestOpen] = React.useState(false);
  const [suggestIndex, setSuggestIndex] = React.useState(0);
  const { data: stockOverview } = useStockOverview();

  const [unknownCode, setUnknownCode] = React.useState<string | null>(null);
  const [reviewOpen, setReviewOpen] = React.useState(false);
  const [commitNotes, setCommitNotes] = React.useState("");

  // ─── Hydrate from localStorage on mount ────────────────────────────────────
  React.useEffect(() => {
    const slug = readTenantSlug();
    setTenantSlug(slug);
    const stored = loadSession(slug);
    if (stored) setSession(stored);
    setHydrated(true);
  }, []);

  // ─── Debounced persistence ─────────────────────────────────────────────────
  React.useEffect(() => {
    if (!hydrated) return;
    const handle = setTimeout(() => saveSession(tenantSlug, session), 200);
    return () => clearTimeout(handle);
  }, [hydrated, tenantSlug, session]);

  // ─── Flash auto-clear ──────────────────────────────────────────────────────
  React.useEffect(() => {
    if (!flashId) return;
    const handle = setTimeout(() => setFlashId(null), 800);
    return () => clearTimeout(handle);
  }, [flashId]);

  // ─── Suggestion list ──────────────────────────────────────────────────────
  // Filter the already-loaded product list (cached via useStockOverview, which
  // is also what the Stock tab uses — so this is free if the operator has
  // visited that tab in the session). Ranks: SKU exact → SKU prefix → name
  // substring → other (SKU or category substring). Caps at 8 to avoid pushing
  // the dropdown off-screen.
  const suggestions = React.useMemo(() => {
    const q = scanInput.trim().toLowerCase();
    if (!q)
      return [] as Array<{
        id: string;
        name: string;
        sku?: string | null;
        unit: string;
        currentStock: number;
        category?: string | null;
      }>;
    const items = (stockOverview ?? []) as Array<{
      id: string;
      name: string;
      sku?: string | null;
      unit: string;
      currentStock: number;
      category?: string | null;
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

  // Reset highlight when the query changes so the first match is always
  // selected on Enter.
  React.useEffect(() => setSuggestIndex(0), [scanInput]);

  // Close on outside click.
  React.useEffect(() => {
    if (!suggestOpen) return;
    const handler = (e: MouseEvent) => {
      if (!scanContainerRef.current?.contains(e.target as Node)) {
        setSuggestOpen(false);
      }
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [suggestOpen]);

  // ─── Mutators ──────────────────────────────────────────────────────────────
  const addOrIncrementProduct = React.useCallback(
    (
      product: {
        id: string;
        name: string;
        sku?: string | null;
        unit: string;
        currentStock?: number | string | null;
      },
      increment: number,
    ) => {
      setSession((prev) => {
        const existing = prev.rows.find((r) => r.productId === product.id);
        if (existing) {
          setFlashId(existing.rowId);
          toast({
            title: "Updated",
            description: `${existing.name}: ${existing.scannedQty} → ${existing.scannedQty + increment}`,
            variant: "success",
          });
          return {
            ...prev,
            rows: prev.rows.map((r) =>
              r.rowId === existing.rowId ? { ...r, scannedQty: r.scannedQty + increment } : r,
            ),
          };
        }
        const row: Row = {
          rowId: makeId(),
          productId: product.id,
          name: product.name,
          sku: product.sku ?? null,
          unit: product.unit,
          currentStockSnapshot: Number(product.currentStock ?? 0),
          scannedQty: increment,
          mode: prev.defaultMode,
        };
        setFlashId(row.rowId);
        return { ...prev, rows: [row, ...prev.rows] };
      });
    },
    [toast],
  );

  const handleScan = React.useCallback(
    async (rawCode: string) => {
      const code = rawCode.trim();
      if (!code) return;
      setScanInput("");
      setResolving(true);
      try {
        const result = await resolveProductByCode(code);
        if (result.notFound) {
          setUnknownCode(code);
          return;
        }
        addOrIncrementProduct(result.product, session.qtyPerScan);
        if (result.source !== "barcode") {
          toast({
            title: "Matched by " + (result.source === "sku" ? "SKU" : "search"),
            description: `Linked to ${result.product.name}.`,
            variant: "info",
          });
        }
      } catch (err) {
        toast({
          title: "Lookup failed",
          description: "Network or server error — try again.",
          variant: "error",
        });
      } finally {
        setResolving(false);
        scanInputRef.current?.focus();
      }
    },
    [addOrIncrementProduct, session.qtyPerScan, toast],
  );

  const onChangeQty = React.useCallback((rowId: string, qty: number) => {
    setSession((prev) => ({
      ...prev,
      rows: prev.rows.map((r) =>
        r.rowId === rowId ? { ...r, scannedQty: Number.isFinite(qty) ? qty : 0 } : r,
      ),
    }));
  }, []);

  const onChangeMode = React.useCallback((rowId: string, mode: StockCountMode) => {
    setSession((prev) => ({
      ...prev,
      rows: prev.rows.map((r) => (r.rowId === rowId ? { ...r, mode } : r)),
    }));
  }, []);

  const onRemoveRow = React.useCallback((rowId: string) => {
    setSession((prev) => ({ ...prev, rows: prev.rows.filter((r) => r.rowId !== rowId) }));
    setSelected((prev) => {
      if (!prev.has(rowId)) return prev;
      const next = new Set(prev);
      next.delete(rowId);
      return next;
    });
  }, []);

  const onToggleSelect = React.useCallback((rowId: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(rowId)) next.delete(rowId);
      else next.add(rowId);
      return next;
    });
  }, []);

  const onApplyModeToSelection = React.useCallback(
    (mode: StockCountMode) => {
      setSession((prev) => ({
        ...prev,
        rows: prev.rows.map((r) => (selected.has(r.rowId) ? { ...r, mode } : r)),
      }));
    },
    [selected],
  );

  const onApplyQtyToSelection = React.useCallback(
    (qty: number) => {
      setSession((prev) => ({
        ...prev,
        rows: prev.rows.map((r) => (selected.has(r.rowId) ? { ...r, scannedQty: qty } : r)),
      }));
    },
    [selected],
  );

  const onRemoveSelected = React.useCallback(() => {
    setSession((prev) => ({
      ...prev,
      rows: prev.rows.filter((r) => !selected.has(r.rowId)),
    }));
    setSelected(new Set());
  }, [selected]);

  const onDiscardSession = React.useCallback(() => {
    if (!session.rows.length) return;
    if (!window.confirm("Discard the current scan session? This can't be undone.")) return;
    clearSession(tenantSlug);
    setSession(newSession());
    setSelected(new Set());
    setCommitNotes("");
    toast({ title: "Session discarded", variant: "info" });
  }, [session.rows.length, tenantSlug, toast]);

  const onCommit = React.useCallback(async () => {
    if (!session.rows.length) return;
    try {
      const result = await commit.mutateAsync({
        sessionId: session.sessionId,
        notes: commitNotes.trim() || undefined,
        items: session.rows.map((r) => ({
          productId: r.productId,
          quantity: r.scannedQty,
          mode: r.mode,
        })),
      });
      clearSession(tenantSlug);
      setSession(newSession());
      setSelected(new Set());
      setCommitNotes("");
      setReviewOpen(false);
      toast({
        title: `Committed ${result.applied} change${result.applied === 1 ? "" : "s"}`,
        description: result.skipped > 0 ? `${result.skipped} no-op rows were skipped.` : undefined,
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
          description: "Your scan session is safe. Try again or check the connection.",
          variant: "error",
        });
      }
    }
  }, [commit, session.rows, session.sessionId, commitNotes, tenantSlug, toast]);

  // ─── Derived ───────────────────────────────────────────────────────────────
  const summary = React.useMemo(() => {
    let deltaSum = 0;
    let changes = 0;
    for (const r of session.rows) {
      const d = r.mode === "REPLACE" ? r.scannedQty - r.currentStockSnapshot : r.scannedQty;
      if (d !== 0) changes += 1;
      deltaSum += d;
    }
    return { deltaSum, changes };
  }, [session.rows]);

  // ─── Render ────────────────────────────────────────────────────────────────
  return (
    <div className="space-y-4">
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
                    // If a suggestion is highlighted, pick it; otherwise fall
                    // back to the resolver (handles SKUs not in the local
                    // overview cache and unknown-code → create flow).
                    if (suggestOpen && suggestions[suggestIndex]) {
                      const p = suggestions[suggestIndex];
                      addOrIncrementProduct(p, session.qtyPerScan);
                      setScanInput("");
                      setSuggestOpen(false);
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

            {/* Typeahead dropdown */}
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
                      // mousedown so the input doesn't blur first
                      e.preventDefault();
                      addOrIncrementProduct(p, session.qtyPerScan);
                      setScanInput("");
                      setSuggestOpen(false);
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
                      <span>
                        {p.currentStock} {p.unit}
                      </span>
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
              value={session.qtyPerScan}
              onChange={(e) =>
                setSession((prev) => ({
                  ...prev,
                  qtyPerScan: Number(e.target.value) || 0,
                }))
              }
              className="w-full rounded border border-surface-border px-3 py-2 text-right text-sm text-navy focus:outline-none focus:ring-2 focus:ring-brand-500"
            />
          </div>

          <div className="w-44">
            <label className="mb-1 block text-xs font-medium text-navy">
              Default mode for new rows
            </label>
            <select
              value={session.defaultMode}
              onChange={(e) =>
                setSession((prev) => ({
                  ...prev,
                  defaultMode: e.target.value as StockCountMode,
                }))
              }
              className="w-full rounded border border-surface-border px-3 py-2 text-sm text-navy focus:outline-none focus:ring-2 focus:ring-brand-500"
            >
              <option value="ADD">Add to existing</option>
              <option value="REPLACE">Replace count</option>
            </select>
          </div>

          <Button
            type="button"
            variant="ghost"
            onClick={onDiscardSession}
            disabled={!session.rows.length}
            leftIcon={<Trash2 size={16} />}
          >
            Discard session
          </Button>
        </div>

        <p className="text-[11px] text-navy/70">
          Your draft is auto-saved on this device. Close the tab and it&apos;s still here next time
          you open the Stock Count tab. The draft clears after a successful commit.
        </p>
      </Card>

      {/* Bulk action bar — only visible when ≥2 selected */}
      <StockCountBulkBar
        selectedCount={selected.size}
        onApplyMode={onApplyModeToSelection}
        onApplyQty={onApplyQtyToSelection}
        onClearSelection={() => setSelected(new Set())}
        onRemoveSelected={onRemoveSelected}
      />

      {/* Scanned rows table */}
      {session.rows.length === 0 ? (
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
                <th className="px-3 py-2 text-right">Current</th>
                <th className="px-3 py-2">Scanned</th>
                <th className="px-3 py-2">Mode</th>
                <th className="px-3 py-2 text-right">Δ</th>
                <th className="px-3 py-2 w-10"></th>
              </tr>
            </thead>
            <tbody>
              {session.rows.map((r) => (
                <StockCountRow
                  key={r.rowId}
                  row={r}
                  selected={selected.has(r.rowId)}
                  flashing={flashId === r.rowId}
                  onToggleSelect={onToggleSelect}
                  onChangeQty={onChangeQty}
                  onChangeMode={onChangeMode}
                  onRemove={onRemoveRow}
                />
              ))}
            </tbody>
          </table>
        </Card>
      )}

      {/* Footer summary + Review */}
      {session.rows.length > 0 && (
        <div className="flex items-center justify-between">
          <p className="text-sm text-navy/70">
            {session.rows.length} item{session.rows.length === 1 ? "" : "s"} · {summary.changes}{" "}
            change{summary.changes === 1 ? "" : "s"} · ΣΔ ={" "}
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
        rows={session.rows}
        notes={commitNotes}
        onChangeNotes={setCommitNotes}
        onClose={() => setReviewOpen(false)}
        onConfirm={onCommit}
        isSubmitting={commit.isPending}
      />

      <InlineCreateProductModal
        isOpen={!!unknownCode}
        initialSku={unknownCode ?? ""}
        onClose={() => setUnknownCode(null)}
        onCreated={(product) => {
          setUnknownCode(null);
          addOrIncrementProduct({ ...product, currentStock: 0 }, session.qtyPerScan);
        }}
      />
    </div>
  );
}
