"use client";

import * as React from "react";
import type { PriceTier } from "@routeflow/pricing";
import type { ProductPriceGridDto } from "@routeflow/types";
import { planGridEdit, ladderViewFromGrid, type GridEditPlan } from "./ladder-from-grid";
import type { CellFocus, GridEditApi } from "./edit-types";
import { useSavePriceGrid, type SavePriceGridPayload } from "./contract-stubs";

const key = (ref: string, tier: number) => `${ref}|${tier}`;
const parse = (k: string) => {
  const i = k.lastIndexOf("|");
  return { ref: k.slice(0, i), tier: Number(k.slice(i + 1)) as PriceTier };
};

export interface GridEditState {
  api: GridEditApi;
  plan: GridEditPlan | null;
  switchTo: string | null;
  keeps: string[];
  setSwitchTo: (to: string | null) => void;
  toggleKeep: (ref: string, tier: number) => void;
  cancel: () => void;
  save: () => void;
  canSave: boolean;
  pending: boolean;
  /** How many things the draft changes (cells plus an order-unit switch). */
  count: number;
}

/**
 * The edit-mode draft for the units v2 grid: typed cells, an order-unit switch and its Keeps. Save is
 * the one commit; Ctrl/Cmd+S calls it while editing. LOCAL draft store until the contract names the
 * shared one.
 */
export function useGridEdit(
  productId: string,
  data: ProductPriceGridDto | undefined,
  tierName?: (t: PriceTier) => string,
): GridEditState {
  const [editing, setEditing] = React.useState(false);
  const [drafts, setDrafts] = React.useState<Record<string, string>>({});
  const [switchTo, setSwitchToState] = React.useState<string | null>(null);
  const [keeps, setKeeps] = React.useState<string[]>([]);
  const [focus, setFocus] = React.useState<CellFocus | null>(null);
  const saveMutation = useSavePriceGrid(productId);

  const plan = React.useMemo(() => {
    if (!data || !editing) return null;
    const edits = Object.entries(drafts).map(([k, text]) => ({ ...parse(k), text }));
    return planGridEdit(ladderViewFromGrid(data), edits, switchTo, keeps.map(parse), tierName);
    // tierName only words a refusal; the plan does not depend on its identity
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data, editing, drafts, switchTo, keeps]);

  const reset = React.useCallback(() => {
    setEditing(false);
    setDrafts({});
    setSwitchToState(null);
    setKeeps([]);
    setFocus(null);
  }, []);

  const count = (plan?.patches.length ?? 0) + (plan?.sw ? 1 : 0);
  const pending = saveMutation.isPending;
  const canSave = editing && !pending && count > 0 && (plan?.problems.length ?? 0) === 0;

  const save = React.useCallback(() => {
    if (!canSave || !plan) return;
    const payload: SavePriceGridPayload = {
      productId,
      patches: plan.patches.map((p) => ({ ref: p.ref, tier: p.tier, to: p.to })),
      orderUnit: plan.sw ? plan.sw.to : null,
      keeps: (plan.sw?.pins ?? []).filter((p) => keeps.includes(key(p.ref, p.tier))),
    };
    saveMutation.mutate(payload, { onSuccess: reset });
  }, [canSave, plan, productId, keeps, saveMutation, reset]);

  // V04: Ctrl/Cmd+S saves while editing and stops the browser's own save dialog.
  const saveRef = React.useRef(save);
  saveRef.current = save;
  React.useEffect(() => {
    if (!editing) return;
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "s") {
        e.preventDefault();
        saveRef.current();
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [editing]);

  const api: GridEditApi = {
    editing,
    begin: (cell) => {
      setEditing(true);
      if (cell) setFocus(cell);
    },
    text: (ref, tier, original) => drafts[key(ref, tier)] ?? original,
    setText: (ref, tier, text, original) =>
      setDrafts((d) => {
        const next = { ...d };
        if (text === original) delete next[key(ref, tier)];
        else next[key(ref, tier)] = text;
        return next;
      }),
    changed: (ref, tier) => key(ref, tier) in drafts,
    focus,
    focused: () => setFocus(null),
  };

  return {
    api,
    plan,
    switchTo,
    keeps,
    setSwitchTo: (to) => {
      setSwitchToState(to);
      setKeeps([]);
    },
    toggleKeep: (ref, tier) =>
      setKeeps((ks) => {
        const k = key(ref, tier);
        return ks.includes(k) ? ks.filter((x) => x !== k) : [...ks, k];
      }),
    cancel: reset,
    save,
    canSave,
    pending,
    count,
  };
}
