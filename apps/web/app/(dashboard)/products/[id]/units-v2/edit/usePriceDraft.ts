"use client";

import * as React from "react";
import {
  planOrderUnitSwitch,
  type CellChange,
  type LadderView,
  type Pin,
  type PricePlan,
  type PriceTier,
  type SwitchPlan,
} from "@routeflow/pricing";
import type {
  CustomerPriceMove,
  ProductPriceGridDto,
  SavePricesRequest,
  SavePricesResponse,
} from "@routeflow/types";
import { useTierLabels } from "@/lib/api/tier-labels";
import { useQueryClient } from "@tanstack/react-query";
import { fetchPriceGrid, priceGridKey, usePriceGrid } from "@/lib/api/usePriceGrid";
import { formatMoney } from "@/lib/format";
import {
  priceWriteError,
  useSavePrices,
  useUndoPrices,
  type PriceWriteError,
} from "@/lib/api/usePriceWrites";
import { tierLabel } from "@/lib/tier-label";
import type { CellFocus, GridEditApi } from "./edit-types";
import {
  cellKey,
  changesFrom,
  foldDraft,
  parseKey,
  type CellProblem,
  type DraftEntry,
} from "./fold-draft";
import { previewRows, rulesFromGrid, viewFromGrid } from "./view-from-grid";

export interface OpenPlan {
  plan: PricePlan;
  origin: { ref: string; tier: PriceTier };
}

/** The shared draft store (SPRINT-CONTRACT §3). K3 may add to it, never rename. */
export interface PriceDraft {
  grid: ProductPriceGridDto | undefined;
  /** The draft ladder (edits, ticked offers and Keeps applied). */
  view: LadderView | null;
  editing: boolean;
  startEditing: (focus?: CellFocus) => void;
  discard: () => void;
  dirty: boolean;
  /** Type into one cell; returns the pricing package's plan for it (followers, offers, problems). */
  editCell: (ref: string, tier: PriceTier, typed: string) => PricePlan;
  /** The plan of the last edited cell, for the "also update" panel. */
  plan: OpenPlan | null;
  ticks: readonly boolean[];
  setOfferTicked: (i: number, on: boolean) => void;
  keep: (pin: Pin) => void;
  unkeep: (pin: Pin) => void;
  keepCustomer: (move: CustomerPriceMove) => void;
  /** Change prices Apply folds its plan into the draft; Save is the only commit. */
  applyPlan: (plan: PricePlan) => void;
  resetAllToAuto: () => void;
  toRequest: () => SavePricesRequest;
  save: () => void;
  saving: boolean;
  saveError: PriceWriteError | null;
  canSave: boolean;
  lastSave: { auditId: string; revision: number; undo: SavePricesResponse["undo"] } | null;
  undo: () => void;
  /** Set on a stale undo: what the inverse would change on the fresh grid. */
  undoPreview: CellChange[] | null;
  /** Refetches the grid and returns the inverse's changes as display strings (K5's undo confirm). */
  loadUndoPreview: () => Promise<{
    revision: number;
    priceState: string;
    rows: { key: string; label: string; from: string; to: string }[];
  }>;
  // K3 extras for the edit grid, order unit and save bar
  problems: CellProblem[];
  count: number;
  orderUnit: string | null;
  setOrderUnit: (to: string | null) => void;
  sw: SwitchPlan | null;
  keeps: readonly Pin[];
  tierName: (t: PriceTier) => string;
  api: GridEditApi;
}

export const PriceDraftContext = React.createContext<PriceDraft | null>(null);

export function usePriceDraft(): PriceDraft {
  const d = React.useContext(PriceDraftContext);
  if (!d) throw new Error("usePriceDraft needs a PriceDraftProvider");
  return d;
}

export interface PriceDraftHooks {
  /** K5's status line: called after a successful save. */
  onSaved?: (saved: NonNullable<PriceDraft["lastSave"]>) => void;
  /** Called when an edit starts or a cell is typed, so a status line can clear. */
  onEdit?: () => void;
}

/** Builds the draft for one product. Mounted once, by PriceDraftProvider. */
export function useCreatePriceDraft(productId: string, hooks: PriceDraftHooks = {}): PriceDraft {
  const hooksRef = React.useRef(hooks);
  hooksRef.current = hooks;
  const grid = usePriceGrid(productId).data;
  const labels = useTierLabels().data;
  const tierName = React.useCallback(
    (t: PriceTier) => (t === 1 ? "Retail" : tierLabel(labels, t)),
    [labels],
  );
  const qc = useQueryClient();
  const save = useSavePrices(productId);
  const undoMut = useUndoPrices(productId);

  const [editing, setEditing] = React.useState(false);
  const [entries, setEntries] = React.useState<DraftEntry[]>([]);
  const [openKey, setOpenKey] = React.useState<string | null>(null);
  const [ticks, setTicks] = React.useState<boolean[]>([]);
  const [keeps, setKeeps] = React.useState<Pin[]>([]);
  const [moves, setMoves] = React.useState<CustomerPriceMove[]>([]);
  const [orderUnit, setOrderUnitState] = React.useState<string | null>(null);
  const [focus, setFocus] = React.useState<CellFocus | null>(null);
  const [lastSave, setLastSave] = React.useState<PriceDraft["lastSave"]>(null);
  const [undoStale, setUndoStale] = React.useState(false);

  const served = React.useMemo(() => (grid ? viewFromGrid(grid) : null), [grid]);
  const rules = React.useMemo(() => (grid ? rulesFromGrid(grid) : {}), [grid]);

  const fold = React.useMemo(
    () => (served ? foldDraft(served, rules, entries, openKey, ticks, keeps, tierName) : null),
    [served, rules, entries, openKey, ticks, keeps, tierName],
  );
  const sw = React.useMemo(() => {
    if (!fold || !orderUnit || orderUnit === fold.base.anchor) return null;
    if (!fold.base.rows.some((r) => r.ref === orderUnit)) return null;
    return planOrderUnitSwitch(fold.base, { kind: "product" }, orderUnit, { keep: keeps });
  }, [fold, orderUnit, keeps]);
  const view = sw?.view ?? fold?.view ?? null;

  const patches = fold?.patches ?? [];
  const customerMoves = [...(fold?.customerMoves ?? []), ...moves];
  const problems = fold?.problems ?? [];
  const patched = new Set(patches.map((p) => cellKey(p.ref, p.tier)));
  const sendKeeps = keeps.filter((k) => !patched.has(cellKey(k.ref, k.tier)));
  const count = patches.length + sendKeeps.length + customerMoves.length + (sw ? 1 : 0);
  const dirty = count > 0 || problems.length > 0;

  const reset = React.useCallback(() => {
    setEditing(false);
    setEntries([]);
    setOpenKey(null);
    setTicks([]);
    setKeeps([]);
    setMoves([]);
    setOrderUnitState(null);
    setFocus(null);
  }, []);

  const editCell = (ref: string, tier: PriceTier, typed: string): PricePlan => {
    const key = cellKey(ref, tier);
    const next: DraftEntry[] = [
      ...entries.filter((e) => !(e.kind === "cell" && e.key === key)),
      { kind: "cell", key, text: typed },
    ];
    hooksRef.current.onEdit?.();
    setEntries(next);
    setOpenKey(key);
    setTicks([]);
    const r = foldDraft(served!, rules, next, key, [], keeps, tierName);
    return r.plans.get(key)!;
  };

  const toRequest = (): SavePricesRequest => ({
    productId,
    expectedRevision: grid?.revision ?? 0,
    expectedPriceState: grid?.priceState ?? "",
    patches: patches.map((p) => ({ ref: p.ref, tier: p.tier, to: p.to })),
    keeps: sendKeeps.map((k) => ({ ref: k.ref, tier: k.tier, value: k.value })),
    customerMoves,
    orderUnit: sw ? sw.to : null,
  });

  const canSave =
    editing &&
    !save.isPending &&
    count > 0 &&
    problems.length === 0 &&
    grid?.revision != null &&
    grid.priceState != null;

  const doSave = () => {
    if (!canSave) return;
    save.mutate(toRequest(), {
      onSuccess: (res) => {
        const saved = { auditId: res.auditId, revision: res.revision, undo: res.undo };
        setLastSave(saved);
        hooksRef.current.onSaved?.(saved);
        setUndoStale(false);
        reset();
      },
    });
  };

  // V04: Ctrl/Cmd+S saves while editing and stops the browser's own save dialog.
  const saveRef = React.useRef(doSave);
  saveRef.current = doSave;
  React.useEffect(() => {
    if (!editing) return;
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "s") {
        e.preventDefault();
        if (!e.repeat) saveRef.current();
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [editing]);

  const undo = () => {
    if (!lastSave || grid?.revision == null || grid.priceState == null) return;
    undoMut.mutate(
      {
        auditId: lastSave.auditId,
        expectedRevision: grid.revision,
        expectedPriceState: grid.priceState,
      },
      {
        onSuccess: () => {
          setLastSave(null);
          setUndoStale(false);
        },
        onError: (e) => setUndoStale(priceWriteError(e)?.code === "stale"),
      },
    );
  };

  const undoPreview = React.useMemo(
    () =>
      undoStale && lastSave && served
        ? changesFrom(served, rules, lastSave.undo?.patches ?? [])
        : null,
    [undoStale, lastSave, served, rules],
  );

  // K5's status line: refetch the grid, then say in display strings what the inverse would change.
  const loadUndoPreview: PriceDraft["loadUndoPreview"] = async () => {
    const fresh = await qc.fetchQuery({
      queryKey: priceGridKey(productId),
      queryFn: () => fetchPriceGrid(productId),
      staleTime: 0,
    });
    const changes = lastSave
      ? changesFrom(viewFromGrid(fresh), rulesFromGrid(fresh), lastSave.undo?.patches ?? [])
      : [];
    return {
      revision: fresh.revision ?? 0,
      priceState: fresh.priceState ?? "",
      rows: changes.map((c) => ({
        key: `${c.ref}|${c.tier}`,
        label: `${c.label} ${tierName(c.tier)}`,
        from: formatMoney(c.from),
        to: formatMoney(c.to),
      })),
    };
  };

  const texts: Record<string, string> = {};
  for (const e of entries) if (e.kind === "cell") texts[e.key] = e.text;

  const api: GridEditApi = {
    editing,
    begin: (cell) => {
      setEditing(true);
      setLastSave(null);
      hooksRef.current.onEdit?.();
      if (cell) setFocus(cell);
    },
    text: (ref, tier, original) => texts[cellKey(ref, tier)] ?? original,
    setText: (ref, tier, text, original) => {
      if (text === original) {
        const key = cellKey(ref, tier);
        setEntries((es) => es.filter((e) => !(e.kind === "cell" && e.key === key)));
      } else editCell(ref, tier as PriceTier, text);
    },
    changed: (ref, tier) => cellKey(ref, tier) in texts,
    problem: (ref, tier) => problems.find((p) => p.ref === ref && p.tier === tier)?.message ?? null,
    rows: dirty && grid && view ? previewRows(view, rules, grid) : null,
    focus,
    focused: () => setFocus(null),
  };

  return {
    grid,
    view,
    editing,
    startEditing: api.begin,
    discard: reset,
    dirty,
    editCell,
    plan: fold?.open && openKey ? { plan: fold.open, origin: parseKey(openKey) } : null,
    ticks,
    setOfferTicked: (i, on) =>
      setTicks((t) => {
        const n = [...t];
        n[i] = on;
        return n;
      }),
    keep: (pin) =>
      setKeeps((ks) =>
        ks.some((k) => k.ref === pin.ref && k.tier === pin.tier) ? ks : [...ks, pin],
      ),
    unkeep: (pin) =>
      setKeeps((ks) => ks.filter((k) => !(k.ref === pin.ref && k.tier === pin.tier))),
    keepCustomer: (move) => setMoves((ms) => [...ms, move]),
    applyPlan: (plan) => setEntries((es) => [...es, { kind: "plan", plan }]),
    resetAllToAuto: () => {
      if (!served) return;
      const next: DraftEntry[] = [];
      for (const r of served.rows)
        for (const t of [1, 2, 3, 4, 5] as const)
          if (r.set[t - 1] != null && !(r.ref === served.anchor && t === 1))
            next.push({ kind: "cell", key: cellKey(r.ref, t), text: "" });
      setEntries(next);
      setOpenKey(null);
    },
    toRequest,
    save: doSave,
    saving: save.isPending,
    saveError: priceWriteError(save.error),
    canSave,
    lastSave,
    undo,
    undoPreview,
    loadUndoPreview,
    problems,
    count,
    orderUnit,
    setOrderUnit: (to) => {
      setOrderUnitState(to);
      setKeeps([]);
    },
    sw,
    keeps,
    tierName,
    api,
  };
}
