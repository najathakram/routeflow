"use client";

import * as React from "react";
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
  const { toast } = useToast();
  const qc = useQueryClient();
  const reorder = useReorderOrderLines();
  const canMove = enabled && !!orderId && !!updatedAt && lineItems.length > 1;

  // The ids as arranged on screen; null = what the server sent.
  const [local, setLocal] = React.useState<string[] | null>(null);
  const stamp = React.useRef(updatedAt);
  const busy = React.useRef(false);
  const lastUndo = React.useRef<string[] | null>(null);
  const serverKey = `${updatedAt ?? ""}|${lineItems.map((l) => l.id).join(",")}`;
  React.useEffect(() => {
    stamp.current = updatedAt;
    setLocal(null);
  }, [serverKey, updatedAt]);

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
    async (ids: string[]) => {
      const res = await reorder.mutateAsync({
        id: orderId!,
        expectedUpdatedAt: stamp.current!,
        lineIds: ids,
      });
      stamp.current = res.updatedAt;
      void qc.invalidateQueries({ queryKey: ["orders", orderId] });
    },
    [orderId, qc, reorder],
  );

  const fail = React.useCallback(
    (err: unknown, previous: string[]) => {
      const stale = (err as { response?: { status?: number } })?.response?.status === 409;
      setLocal(stale ? null : previous);
      if (stale) void qc.invalidateQueries({ queryKey: ["orders", orderId] });
      toast({
        title: stale ? LINE_ORDER_CHANGED : "Couldn't move the line. Try again.",
        variant: stale ? "warning" : "error",
      });
    },
    [orderId, qc, toast],
  );

  const undo = React.useCallback(async () => {
    const back = lastUndo.current;
    if (!back || busy.current) return;
    lastUndo.current = null;
    busy.current = true;
    const current = local ?? lineItems.map((l) => l.id);
    setLocal(back);
    try {
      await send(back);
    } catch (err) {
      fail(err, current);
    } finally {
      busy.current = false;
    }
  }, [fail, lineItems, local, send]);

  const onMove = React.useCallback(
    async ({ ids, movedId, toIndex }: LineMove) => {
      if (!canMove || busy.current) return;
      const previous = lines.map((l) => l.id);
      busy.current = true;
      setLocal(ids);
      try {
        await send(ids);
        lastUndo.current = previous;
        const name = lines.find((l) => l.id === movedId)?.label ?? "Line";
        toast({
          title: `Moved ${name} to line ${toIndex + 1}`,
          variant: "success",
          duration: UNDO_MS,
          action: { label: "Undo", onClick: () => void undo() },
        });
      } catch (err) {
        fail(err, previous);
      } finally {
        busy.current = false;
      }
    },
    [canMove, fail, lines, send, toast, undo],
  );

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

  return { shown, lines, onMove, canMove };
}
