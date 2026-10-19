import * as React from "react";
import type { ProductUnitLevel } from "@routeflow/types";
import { useQueryClient } from "@tanstack/react-query";
import { useUpdateProductUnit } from "@/lib/api/product-units";

/** F18: the last default change's message, and the single write that undoes it (null once it has been undone). */
export type DefaultNote = {
  text: string;
  /** The unit that should be the default while this message is true (null: the pack, i.e. none). */
  expectedDefaultId: string | null;
  undo: {
    body: { id: string; isDefaultSelling: boolean };
    restoredName: string;
    restoredId: string | null;
  } | null;
};

/**
 * The default order unit's write logic, shared by the legacy Units card and the v2 shell's Units beside the grid.
 * `change(target)` makes `target` the default (null = the pack row: the previous default is unset); `undo` takes the
 * last change back. A write sets the previous default off and the new one on, in one PATCH of the changed unit.
 * `onSettled(needInside)` lets the host move focus after a committed change (true) or an undo / dismiss (false).
 */
export function useDefaultOrderUnit(
  productId: string,
  units: ProductUnitLevel[],
  packName: string,
  opts: { busy?: boolean; onSettled?: (needInside: boolean) => void } = {},
) {
  const update = useUpdateProductUnit(productId);
  const queryClient = useQueryClient();
  const [note, setNote] = React.useState<DefaultNote | null>(null);
  const ownWrite = React.useRef(false);
  const busy = !!opts.busy || update.isPending;
  const onSettledRef = React.useRef(opts.onSettled);
  onSettledRef.current = opts.onSettled;

  // The default that changed under us (another tab, a write that is not a mutation here) makes the message untrue: drop it.
  // Keyed on the default's id alone, so our own write (whose refetch lands on the id the message names) keeps it.
  const currentDefaultId = units.find((u) => u.isDefaultSelling)?.id ?? null;
  const noteRef = React.useRef(note);
  noteRef.current = note;
  React.useEffect(() => {
    const n = noteRef.current;
    if (n && currentDefaultId !== n.expectedDefaultId) setNote(null);
  }, [currentDefaultId]);

  // Any write that is not this hook's own default change makes the Undo stale: every unit write passes through the
  // mutation cache, so one listener covers them all.
  React.useEffect(
    () =>
      queryClient.getMutationCache().subscribe((event) => {
        if (event.type === "added" && !ownWrite.current) setNote(null);
      }),
    [queryClient],
  );

  /** Run one of the default writes without it counting as "another write". */
  const writeDefault = (body: { id: string; isDefaultSelling: boolean }, onSuccess: () => void) => {
    ownWrite.current = true;
    try {
      update.mutate(body, { onSuccess });
    } finally {
      ownWrite.current = false;
    }
  };

  /** F18: make `target` the default order unit (null = the pack row), and say so with an inline Undo. */
  const change = (target: ProductUnitLevel | null) => {
    if (busy) return;
    const prev = units.find((u) => u.isDefaultSelling) ?? null;
    if (target ? target.isDefaultSelling : prev == null) return;
    const body = target
      ? { id: target.id, isDefaultSelling: true }
      : { id: (prev as ProductUnitLevel).id, isDefaultSelling: false };
    const undoBody = prev
      ? { id: prev.id, isDefaultSelling: true }
      : { id: (target as ProductUnitLevel).id, isDefaultSelling: false };
    const restoredName = prev ? prev.label : packName;
    writeDefault(body, () => {
      setNote({
        text: `${target ? target.label : packName} is now the default order unit.`,
        expectedDefaultId: target ? target.id : null,
        undo: { body: undoBody, restoredName, restoredId: prev ? prev.id : null },
      });
      onSettledRef.current?.(true);
    });
  };

  const undo = () => {
    const u = note?.undo;
    if (!u) return;
    writeDefault(u.body, () => {
      setNote({
        text: `${u.restoredName} is the default order unit again.`,
        expectedDefaultId: u.restoredId,
        undo: null,
      });
      onSettledRef.current?.(false);
    });
  };

  const dismiss = () => {
    setNote(null);
    onSettledRef.current?.(false);
  };

  return { note, change, undo, dismiss, clearNote: () => setNote(null), pending: update.isPending };
}
