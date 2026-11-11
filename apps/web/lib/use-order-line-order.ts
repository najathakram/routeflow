"use client";

import * as React from "react";
import { API_ERROR_CODES } from "@routeflow/types";
import { useQueryClient } from "@tanstack/react-query";
import { useToast } from "@routeflow/ui/web";
import { useReorderOrderLines, type OrderItem } from "@/lib/api/orders";
import { orderLineName } from "@/lib/product-display";
import type { LineMove, SortableLine } from "@/components/SortableLines";

/**
 * W-1187 (SA ruling 8): the saved order's line move. A drop is optimistic (the list moves at once), commits through
 * `PUT /orders/:id/line-order`, and shows "Moved X to line N" with Undo for 6 s; Undo is a second reorder carrying the
 * previous list. A 409 (the order changed on another screen) snaps the list to the server's order. Ctrl/Cmd+Z undoes the
 * last move when focus is not in a text field. One call at a time: a move made while one is in flight is ignored.
 */
const UNDO_MS = 6000;
const BUSY_RETRY_MS = 400;
export const LINE_ORDER_BUSY = "The order is busy. Try again.";
/** The server's retryable "another update is in progress" 409 (Order or Invoice row held): not a stale order. */
const isBusy = (err: unknown) => {
  const r = (
    err as { response?: { status?: number; data?: { code?: string; retryable?: boolean } } }
  )?.response;
  return r?.status === 409 && r.data?.code === API_ERROR_CODES.CONCURRENT_UPDATE;
};
export const LINE_ORDER_CHANGED = "This order changed on another screen. Showing the latest.";

const inTextField = (el: EventTarget | null) =>
  el instanceof HTMLElement &&
  (el.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName));

export function useOrderLineOrder({
  orderId,
  updatedAt,
  lineItems,
  enabled,
}: {
  orderId?: string;
  updatedAt?: string;
  lineItems: OrderItem[];
  enabled: boolean;
}) {
  const { toast, dismiss } = useToast();
  const toastId = React.useRef<string | null>(null);
  const closeToast = React.useCallback(() => {
    if (toastId.current) dismiss(toastId.current);
    toastId.current = null;
  }, [dismiss]);
  const undoTimer = React.useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastUndo = React.useRef<{ ids: string[]; stamp: string } | null>(null);
  // The one line-order toast: a new one replaces the old, and a replaced Undo is void (Ctrl/Cmd+Z follows the screen).
  const say = React.useCallback(
    (opts: Parameters<typeof toast>[0]) => {
      if (undoTimer.current) clearTimeout(undoTimer.current);
      lastUndo.current = null;
      closeToast();
      toastId.current = toast(opts);
    },
    [closeToast, toast],
  );
  const [saving, setSaving] = React.useState(false);
  const qc = useQueryClient();
  const reorder = useReorderOrderLines();
  const canMove = enabled && !!orderId && !!updatedAt && lineItems.length > 1;

  // The ids as arranged on screen; null = what the server sent.
  const [local, setLocal] = React.useState<string[] | null>(null);
  const stamp = React.useRef(updatedAt);
  const busy = React.useRef(false);
  // What Undo puts back: the ids before the move, the stamp the move returned (Undo is void once another screen moves
  // it), and the timer that voids it with the toast (the Ctrl/Cmd+Z path must not outlive the visible Undo).
  // The ids on screen right now, read synchronously: a toast's Undo is a closure from the render before the drop.
  const onScreen = React.useRef<string[]>(lineItems.map((l) => l.id));
  const undoNow = React.useRef<() => void>(() => undefined);
  const serverKey = `${updatedAt ?? ""}|${lineItems.map((l) => l.id).join(",")}`;
  React.useEffect(() => {
    stamp.current = updatedAt;
    onScreen.current = lineItems.map((l) => l.id);
    setLocal(null);
    // another screen moved the order: our Undo would overwrite its work
    if (lastUndo.current && lastUndo.current.stamp !== updatedAt) lastUndo.current = null;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [serverKey, updatedAt]);
  React.useEffect(
    () => () => {
      if (undoTimer.current) clearTimeout(undoTimer.current);
    },
    [],
  );
  const show = React.useCallback((ids: string[] | null, server: string[]) => {
    onScreen.current = ids ?? server;
    setLocal(ids);
  }, []);

  const shown = React.useMemo(() => {
    if (!local) return lineItems;
    const at = new Map(local.map((id, i) => [id, i]));
    return [...lineItems].sort((a, b) => (at.get(a.id) ?? 1e9) - (at.get(b.id) ?? 1e9));
  }, [lineItems, local]);
  const lines: SortableLine[] = React.useMemo(
    () => shown.map((l) => ({ id: l.id, label: orderLineName(l) ?? "Custom item" })),
    [shown],
  );

  const send = React.useCallback(
    async (ids: string[] | "name") => {
      const put = () =>
        reorder.mutateAsync({
          id: orderId!,
          expectedUpdatedAt: stamp.current!,
          ...(ids === "name" ? { sort: "name" as const } : { lineIds: ids }),
        });
      let res;
      try {
        res = await put();
      } catch (err) {
        if (!isBusy(err)) throw err;
        await new Promise((r) => setTimeout(r, BUSY_RETRY_MS)); // a payment or edit holds a row: once more, then say so
        res = await put();
      }
      stamp.current = res.updatedAt;
      void qc.invalidateQueries({ queryKey: ["orders", orderId] });
      return res.lineIds;
    },
    [orderId, qc, reorder],
  );

  const fail = React.useCallback(
    (err: unknown, previous: string[], attempted?: string[], what = "move the line") => {
      const busyNow = isBusy(err);
      const stale =
        !busyNow && (err as { response?: { status?: number } })?.response?.status === 409;
      show(
        stale ? null : busyNow ? (attempted ?? previous) : previous,
        lineItems.map((l) => l.id),
      );
      if (stale) void qc.invalidateQueries({ queryKey: ["orders", orderId] });
      say({
        title: busyNow
          ? LINE_ORDER_BUSY
          : stale
            ? LINE_ORDER_CHANGED
            : `Couldn't ${what}. Try again.`,
        variant: stale || busyNow ? "warning" : "error",
      });
    },
    [lineItems, orderId, qc, say, show],
  );

  const undo = React.useCallback(async () => {
    const back = lastUndo.current;
    if (!back || busy.current) return;
    if (undoTimer.current) clearTimeout(undoTimer.current);
    lastUndo.current = null;
    closeToast(); // Ctrl/Cmd+Z used it: the toast's Undo is spent
    busy.current = true;
    setSaving(true);
    const current = onScreen.current; // the moved order, whatever render this closure came from
    show(
      back.ids,
      lineItems.map((l) => l.id),
    );
    try {
      await send(back.ids);
    } catch (err) {
      fail(err, current, back.ids);
    } finally {
      busy.current = false;
      setSaving(false);
    }
  }, [closeToast, fail, lineItems, send, show]);
  undoNow.current = () => void undo();

  /** The "Moved X ... Undo" toast: Undo puts the previous list back, for 6 s (the toast and Ctrl/Cmd+Z share the window). */
  const offerUndo = React.useCallback(
    (previous: string[], title: string) => {
      say({
        title,
        variant: "success",
        duration: UNDO_MS,
        action: { label: "Undo", onClick: () => undoNow.current() },
      });
      lastUndo.current = { ids: previous, stamp: stamp.current! };
      // The toast pauses its own timer while hovered, so close it with the Undo it offers: a visible Undo always works.
      undoTimer.current = setTimeout(() => {
        lastUndo.current = null;
        closeToast();
      }, UNDO_MS);
    },
    [closeToast, say],
  );

  const onMove = React.useCallback(
    async ({ ids, movedId, toIndex }: LineMove) => {
      if (!canMove || busy.current) return;
      const previous = lines.map((l) => l.id);
      busy.current = true;
      setSaving(true);
      show(
        ids,
        lineItems.map((l) => l.id),
      );
      try {
        await send(ids);
        const name = lines.find((l) => l.id === movedId)?.label ?? "Line";
        offerUndo(previous, `Moved ${name} to line ${toIndex + 1}`);
      } catch (err) {
        fail(err, previous, ids);
      } finally {
        busy.current = false;
        setSaving(false);
      }
    },
    [canMove, fail, lineItems, lines, offerUndo, send, show],
  );

  /** Sort A to Z: the SERVER computes the order (one comparator, @routeflow/pricing), so the list moves when it answers. */
  const sortByName = React.useCallback(async () => {
    if (!canMove || busy.current) return;
    const previous = lines.map((l) => l.id);
    busy.current = true;
    setSaving(true);
    try {
      const sorted = await send("name");
      if (sorted.some((id, i) => id !== previous[i])) {
        show(
          sorted,
          lineItems.map((l) => l.id),
        );
        offerUndo(previous, "Sorted A–Z");
      } else {
        say({ title: "Already in A–Z order", variant: "info" });
      }
    } catch (err) {
      fail(err, previous, undefined, "sort the lines");
    } finally {
      busy.current = false;
      setSaving(false);
    }
  }, [canMove, fail, lineItems, lines, offerUndo, say, send, show]);

  React.useEffect(() => {
    if (!canMove) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key.toLowerCase() !== "z" || !(e.ctrlKey || e.metaKey) || e.shiftKey) return;
      if (inTextField(e.target) || !lastUndo.current) return;
      e.preventDefault();
      void undo();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [canMove, undo]);

  return { shown, lines, onMove, sortByName, canMove, saving };
}
