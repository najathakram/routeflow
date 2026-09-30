"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { X, Layers, ChevronUp } from "lucide-react";
import { Button, cn, useToast } from "@routeflow/ui/web";
import { useAuth } from "@/lib/auth-context";
import { useDrafts, useDeleteDraft, type SaleDraft } from "@/lib/api/drafts";
import { draftSummary, parkedAgo } from "@/lib/drafts";
import { ConfirmDialog } from "@/components/ConfirmDialog";

/**
 * Minimize & resume drafts (pos-cost-roles-spec §2). A persistent bottom-left
 * dock, visible on every operator screen, listing parked builder drafts. Resume
 * navigates back into the builder hydrated from the draft's payload; delete asks
 * to confirm. While any draft is parked, scanning a barcode anywhere prompts
 * "Add to draft — {customer}?" (one tap) vs starting a new order.
 *
 * Only mounts its data hooks for roles that can build orders (operator / driver /
 * tenant-admin); customers never see the dock and never hit the operator-only
 * `/drafts` endpoint.
 */
export function DraftDock() {
  const { user } = useAuth();
  const role = user?.role;
  if (!role || role === "CUSTOMER") return null;
  return <DraftDockInner />;
}

// The `kind` a resumed draft routes to. Order drafts are the only kind the
// builder can create today; invoice drafts are handled once that builder is wired.
function resumeHref(draft: SaleDraft, scanCode?: string): string {
  const base = draft.kind === "INVOICE" ? "/invoices/new" : "/orders";
  // Merge the intent onto the CURRENT query when resuming from the same route
  // the dock is floating over. Building it from scratch dropped the operator's
  // list state — `?page=` and `?search=` — because the target page's deep-link
  // effect strips only the intent params and replaces with whatever is left.
  const params =
    typeof window !== "undefined" && window.location.pathname === base
      ? new URLSearchParams(window.location.search)
      : new URLSearchParams();
  params.set("resumeDraft", draft.id);
  if (scanCode) params.set("scan", scanCode);
  return `${base}?${params.toString()}`;
}

/** `?action=new` on /orders, keeping the list's own query state (see resumeHref). */
function newOrderHref(scanCode: string): string {
  const params =
    typeof window !== "undefined" && window.location.pathname === "/orders"
      ? new URLSearchParams(window.location.search)
      : new URLSearchParams();
  params.set("action", "new");
  params.set("scan", scanCode);
  return `/orders?${params.toString()}`;
}

function DraftDockInner() {
  const router = useRouter();
  const { toast } = useToast();
  const { data: drafts } = useDrafts();
  const deleteDraft = useDeleteDraft();

  const [collapsed, setCollapsed] = React.useState(true);
  const [deleteTarget, setDeleteTarget] = React.useState<SaleDraft | null>(null);
  // A pending scan awaiting the operator's "add to which draft?" choice.
  const [scanPrompt, setScanPrompt] = React.useState<string | null>(null);

  const list = drafts ?? [];
  const hasDrafts = list.length > 0;

  const resume = React.useCallback(
    (draft: SaleDraft, scanCode?: string) => {
      setScanPrompt(null);
      router.push(resumeHref(draft, scanCode));
    },
    [router],
  );

  // ── Scan-to-draft: a global wedge-scanner listener, active only while at least
  // one draft is parked. A fast keystroke burst ending in Enter (and not typed
  // into a field or while a dialog is open) is treated as a barcode; we then ask
  // which draft to add it to. Mirrors the POS scanner heuristic used elsewhere.
  React.useEffect(() => {
    if (!hasDrafts) return;
    let sequence = "";
    let lastKeyTime = 0;

    const onKeyDown = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement | null;
      const tag = el?.tagName;
      if (
        tag === "INPUT" ||
        tag === "TEXTAREA" ||
        tag === "SELECT" ||
        el?.isContentEditable ||
        // Never hijack a scan while a modal/builder is open — it handles its own.
        document.querySelector('[role="dialog"][data-state="open"]')
      ) {
        return;
      }
      const now = Date.now();
      if (e.key === "Enter") {
        if (sequence.length >= 6 && now - lastKeyTime < 200) {
          e.preventDefault();
          setScanPrompt(sequence);
        }
        sequence = "";
        return;
      }
      if (e.key.length === 1) {
        sequence = now - lastKeyTime > 200 ? e.key : sequence + e.key;
        lastKeyTime = now;
      }
    };

    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [hasDrafts]);

  if (!hasDrafts) return null;

  const visible = collapsed ? list.slice(0, 2) : list;

  return (
    <>
      {/* pointer-events-none on the wrapper so its transparent gaps never block
          clicks to page content underneath; each interactive chip re-enables them.
          bottom-24 (not bottom-4) keeps the dock clear of the bottom-center PWA
          install prompt (which lives in the bottom ~96px band, mirroring main's
          pb-24) — they can no longer overlap and hide the Resume/Discard actions. */}
      <div className="pointer-events-none absolute bottom-24 left-4 z-40 flex max-h-[70vh] w-[min(92vw,420px)] flex-col gap-2 overflow-y-auto">
        {/* Collapse control — a badge with the parked count (shown when >2). */}
        {list.length > 2 && (
          <button
            type="button"
            onClick={() => setCollapsed((c) => !c)}
            className="pointer-events-auto flex items-center gap-2 self-start rounded-full bg-navy px-3 py-1.5 text-[11.5px] font-semibold text-white shadow-modal transition-colors hover:bg-navy/90"
          >
            <Layers className="h-3.5 w-3.5 text-brand-300" />
            {list.length} parked drafts
            <ChevronUp
              className={cn("h-3.5 w-3.5 transition-transform", collapsed && "rotate-180")}
            />
          </button>
        )}

        {visible.map((draft, i) => {
          const { title, itemCount, total } = draftSummary(draft);
          return (
            <div
              key={draft.id}
              className={cn(
                "pointer-events-auto flex items-center gap-3 rounded-xl bg-navy px-3.5 py-2.5 text-white shadow-modal",
                i > 0 && "opacity-90",
              )}
            >
              <span className="shrink-0 rounded-full bg-white/10 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-brand-300">
                Draft
              </span>
              <div className="min-w-0 flex-1">
                <p className="truncate text-[13px] font-semibold">{title}</p>
                <p className="truncate text-[11.5px] text-white/55">
                  {itemCount} item{itemCount === 1 ? "" : "s"} ·{" "}
                  <span className="font-mono">${total.toFixed(2)}</span> · paused{" "}
                  {parkedAgo(draft.updatedAt)}
                </p>
              </div>
              <Button size="sm" onClick={() => resume(draft)}>
                Resume
              </Button>
              <button
                type="button"
                onClick={() => setDeleteTarget(draft)}
                className="shrink-0 rounded p-1 text-white/55 transition-colors hover:bg-white/10 hover:text-white"
                aria-label="Discard draft"
              >
                <X className="h-3.5 w-3.5" />
              </button>
            </div>
          );
        })}
      </div>

      {/* Delete confirm — parked drafts never expire, so removal is explicit. */}
      <ConfirmDialog
        open={!!deleteTarget}
        onClose={() => setDeleteTarget(null)}
        onConfirm={() => {
          if (!deleteTarget) return;
          const id = deleteTarget.id;
          deleteDraft.mutate(id, {
            onSuccess: () => toast({ title: "Draft discarded", variant: "success" }),
          });
          setDeleteTarget(null);
        }}
        title="Discard this draft?"
        description="The parked order and everything in it will be removed. This cannot be undone."
        confirmLabel="Discard"
        loading={deleteDraft.isPending}
      />

      {/* Scan-to-draft prompt — pick which parked draft the scan joins. */}
      {scanPrompt && (
        <div
          className="fixed inset-0 z-[210] flex items-end justify-center bg-black/40 p-4 backdrop-blur-sm sm:items-center"
          onClick={() => setScanPrompt(null)}
        >
          <div
            className="w-full max-w-sm overflow-hidden rounded-xl border border-surface-border bg-white shadow-modal"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="border-b border-surface-border px-5 py-3.5">
              <p className="text-sm font-semibold text-navy">Add scanned item to a draft?</p>
              <p className="mt-0.5 font-mono text-xs text-navy/60">{scanPrompt}</p>
            </div>
            <ul className="max-h-[50vh] divide-y divide-surface-border overflow-y-auto">
              {list.map((draft) => {
                const { title, itemCount } = draftSummary(draft);
                return (
                  <li key={draft.id}>
                    <button
                      type="button"
                      onClick={() => resume(draft, scanPrompt)}
                      className="flex w-full items-center justify-between gap-3 px-5 py-3 text-left transition-colors hover:bg-surface-raised"
                    >
                      <span className="min-w-0">
                        <span className="block truncate text-sm font-medium text-navy">
                          {title}
                        </span>
                        <span className="block text-xs text-navy/60">
                          {itemCount} item{itemCount === 1 ? "" : "s"}
                        </span>
                      </span>
                      <span className="shrink-0 text-xs font-semibold text-brand-600">Add</span>
                    </button>
                  </li>
                );
              })}
            </ul>
            <div className="border-t border-surface-border px-5 py-3">
              <button
                type="button"
                onClick={() => {
                  setScanPrompt(null);
                  router.push(newOrderHref(scanPrompt));
                }}
                className="text-sm font-medium text-navy/70 hover:text-navy"
              >
                Start a new order instead
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
