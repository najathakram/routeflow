"use client";

// SA-748: the counter header's "Park" and "Parked (n)" buttons, their messages and the two dialogs. Own file so
// CounterSaleScreen takes one mount line and the state setters it already owns.
import * as React from "react";
import { useQuery } from "@tanstack/react-query";
import { useRouter } from "next/navigation";
import { Button, useToast } from "@routeflow/ui/web";
import { apiClient } from "@/lib/api-client";
import { useDeleteDraft, useDrafts, type SaleDraft } from "@/lib/api/drafts";
import { setCounterAutoParkHook } from "@/lib/counter-cart-signal";
import { formatMoney } from "@/lib/format";
import { cartTotals } from "@/lib/counter-sale";
import { PARKED_EDITED_PRICES_COPY } from "@/lib/counter-park";
import { ParkedSalesDialog, type UndoNote } from "./ParkedSalesDialog";
import { getImpersonation } from "@/lib/impersonation";
import { discardUndo, useParkedSales, type ParkedSalesDeps } from "./useParkedSales";
import { useWaitingDiscards } from "@/lib/use-waiting-discards";

export interface ParkedSalesProps extends ParkedSalesDeps {
  /** the ONE price-edit gate (`canEditPrices(user)`) of the person completing this sale */
  canEditPrices: boolean;
}

const itemsLabel = (n: number): string => (n === 1 ? "1 item" : `${n} items`);

/** "12 min ago" / "3 h ago" / "2 d ago": how long the oldest parked sale has waited. */
function parkedAge(iso: string | undefined, nowMs: number = Date.now()): string {
  const t = iso ? Date.parse(iso) : NaN;
  if (!Number.isFinite(t)) return "earlier";
  const min = Math.max(0, Math.round((nowMs - t) / 60_000));
  if (min < 60) return `${min} min ago`;
  if (min < 60 * 24) return `${Math.round(min / 60)} h ago`;
  return `${Math.round(min / 1440)} d ago`;
}

export function ParkedSales({ canEditPrices, ...deps }: ParkedSalesProps) {
  const { toast, dismiss } = useToast();
  // The Undo also lives INSIDE the Parked window: the toast sits outside it, and the window hides everything else from a
  // keyboard and a screen reader. One note per waiting discard; it goes when its toast closes or the Undo is used.
  const [undoNotes, setUndoNotes] = React.useState<UndoNote[]>([]);
  const dropNote = (id: string) => setUndoNotes((n) => n.filter((x) => x.id !== id));
  // A toast can close early (Escape, a swipe) while the Parked window still shows that discard's Undo. The delete is held until
  // no Undo for its token is showing: it leaves when the window closes (or the screen goes), never under a visible Undo.
  const windowOpenRef = React.useRef(false);
  const heldCommits = React.useRef(new Map<string, () => void>());
  const toastClosed = (token: string, commit: () => void) => {
    if (windowOpenRef.current) {
      heldCommits.current.set(token, commit);
      return;
    }
    dropNote(token);
    commit();
  };
  const flushHeld = () => {
    const held = [...heldCommits.current];
    heldCommits.current.clear();
    for (const [token, commit] of held) {
      dropNote(token);
      commit();
    }
  };
  // Discard is taken back, not confirmed (owner rule: autosave + Undo; confirm only for sent or posted money).
  // The delete leaves when the toast CLOSES (expiry, close, swipe), so an Undo on screen can always undo.
  const p = useParkedSales({
    ...deps,
    onDiscarded: (undo, row) => {
      let toastId = "";
      const back = () => {
        undo();
        dropNote(row.token);
      };
      setUndoNotes((n) => [
        ...n,
        {
          id: row.token,
          text: `Discarded · ${row.label}`,
          // used inside the window: the toast it belongs to closes with it
          undo: () => {
            back();
            if (toastId) dismiss(toastId);
          },
        },
      ]);
      toastId = toast({
        title: `Discarded · ${row.label}`,
        description: "The parked sale is gone unless you undo.",
        action: { label: "Undo", onClick: back },
        duration: discardUndo.ms,
        onDismiss: () => toastClosed(row.token, row.commit),
      });
    },
  });
  windowOpenRef.current = p.open;
  const flushHeldRef = React.useRef(flushHeld);
  flushHeldRef.current = flushHeld;
  React.useEffect(() => {
    if (!p.open) flushHeldRef.current();
  }, [p.open]);
  React.useEffect(
    () => () => {
      flushHeldRef.current();
      windowOpenRef.current = false; // a toast that closes after the screen is gone has no window to wait for
    },
    [],
  );
  const { data: draftRows } = useDrafts();
  const delDraft = useDeleteDraft();
  // An order draft Discard is taken back like a sale Discard: the row hides, the delete leaves when its Undo toast closes.
  const draftWaiting = useWaitingDiscards();
  const delDraftRef = React.useRef(delDraft.mutate);
  delDraftRef.current = delDraft.mutate;
  const commitDraft = (token: string) => {
    const id = draftWaiting.commit(token);
    if (id === null) return; // taken back or already sent
    delDraftRef.current(id, { onError: () => draftWaiting.failed(id) });
  };
  const discardDraft = (d: SaleDraft, title: string) => {
    const token = draftWaiting.begin(d.id);
    let toastId = "";
    const back = () => {
      if (draftWaiting.undo(token)) dropNote(token);
    };
    setUndoNotes((n) => [
      ...n,
      {
        id: token,
        text: `Discarded · ${title}`,
        undo: () => {
          back();
          if (toastId) dismiss(toastId);
        },
      },
    ]);
    toastId = toast({
      title: `Discarded · ${title}`,
      description: "The order draft is gone unless you undo.",
      action: { label: "Undo", onClick: back },
      duration: discardUndo.ms,
      onDismiss: () => toastClosed(token, () => commitDraft(token)),
    });
  };
  const drafts = (Array.isArray(draftRows) ? draftRows : []).filter(
    // SA-1222: a PURCHASE_ORDER draft belongs to the Create PO surface, never to the order window
    (d) => d.kind !== "PURCHASE_ORDER" && !draftWaiting.hidden.has(d.id),
  );
  const router = useRouter();
  const { data: settings } = useQuery<{ taxRate?: number | null }>({
    queryKey: ["settings"],
    queryFn: () => apiClient.get("/settings").then((r) => r.data),
    staleTime: 60_000,
  });
  const taxRate = (settings?.taxRate ?? 0) / 100;
  // W-1184: every way out of the counter parks the open sale instead of asking "Discard this sale?". The latest park
  // function is read through a ref so the registered hook never goes stale.
  const parkForLeaveRef = React.useRef(p.parkForLeave);
  parkForLeaveRef.current = p.parkForLeave;
  React.useEffect(() => {
    setCounterAutoParkHook(async () => {
      // A support session never parks into the client's business: the old Discard question stays there.
      if (getImpersonation()) return false;
      const { ok, parked } = await parkForLeaveRef.current();
      if (ok) {
        const id = parked?.id;
        toast({
          title: parked
            ? `Sale parked · ${itemsLabel(parked.items)} · ${formatMoney(parked.total)}`
            : "Sale parked",
          description: "Find it under Parked to pick it back up.",
          variant: "success",
          duration: 7000, // long enough to read where the sale went and to reach Undo
          ...(id
            ? {
                action: {
                  label: "Undo",
                  onClick: () =>
                    router.push(`/orders/counter-sale?resume=${encodeURIComponent(id)}`),
                },
              }
            : {}),
        });
      }
      return ok;
    });
    return () => setCounterAutoParkHook(null);
  }, [toast, router]);
  // The toast's Undo lands here as ?resume=<id>: take that sale back once, then drop the param.
  // (read from the address bar once: the shell tests mount this without a search-params provider)
  const resumedRef = React.useRef<string | null>(null);
  const startResumeRef = React.useRef(p.startResume);
  startResumeRef.current = p.startResume;
  React.useEffect(() => {
    const resumeId = new URLSearchParams(window.location.search).get("resume");
    if (!resumeId || resumedRef.current === resumeId || !p.canResume) return;
    resumedRef.current = resumeId;
    startResumeRef.current(resumeId);
    router.replace("/orders/counter-sale");
  }, [p.canResume, router]);
  // One tap back into the newest parked sale when the till is empty.
  const newest = p.rows[0];
  const showResume = !!newest && deps.cart.lines.length === 0 && p.canResume;
  const newestTotal =
    newest?.priceLines && newest.priceLines.length > 0
      ? cartTotals(newest.priceLines, taxRate).total
      : null;
  const openerRef = React.useRef<HTMLButtonElement>(null);
  // An edited price is checked at Complete against the COMPLETING user (the server refuses it with a fixed 403 copy). A person
  // who cannot edit prices has no Reset control, so a resumed edited line says so up front instead of failing silently.
  const hasEditedLine = deps.cart.lines.some((l) => !!(l as { override?: unknown }).override);
  const headerMessage = p.message?.scope === "header" ? p.message.text : null;
  return (
    <>
      <div
        className="flex w-full flex-nowrap items-center gap-2 sm:w-auto [&>button]:flex-1 sm:[&>button]:flex-none"
        data-testid="counter-park-actions"
      >
        <Button className="min-h-[44px]" variant="secondary" disabled={!p.canPark} onClick={p.park}>
          Park
        </Button>
        <Button
          ref={openerRef}
          className="min-h-[44px]"
          variant="secondary"
          onClick={() => p.setOpen(true)}
        >
          {p.count + drafts.length > 0 ? `Parked (${p.count + drafts.length})` : "Parked"}
        </Button>
      </div>
      {showResume ? (
        <div
          className="flex w-full flex-wrap items-center gap-2 rounded-md border border-teal/30 bg-teal/5 px-3 py-2"
          data-testid="counter-resume-bar"
        >
          <Button className="min-h-[44px]" onClick={() => p.startResume(newest.id)}>
            {`Resume sale (${itemsLabel(newest.itemCount ?? newest.lineCount)}${
              newestTotal !== null ? `, ${formatMoney(newestTotal)}` : ""
            })`}
          </Button>
          {p.count > 1 ? (
            <span className="text-sm text-navy/70" data-testid="counter-parked-more">
              {`${p.count - 1} more parked, oldest ${parkedAge(p.rows[p.rows.length - 1]?.createdAt)}`}
            </span>
          ) : null}
        </div>
      ) : null}
      {headerMessage ? (
        <p role="alert" className="w-full text-sm text-red-700" data-testid="counter-park-error">
          {headerMessage}
        </p>
      ) : null}
      {!canEditPrices && hasEditedLine ? (
        <p
          role="status"
          className="w-full text-sm text-amber-800"
          data-testid="counter-park-edited"
        >
          {PARKED_EDITED_PRICES_COPY}
        </p>
      ) : null}
      <ParkedSalesDialog
        parked={p}
        openerRef={openerRef}
        drafts={drafts}
        onDiscardDraft={discardDraft}
        undoNotes={undoNotes}
      />
    </>
  );
}
