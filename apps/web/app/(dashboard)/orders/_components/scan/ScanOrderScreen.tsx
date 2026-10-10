"use client";

import * as React from "react";
import { createPortal, flushSync } from "react-dom";
import { AlertTriangle, Keyboard, Undo2, X, Zap, ZapOff } from "lucide-react";
import { Button, cn } from "@routeflow/ui/web";
import {
  cueForOutcome,
  continuousFrameScanned,
  createContinuousScanState,
  manualScanned,
  resetSteadyRead,
  scanSettled,
  shouldDecode,
  type ContinuousScanState,
  type ScanMode,
  type ScanEngineStep,
  type ScanOutcome,
} from "@routeflow/scanning";
import { UNITS_LOADING_SCAN_MESSAGE } from "@/lib/default-unit-line";
import { playScanCue, unlockScanCue } from "@/lib/scan-cue";
import { readScanMode, writeScanMode } from "@/lib/scan-mode-store";
import {
  dueScans,
  enqueue,
  PENDING_MAX_ATTEMPTS,
  recordFailure,
  removePending,
  retryAllNow,
  type PendingScan,
} from "./pending-scan-queue";
import type { ScanResolution } from "./useScanCodeHandler";
import { useContinuousScanCamera, type ScanFrame } from "./useContinuousScanCamera";
import {
  distinctSkuCount,
  popHistory,
  pushHistory,
  scanTotal,
  type ScanHistoryEntry,
  type SummaryLine,
} from "./scan-summary";

/** How long the just-scanned row keeps its ring, and how long the result pill stays up. */
const HIGHLIGHT_MS = 2000;
const FEEDBACK_MS = 2500;
/** How often the poor-signal queue checks for scans that are due a retry. */
const RETRY_TICK_MS = 1500;

export interface ScanOrderScreenProps<
  T extends SummaryLine & { tempId: string; priceType?: string },
> {
  open: boolean;
  /**
   * True while another dialog (create-product for an unknown barcode) is up: the camera stops and
   * the screen hides, but the session — history, the list, the engine — is kept, so scanning
   * resumes exactly where it was when the dialog closes.
   */
  paused?: boolean;
  onClose: () => void;
  /** The order's lines — the SAME state CreateOrderModal owns; this screen never keeps its own cart. */
  lines: readonly T[];
  /** One row per line. `highlighted` marks the line the last scan touched. */
  /** `onTapPrice` opens the price editor for the line (#2696(c): SPECIAL-priced lines included). */
  renderLine: (line: T, ctx: { highlighted: boolean; onTapPrice?: () => void }) => React.ReactNode;
  /**
   * The price/quantity editor for one line (LANE-S step 6). When given, tapping a row's price opens
   * it as a sheet over this screen; `close` dismisses it. It receives the LIVE line each render, so
   * edits show immediately. Omit it and rows keep their inline price input only.
   */
  renderPriceEditor?: (line: T, close: () => void) => React.ReactNode;
  /** Resolves one accepted code (the modal's `useScanCodeHandler`). */
  resolveCode: (
    code: string,
    opts?: { quiet?: boolean; background?: boolean },
  ) => Promise<ScanResolution>;
  /** Inverts one scan (remove the line it created, or take back one unit). */
  onUndo: (entry: ScanHistoryEntry) => void;
  /** A customer is chosen, so scanned lines are priced for them immediately (owner ruling D1). */
  hasCustomer: boolean;
}

/**
 * The accumulating scan screen (scanner-redesign-spec.md §3/§5, LANE-S step 5): a compact camera
 * strip that STAYS OPEN across scans, the order's lines below it (the very same `LineItemRow`s the
 * create-order list renders), and a pinned total + Done. It owns no order state — lines come in,
 * `resolveCode` / `onUndo` go out — so the classic modal and this screen can never disagree.
 *
 * Rendered in a portal on `document.body`: the create-order Dialog's content is transformed (a
 * `fixed` child would be positioned against the dialog box, not the viewport) and its focus trap
 * would fight the qty/note inputs. The modal therefore closes its Dialog while this is open.
 */
export function ScanOrderScreen<T extends SummaryLine & { tempId: string; priceType?: string }>({
  open,
  paused = false,
  onClose,
  lines,
  renderLine,
  renderPriceEditor,
  resolveCode,
  onUndo,
  hasCustomer,
}: ScanOrderScreenProps<T>) {
  const live = open && !paused;

  const engineRef = React.useRef<ContinuousScanState>(createContinuousScanState());
  // Hold to scan (owner ruling 2026-09-24): OPTIONAL per-device mode, default Continuous. In Hold mode the camera stays live
  // but a decoded frame is ignored unless the round button is held (a ref too, so a frame never races a state update).
  const [scanMode, setScanModeState] = React.useState<ScanMode>(() => readScanMode());
  const [holding, setHolding] = React.useState(false);
  const holdingRef = React.useRef(false);
  const releaseHold = React.useCallback(() => {
    const wasHolding = holdingRef.current;
    holdingRef.current = false;
    setHolding(false);
    // a re-grab must earn a FRESH steady read, not inherit a stale streak from before the release. Only a REAL release
    // resets it: a window blur in Continuous mode must not restart a streak (the default path stays unchanged).
    if (wasHolding) engineRef.current = resetSteadyRead(engineRef.current);
  }, []);
  const startHold = React.useCallback(() => {
    holdingRef.current = true;
    setHolding(true);
  }, []);
  const setScanMode = (mode: ScanMode) => {
    releaseHold();
    setScanModeState(mode);
    writeScanMode(mode);
  };
  const scanModeRef = React.useRef<ScanMode>(scanMode);
  scanModeRef.current = scanMode;
  // The hold ends whenever the operator can no longer be pressing it: window blur or the tab going to the background.
  React.useEffect(() => {
    const onBlur = () => releaseHold();
    const onVisibility = () => {
      if (document.visibilityState === "hidden") releaseHold();
    };
    window.addEventListener("blur", onBlur);
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      window.removeEventListener("blur", onBlur);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [releaseHold]);
  const [resolving, setResolving] = React.useState(false);
  const [history, setHistory] = React.useState<ScanHistoryEntry[]>([]);
  const [highlightId, setHighlightId] = React.useState<string | null>(null);
  const [feedback, setFeedback] = React.useState<{
    kind: "added" | "error" | "queued" | "info";
    text: string;
  } | null>(null);
  // Scans waiting for signal (poor-signal queue). The ref is the source of truth (timers read it);
  // the state mirrors it for rendering.
  const [pending, setPending] = React.useState<PendingScan[]>([]);
  const pendingRef = React.useRef<PendingScan[]>([]);
  const setPendingBoth = React.useCallback((next: PendingScan[]) => {
    pendingRef.current = next;
    setPending(next);
  }, []);
  const pendingSeq = React.useRef(0);
  const retryInFlight = React.useRef(new Set<string>());
  // One retry at a time, across every entry point (tick, online, Retry now).
  const retryRunning = React.useRef(false);
  // True only while retries are allowed to touch the order (screen live, no sheet/dialog over it).
  const retryAllowed = React.useRef(false);
  // Closing with scans still waiting needs a second, deliberate press.
  const [closeArmed, setCloseArmed] = React.useState(false);
  const [editingId, setEditingId] = React.useState<string | null>(null);
  const [manualOpen, setManualOpen] = React.useState(false);
  const [manualValue, setManualValue] = React.useState("");
  const highlightTimer = React.useRef<ReturnType<typeof setTimeout> | null>(null);
  const feedbackTimer = React.useRef<ReturnType<typeof setTimeout> | null>(null);
  // Callbacks go through refs so the camera hook's decode callback never goes stale.
  const resolveCodeRef = React.useRef(resolveCode);
  resolveCodeRef.current = resolveCode;

  // A new session starts clean: fresh gate/buffer clocks, no stale undo stack.
  React.useEffect(() => {
    if (!open) return;
    engineRef.current = createContinuousScanState();
    setResolving(false);
    setHistory([]);
    setHighlightId(null);
    setFeedback(null);
    setManualOpen(false);
    setManualValue("");
    setEditingId(null);
    // A queued scan belongs to the session that made it — it never lands on a later order.
    pendingRef.current = [];
    setPending([]);
    setCloseArmed(false);
    retryInFlight.current.clear();
    unlockScanCue();
  }, [open]);

  React.useEffect(
    () => () => {
      if (highlightTimer.current) clearTimeout(highlightTimer.current);
      if (feedbackTimer.current) clearTimeout(feedbackTimer.current);
    },
    [],
  );

  const showFeedback = React.useCallback(
    (kind: "added" | "error" | "queued" | "info", text: string) => {
      setFeedback({ kind, text });
      if (feedbackTimer.current) clearTimeout(feedbackTimer.current);
      feedbackTimer.current = setTimeout(() => setFeedback(null), FEEDBACK_MS);
    },
    [],
  );

  /**
   * Shows the outcome of one resolved code: the cue, the status pill and - for an accepted scan -
   * the undo entry and the row highlight. Returns "offline" and does NOTHING else when the lookup
   * failed for connectivity, so the caller can queue it instead of reporting a failure.
   */
  const applyResolution = React.useCallback(
    (code: string, res: ScanResolution): "done" | "offline" => {
      if (res.kind === "error" && res.offline) return "offline";
      let outcome: ScanOutcome;
      if (res.kind === "added") {
        const name = String(res.product?.name ?? "Item");
        outcome = { feedback: { kind: "added", text: `Added ${name}` } };
        setHistory((h) =>
          pushHistory(h, { productId: String(res.product.id), created: res.created }),
        );
        setHighlightId(String(res.product.id));
        if (highlightTimer.current) clearTimeout(highlightTimer.current);
        highlightTimer.current = setTimeout(() => setHighlightId(null), HIGHLIGHT_MS);
      } else {
        const text =
          res.kind === "archived"
            ? `${res.name} is archived`
            : res.kind === "refused"
              ? UNITS_LOADING_SCAN_MESSAGE
              : res.kind === "unknown"
                ? `Not in the catalog: ${code}`
                : res.kind === "suggested"
                  ? `No exact match for ${code} - search for ${String(res.product?.name ?? "it")}`
                  : "Couldn't look up that code";
        outcome = { feedback: { kind: "error", text } };
      }
      // The cue comes straight from the shared decision (`cueForOutcome`) and BEFORE any
      // rendering, so the beep/vibration is immediate; it never throws (see scan-cue.ts).
      playScanCue(cueForOutcome(outcome));
      const fb = outcome?.feedback;
      if (fb) showFeedback(fb.kind, fb.text);
      return "done";
    },
    [showFeedback],
  );

  /** A scan that could not be looked up for lack of signal waits in the queue and is retried. */
  const queueOffline = React.useCallback(
    (code: string) => {
      const { queue, accepted } = enqueue(
        pendingRef.current,
        code,
        Date.now(),
        `q${++pendingSeq.current}`,
      );
      if (accepted) {
        // Opus item 4: NOT "rejected" — a queued scan is not a rejection, and an operator
        // scanning by ear hears "rejected" as "that didn't take, scan it again", which is
        // exactly how a queued-then-later-retried scan becomes a double count. No dedicated
        // "queued" tone exists (ScanCue is only accepted/rejected/none), so silence here is the
        // correct choice between the two the ruling allows, not a placeholder for a future one —
        // the visible "Waiting for signal" pill (below) is the queued-state signal instead.
        playScanCue("none");
        setPendingBoth(queue);
        showFeedback("queued", `No signal - ${code} queued, will retry`);
      } else {
        // The queue is genuinely full — this scan really was refused, not queued.
        playScanCue("rejected");
        showFeedback("error", "Too many scans are waiting for signal - reconnect, then rescan");
      }
    },
    [setPendingBoth, showFeedback],
  );

  /**
   * Resolves one accepted code, then drains whatever the engine buffered while it was in flight -
   * recursing (not looping) so each queued code gets its own cue/feedback cycle, exactly like
   * `ScanCamera.web.tsx` on mobile. The engine advances in `finally`, so a throwing resolver can
   * never strand a buffered code. Lookups are QUIET (no toast): this screen reports every outcome
   * itself, and a queued scan is retried without re-toasting each failure.
   */
  const resolveOne = React.useCallback(
    async (code: string) => {
      try {
        // The modal's handler already turns lookup failures into a `kind: "error"` resolution, but
        // this screen must not depend on that: a rejection here would be an unhandled promise (the
        // caller is fire-and-forget) with no cue, so it is folded into the same error path.
        let res: ScanResolution;
        try {
          res = await resolveCodeRef.current(code, { quiet: true });
        } catch (err) {
          res = { kind: "error", message: (err as Error)?.message ?? "lookup failed" };
        }
        if (applyResolution(code, res) === "offline") queueOffline(code);
      } finally {
        const step = scanSettled(engineRef.current);
        applyStep(step);
      }
    },
    // applyStep is declared below and only reads refs/setters, so it is safe to omit.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [applyResolution, queueOffline],
  );

  const applyStep = React.useCallback(
    (step: ScanEngineStep & { next: ContinuousScanState }) => {
      engineRef.current = step.next;
      if (step.indicator) setResolving(step.indicator === "on");
      if (step.startResolving) void resolveOne(step.startResolving);
    },
    [resolveOne],
  );

  // A camera frame decoded `code`. The gate drops per-frame repeats; only a genuine new item (or
  // a deliberate re-present) reaches the resolver.
  // Aim box (only a code centred in the DRAWN box counts) and steady-read (the same value held over several frames) run
  // ahead of the gate, DEFAULT ON (owner ruling 2026-09-24): they cut accidental off-centre / passing-glance reads.
  const handleFrame = React.useCallback(
    (code: string, frame?: ScanFrame) => {
      if (!shouldDecode(scanModeRef.current, holdingRef.current)) return;
      applyStep(
        continuousFrameScanned(engineRef.current, code, Date.now(), {
          bounds: frame?.bounds,
          aimBox: frame?.aimBox,
        }),
      );
    },
    [applyStep],
  );

  // A deliberate manual entry: always intentional, so it skips the gate but still queues mid-resolve.
  const submitManual = () => {
    const code = manualValue.trim();
    if (!code) return;
    setManualValue("");
    applyStep(manualScanned(engineRef.current, code));
  };

  // ── Poor-signal queue: retry what is due ──────────────────────────────────────────────────────
  const retryOne = React.useCallback(
    async (item: PendingScan) => {
      if (retryInFlight.current.has(item.id)) return;
      retryInFlight.current.add(item.id);
      // SA-090: claim BEFORE calling the resolver, not after. The resolver ADDS the line to the
      // order as a side effect of resolving — it does this whether or not anyone is still
      // listening for the outcome — so the item must be irrevocably committed to THIS attempt
      // before that side effect can happen. Checking "is it still queued?" only after the await
      // let a Discard tap (or the session closing) land in the gap and made `retryOne` walk away
      // from a line the resolver had already added: no cue, no history entry, and nothing Undo
      // could reach.
      //
      // NOT what prevents a duplicate row for a same-product retry-vs-live-scan race (Opus review
      // item 1, #1271): this flushSync only commits THIS screen's own `pending` queue state. The
      // add-vs-merge decision lives in CreateOrderModal's `addLineItem`, which now makes that
      // decision — and its own flushSync — INSIDE its `setLineItems` updater, against the true
      // latest order state, so it is correct regardless of what this screen's queue looks like.
      // An earlier version of this comment claimed this flushSync was that guarantee; it was not.
      //
      // Opus review (#1271): `runDueRetries` snapshots its due list ONCE when the loop starts, so an
      // item discarded while an EARLIER item in that same snapshot is still awaiting its resolver is
      // stale by the time the loop reaches it. This check must sit immediately before the claim below
      // with NO await between them (SA-090c) — anything after an await could let another claim or
      // another discard slip into the gap.
      if (!pendingRef.current.some((p) => p.id === item.id)) {
        retryInFlight.current.delete(item.id);
        return;
      }
      flushSync(() => {
        setPendingBoth(removePending(pendingRef.current, item.id));
      });
      try {
        let res: ScanResolution;
        try {
          res = await resolveCodeRef.current(item.code, { quiet: true, background: true });
        } catch {
          // SA-090f (#1271): connectivity is decided ONLY inside resolveCodeRef's own lookup try
          // (useScanCodeHandler's isConnectivityError check) — a genuine network failure there
          // resolves normally as `{ kind: "error", offline: true }` and never reaches this catch at
          // all. Anything that DOES land here is, by construction, not a lookup failure — it threw
          // from somewhere AFTER addLineItem's flushSync commit (a toast, mergedLineMessage). The
          // line is already added; `offline: false` always, so it is reported once and never
          // re-queued into a second resolver call that would add it again.
          res = { kind: "error", message: "lookup failed", offline: false };
        }
        if (res.kind === "error" && res.offline) {
          // The item is no longer in the live queue to look up by id (claimed above) — recompute
          // its own next attempt from the ORIGINAL item this closure already holds, through the
          // same recordFailure the rest of the queue uses (a singleton queue of just this one
          // item), then merge the result back in.
          const { queue, dropped } = recordFailure([item], item.id, Date.now());
          flushSync(() => setPendingBoth([...pendingRef.current, ...queue]));
          if (dropped) {
            playScanCue("rejected");
            showFeedback(
              "error",
              `Gave up on ${dropped.code} after ${PENDING_MAX_ATTEMPTS} tries - rescan it`,
            );
          }
          return;
        }
        // SA-090: never drop an "added" (or any non-offline) outcome — applyResolution runs
        // regardless of queue/session state, because a Discard or a closed session cannot
        // un-happen the resolver's own add. The cue and history entry MUST show, so Undo can
        // still reach the line even if the operator discarded the queue row that requested it.
        flushSync(() => applyResolution(item.code, res));
      } finally {
        retryInFlight.current.delete(item.id);
      }
    },
    [applyResolution, setPendingBoth, showFeedback],
  );

  // The line being edited, looked up LIVE so the editor always shows the current values. If the
  // line disappears underneath it (undo, removal) the editor simply closes.
  const editingLine = editingId ? (lines.find((l) => l.tempId === editingId) ?? null) : null;
  const closeEditor = React.useCallback(() => setEditingId(null), []);
  const editorOpen = !!editingLine && !!renderPriceEditor;

  // The camera is OFF while the editor sheet is open: a decode landing behind the opaque sheet
  // would increment the very line being edited (the focused field jumping under the operator's
  // cursor) with its cue and feedback hidden. Scanning resumes when the sheet closes.
  const camera = useContinuousScanCamera({ enabled: live && !editorOpen, onDetect: handleFrame });

  // A hold never outlives what can still deliver its release: closing / pausing the screen, a camera error (the button
  // unmounts, so its pointerup never arrives) or leaving Hold mode all end it, so the next session starts released.
  React.useEffect(() => {
    if (!live || camera.error || scanMode !== "hold") releaseHold();
  }, [live, camera.error, scanMode, releaseHold]);

  // Retry due scans every tick while the screen is live. Nothing retries under the price sheet (a
  // line landing under the operator's cursor) or under the create-product dialog, and nothing while
  // the browser reports it is offline; the browser's `online` event makes everything due at once.
  const canRetry = live && !editorOpen;
  React.useEffect(() => {
    retryAllowed.current = canRetry;
  }, [canRetry]);

  // The "press again to discard" warning only applies while something is actually waiting.
  React.useEffect(() => {
    if (pending.length === 0) setCloseArmed(false);
  }, [pending.length]);

  /**
   * Retries whatever is due - strictly ONE AT A TIME, never while a live scan is resolving, and it
   * stops the moment retries are no longer allowed. No fixed pause between two retries: `retryOne`
   * claims its item before calling the resolver (flushed synchronously), so the next iteration's
   * own claim can never race it — the resolver's own add-vs-merge decision (CreateOrderModal's
   * `addLineItem`) is a separate guarantee, made fresh against live state at commit time, not
   * something this loop's own timing needs to protect.
   */
  const runDueRetries = React.useCallback(async () => {
    if (retryRunning.current) return;
    if (typeof navigator !== "undefined" && navigator.onLine === false) return;
    retryRunning.current = true;
    try {
      for (const item of dueScans(pendingRef.current, Date.now())) {
        if (!retryAllowed.current || engineRef.current.buffer.isResolving) break;
        await retryOne(item);
      }
    } finally {
      retryRunning.current = false;
    }
  }, [retryOne]);

  React.useEffect(() => {
    if (!canRetry) return;
    const id = setInterval(() => void runDueRetries(), RETRY_TICK_MS);
    return () => clearInterval(id);
  }, [canRetry, runDueRetries]);

  // The browser coming back online makes everything due. That is recorded even while the price sheet
  // or a dialog is up (retrying waits for them to close) so a reconnect is never missed.
  React.useEffect(() => {
    if (!live) return;
    const onOnline = () => {
      setPendingBoth(retryAllNow(pendingRef.current, Date.now()));
      void runDueRetries();
    };
    window.addEventListener("online", onOnline);
    return () => window.removeEventListener("online", onOnline);
  }, [live, runDueRetries, setPendingBoth]);

  /** "Retry now": due immediately, or - honestly - say we are still offline. */
  const retryNow = () => {
    if (typeof navigator !== "undefined" && navigator.onLine === false) {
      showFeedback("queued", "Still offline - will retry as soon as the connection returns");
      return;
    }
    setPendingBoth(retryAllNow(pendingRef.current, Date.now()));
    void runDueRetries();
  };

  /**
   * Close / Done / Escape. With scans still waiting for signal the FIRST press only warns (they
   * would be discarded with the session); a second press closes.
   *
   * SA-090: refuses outright while a retry is actually in flight (claimed, resolver called, not
   * yet returned) — closing there would tear the session down mid-lookup, and the resolver's own
   * add still lands after the screen (and this closure's `pendingRef`) is gone, with nothing left
   * to show a cue or history entry for it. This is not the same gate as the warn-then-discard
   * above: a scan merely WAITING for its next retry tick is safe to discard (nothing is running);
   * one whose lookup already started is not.
   */
  const requestClose = () => {
    if (retryInFlight.current.size > 0) {
      showFeedback("queued", "A queued scan is being looked up - wait a moment before closing.");
      return;
    }
    if (pendingRef.current.length > 0 && !closeArmed) {
      setCloseArmed(true);
      const n = pendingRef.current.length;
      showFeedback(
        "queued",
        `${n} scan${n === 1 ? "" : "s"} still waiting for signal - press Done again to discard`,
      );
      return;
    }
    // Opus/SA-090 follow-up: `open` going false does NOT unmount this component (it renders
    // null and stays mounted — see the "shell" tests), and the session-reset effect above only
    // clears the queue on the NEXT open, never on close. Without this, an abandoned queue item
    // sits in `pendingRef` where a later retry tick could still fire — invisibly, since the
    // screen renders nothing — and the resolver's own add would land with no UI open to show a
    // cue for it. Cleared explicitly here rather than left for whichever open happens next.
    pendingRef.current = [];
    setPending([]);
    onClose();
  };

  const undo = () => {
    const { entry, rest } = popHistory(history);
    if (!entry) return;
    setHistory(rest);
    onUndo(entry);
  };

  // Escape closes the price editor if one is open, else this screen — capture phase +
  // stopPropagation so it can never also dismiss the order builder underneath. (A third layer,
  // MarginHint's cost-history popover, listens on window-capture too and registers AFTER this, so
  // Escape with that popover open closes the sheet as well; nothing is lost, edits apply live.)
  React.useEffect(() => {
    if (!live) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.stopPropagation();
      if (editorOpen) setEditingId(null);
      else requestClose();
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [live, onClose, editorOpen, closeArmed]);

  if (!open || typeof document === "undefined") return null;

  const count = distinctSkuCount(lines);
  const total = scanTotal(lines);
  const manualPrimary = !!camera.error;

  return createPortal(
    <div
      role="dialog"
      aria-label="Scan items"
      aria-hidden={paused || undefined}
      className={cn(
        "fixed inset-0 z-[80] flex flex-col bg-white pt-[env(safe-area-inset-top)]",
        paused && "hidden",
      )}
    >
      <header className="flex h-11 shrink-0 items-center justify-between border-b border-surface-border px-3">
        <button
          type="button"
          onClick={requestClose}
          className="flex items-center gap-1.5 rounded px-2 py-1.5 text-sm font-medium text-navy/70 hover:bg-surface-raised"
        >
          <X className="h-4 w-4" />
          Close
        </button>
        <h2 className="text-sm font-semibold text-navy">Scan items</h2>
        {camera.torchAvailable ? (
          <button
            type="button"
            onClick={camera.toggleTorch}
            aria-pressed={camera.torchOn}
            aria-label={camera.torchOn ? "Turn flashlight off" : "Turn flashlight on"}
            className={cn(
              "flex h-8 w-8 items-center justify-center rounded-full",
              camera.torchOn ? "bg-brand-500 text-white" : "bg-surface-raised text-navy/70",
            )}
          >
            {camera.torchOn ? <Zap className="h-4 w-4" /> : <ZapOff className="h-4 w-4" />}
          </button>
        ) : (
          <span className="w-8" aria-hidden />
        )}
      </header>

      {/* Camera strip: wide and short (a barcode is held that way); object-cover crops the frame
          for display only — zxing still reads all of it. */}
      <div className={cn("relative h-36 shrink-0 bg-black sm:h-44", scanMode === "hold" && "mb-7")}>
        {camera.error ? (
          <div className="flex h-full items-center justify-center px-4 text-center text-sm text-white/80">
            {camera.error}
          </div>
        ) : (
          <>
            <video
              ref={camera.videoRef}
              className="h-full w-full cursor-pointer object-cover"
              autoPlay
              muted
              playsInline
              onClick={camera.refocus}
            />
            <div className="pointer-events-none absolute inset-0 flex items-center justify-center">
              <div className="h-3/5 w-5/6 rounded border-2 border-brand-400 opacity-80" />
            </div>
            {scanMode === "hold" && (
              <button
                type="button"
                aria-label="Hold to scan"
                aria-describedby="scan-hold-hint"
                aria-pressed={holding}
                onPointerDown={(e) => {
                  e.currentTarget.setPointerCapture?.(e.pointerId);
                  startHold();
                }}
                onPointerUp={releaseHold}
                onPointerCancel={releaseHold}
                onPointerLeave={releaseHold}
                onKeyDown={(e) => {
                  if ((e.key === " " || e.key === "Enter") && !e.repeat) {
                    e.preventDefault();
                    startHold();
                  }
                }}
                onKeyUp={(e) => {
                  if (e.key === " " || e.key === "Enter") releaseHold();
                }}
                // focus leaving mid keyboard-hold: the keyup would land elsewhere and the hold would stick
                onBlur={releaseHold}
                onContextMenu={(e) => e.preventDefault()}
                className={cn(
                  // straddles the strip's bottom edge (half inside the free 20% under the aim box, half in the margin below),
                  // so the thumb never covers the barcode
                  "absolute -bottom-7 left-1/2 z-10 h-14 w-14 -translate-x-1/2 touch-none select-none rounded-full border-4 border-white/90 shadow-lg [-webkit-touch-callout:none]",
                  holding ? "scale-95 bg-brand-500" : "bg-brand-500/70",
                )}
              />
            )}
          </>
        )}
      </div>

      <div className="shrink-0 border-b border-surface-border px-3 py-2">
        {/* Scan mode: OPTIONAL per device (owner ruling 2026-09-24), default Continuous. */}
        <div
          className="mb-1 flex flex-wrap items-center gap-2 text-xs text-navy/60"
          role="group"
          aria-label="Scan mode"
        >
          <span>Scan mode</span>
          {(["continuous", "hold"] as const).map((m) => (
            <button
              key={m}
              type="button"
              aria-label={m === "hold" ? "Hold to scan mode" : "Continuous mode"}
              aria-pressed={scanMode === m}
              onClick={() => setScanMode(m)}
              className={cn(
                "min-h-[44px] rounded-full border px-3 font-medium",
                scanMode === m
                  ? "border-brand-500 bg-brand-50 text-brand-600"
                  : "border-surface-border text-navy/60 hover:text-navy",
              )}
            >
              {m === "hold" ? "Hold to scan" : "Continuous"}
            </button>
          ))}
          {scanMode === "hold" && (
            <span id="scan-hold-hint" className="text-xs text-navy/70">
              Hold the button while the barcode is in the box
            </span>
          )}
        </div>
        <div className="flex min-h-[28px] flex-wrap items-center justify-between gap-2 text-sm">
          {feedback ? (
            <p
              role="status"
              className={cn(
                // Wraps, never truncates: the actionable half of a queue message ("press Done again to
                // discard") is the part a one-line ellipsis cuts off at 390px (B595).
                "min-w-0 max-w-full break-words rounded px-2 py-1 text-xs font-medium",
                feedback.kind === "added"
                  ? "bg-emerald-50 text-emerald-800"
                  : feedback.kind === "queued"
                    ? "bg-amber-50 text-amber-800"
                    : feedback.kind === "info"
                      ? "bg-slate-100 text-slate-700"
                      : "bg-red-50 text-red-700",
              )}
            >
              {feedback.text}
            </p>
          ) : (
            <p className="min-w-0 truncate text-xs text-navy/60">
              {manualPrimary
                ? "Camera unavailable — enter codes below"
                : "Align the barcode in the box"}
            </p>
          )}
          <button
            type="button"
            onClick={() => setManualOpen((v) => !v)}
            aria-expanded={manualOpen || manualPrimary}
            className="flex shrink-0 items-center gap-1 text-xs font-medium text-brand-500 hover:text-brand-600"
          >
            <Keyboard className="h-3.5 w-3.5" />
            Enter code manually
          </button>
        </div>
        {(manualOpen || manualPrimary) && (
          <div className="mt-2 flex items-center gap-2">
            <input
              type="text"
              inputMode="numeric"
              autoComplete="off"
              value={manualValue}
              onChange={(e) => setManualValue(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  submitManual();
                }
              }}
              placeholder="Type or paste a barcode / SKU"
              aria-label="Barcode or SKU"
              className="h-10 min-w-0 flex-1 rounded border border-surface-border bg-white px-3 text-sm text-navy focus:outline-none focus:ring-2 focus:ring-brand-500"
            />
            <Button type="button" size="sm" onClick={submitManual} disabled={!manualValue.trim()}>
              Add
            </Button>
          </div>
        )}
      </div>

      {!hasCustomer && (
        <div className="flex shrink-0 items-start gap-2 border-b border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800">
          <AlertTriangle className="mt-px h-3.5 w-3.5 shrink-0" />
          <span>No customer selected — scanned items are priced at list price.</span>
        </div>
      )}

      <div className="flex h-9 shrink-0 items-center justify-between border-b border-surface-border px-3 text-xs">
        <button
          type="button"
          onClick={undo}
          disabled={history.length === 0}
          className="flex items-center gap-1 font-medium text-navy/70 enabled:hover:text-navy disabled:opacity-40"
        >
          <Undo2 className="h-3.5 w-3.5" />
          Undo last scan
        </button>
        <span className="text-navy/70">
          {resolving && <span className="mr-2 text-navy/50">Resolving…</span>}
          {count} {count === 1 ? "item" : "items"}
        </span>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto px-3 py-2">
        {pending.length > 0 && (
          <div
            role="group"
            aria-label="Waiting for signal"
            className="mb-2 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-900"
          >
            <div className="flex items-center justify-between gap-2">
              <p role="status" className="font-medium">
                Waiting for signal ({pending.length})
              </p>
              <button
                type="button"
                onClick={retryNow}
                className="font-medium text-brand-600 hover:text-brand-700"
              >
                Retry now
              </button>
            </div>
            <ul className="mt-1 space-y-0.5">
              {pending.map((p) => (
                <li key={p.id} className="flex items-center justify-between gap-2">
                  <span className="min-w-0 truncate font-mono">{p.code}</span>
                  <button
                    type="button"
                    onClick={() => setPendingBoth(removePending(pendingRef.current, p.id))}
                    aria-label={`Discard ${p.code}`}
                    className="shrink-0 rounded p-0.5 text-amber-800/70 hover:bg-amber-100 hover:text-amber-950"
                  >
                    <X className="h-3.5 w-3.5" />
                  </button>
                </li>
              ))}
            </ul>
          </div>
        )}
        {lines.length > 0 ? (
          <ul className="divide-y divide-surface-border overflow-hidden rounded-lg border border-surface-border">
            {lines.map((line) =>
              renderLine(line, {
                highlighted: !!line.productId && line.productId === highlightId,
                // #2696(c): a SPECIAL-priced line too — an override takes a reason in the editor.
                onTapPrice: () => setEditingId(line.tempId),
              }),
            )}
          </ul>
        ) : (
          <p className="py-8 text-center text-sm text-navy/60">Scan an item to add it.</p>
        )}
      </div>

      <footer className="flex h-14 shrink-0 items-center justify-between border-t border-surface-border bg-white px-3 pb-[env(safe-area-inset-bottom)]">
        <p className="text-sm font-semibold text-navy" aria-live="polite">
          {count} {count === 1 ? "item" : "items"} · ${total.toFixed(2)}
        </p>
        <Button type="button" onClick={requestClose}>
          Done
        </Button>
      </footer>
      {editorOpen && renderPriceEditor(editingLine!, closeEditor)}
    </div>,
    document.body,
  );
}
