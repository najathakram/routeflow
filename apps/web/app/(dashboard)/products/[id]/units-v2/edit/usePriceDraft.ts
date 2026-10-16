"use client";

import * as React from "react";
import {
  type CellChange,
  type CellPatch,
  type CustomerPricingWithId,
  type LadderView,
  type Pin,
  type PricePlan,
  type PriceTier,
} from "@routeflow/pricing";
import type {
  CustomerPriceConflict,
  CustomerPriceMove,
  ProductPriceGridDto,
  SavePricesRequest,
  SavePricesResponse,
} from "@routeflow/types";
import { useTierLabels } from "@/lib/api/tier-labels";
import {
  productCustomerPricesKey,
  useProductCustomerPrices,
} from "@/lib/api/useProductCustomerPrices";
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
import type { UndoPreviewRow } from "../confirm/types";
import type { CellFocus, GridEditApi } from "./edit-types";
import {
  cellKey,
  changesFrom,
  foldDraft,
  offerId,
  parseKey,
  type CellProblem,
  type DraftEntry,
} from "./fold-draft";
import { ADD_UNIT_FIRST, previewRows, rulesFromGrid, viewFromGrid } from "./view-from-grid";

/** The open plan and what the "also update" panel (K4) reads of the draft's choices on it. */
export interface OpenPlan {
  plan: PricePlan;
  /** The edited cell; null for a plan folded in by Change prices (no cell was typed). */
  cell: { ref: string; tier: PriceTier } | null;
  /** Offer i of `plan.offers` is ticked. Every offer starts unticked (SA-799 a). */
  ticked: readonly boolean[];
  /** The follower Keeps in the draft (Auto prices pinned where they are). */
  keeps: readonly Pin[];
  /** The customer Keeps in the draft. */
  customerKeeps: readonly CustomerPriceMove[];
}

const clearedNotice = (offers: readonly DraftEntry[], why = "you changed that price again") =>
  `Your earlier choice to ${offers
    .flatMap((e) => (e.kind === "offer" ? [`"${e.title}"`] : []))
    .join(", ")} was cleared because ${why}.`;
const asCellPatches = (ps: readonly { ref: string; tier: number; to: number | null }[]) =>
  ps.map((p): CellPatch => ({ ref: p.ref, tier: p.tier as PriceTier, to: p.to }));

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
  /** Set when an edit had to clear a ticked offer (never silent); cleared with the draft. */
  notice: string | null;
  /** Tick bakes the offer into the draft (patches / customer moves); untick removes exactly that. */
  setOfferTicked: (i: number, on: boolean) => void;
  keep: (pin: Pin) => void;
  unkeep: (pin: Pin) => void;
  /** Keep a customer price where it is (`on`, default) or let it follow again (`on` false). */
  keepCustomer: (move: CustomerPriceMove, on?: boolean) => void;
  /**
   * Change prices Apply folds its plan into the draft (and opens edit mode); Save is the only commit. The plan
   * becomes the open plan, so a customer offer left at index 0 can still be ticked with `setOfferTicked(0, true)`.
   */
  applyPlan: (plan: PricePlan) => void;
  resetAllToAuto: () => void;
  /** The save body, or null while the grid has not loaded or the draft has a conflict (Save is then unavailable). */
  toRequest: () => SavePricesRequest | null;
  save: () => void;
  saving: boolean;
  saveError: PriceWriteError | null;
  canSave: boolean;
  lastSave: { auditId: string; revision: number; undo: SavePricesResponse["undo"] } | null;
  undo: () => void;
  /** A strict-undo conflict as a preview row: customer, tier-first unit label, money as shown. Display only. */
  conflictRow: (c: CustomerPriceConflict) => UndoPreviewRow;
  /** Refetch the grid (the stale-write notice's "Reload prices"); the draft is kept. */
  reload: () => void;
  /** The last save was undone elsewhere (K5's status line): forget it. */
  markUndone: () => void;
  /** Set on a stale undo: what the inverse would change on the fresh grid. */
  undoPreview: CellChange[] | null;
  /** Refetches the grid and returns the inverse's changes as display strings (K5's undo confirm). */
  loadUndoPreview: () => Promise<{
    revision: number;
    priceState: string;
    rows: UndoPreviewRow[];
    /** How many customer prices the inverse also writes (SA-799: never hidden). */
    customerMoves: number;
  }>;
  // K3 extras for the edit grid, order unit and save bar
  problems: CellProblem[];
  /** Draft-wide refusals with no cell (duplicate customer moves); Save is unavailable while any. */
  conflicts: string[];
  /** Titles of the ticked offers (customer moves among them) already baked into the draft. */
  bakedTitles: string[];
  count: number;
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
  const gridQuery = usePriceGrid(productId);
  const grid = gridQuery.data;
  const labels = useTierLabels().data;
  const tierName = React.useCallback(
    (t: PriceTier) => (t === 1 ? "Retail" : tierLabel(labels, t)),
    [labels],
  );
  const qc = useQueryClient();
  const save = useSavePrices(productId);
  const undoMut = useUndoPrices(productId);

  const planSeq = React.useRef(0);
  const [editing, setEditing] = React.useState(false);
  const [entries, setEntries] = React.useState<DraftEntry[]>([]);
  const [openKey, setOpenKey] = React.useState<string | null>(null);
  const [keeps, setKeeps] = React.useState<Pin[]>([]);
  const [moves, setMoves] = React.useState<CustomerPriceMove[]>([]);
  const [focus, setFocus] = React.useState<CellFocus | null>(null);
  const [lastSave, setLastSave] = React.useState<PriceDraft["lastSave"]>(null);
  const [undoStale, setUndoStale] = React.useState(false);
  const [notice, setNotice] = React.useState<string | null>(null);

  // SA-799: a plain cell edit shows customer changes too. Same query (and cache entry) as Change prices' names; only
  // fetched while editing, so the product page costs nothing extra when nobody edits.
  // Also after a save: a strict undo names the customers whose prices changed since.
  const customerRows = useProductCustomerPrices(productId, editing || lastSave != null).data
    ?.customers;
  const customers = React.useMemo(
    () => (customerRows ?? []) as CustomerPricingWithId[],
    [customerRows],
  );

  const served = React.useMemo(() => (grid ? viewFromGrid(grid) : null), [grid]);
  const rules = React.useMemo(() => (grid ? rulesFromGrid(grid) : {}), [grid]);

  const fold = React.useMemo(
    () => (served ? foldDraft(served, rules, entries, openKey, keeps, tierName, customers) : null),
    [served, rules, entries, openKey, keeps, tierName, customers],
  );
  const view = fold?.view ?? null;

  const patches = fold?.patches ?? [];
  const customerMoves = [...(fold?.customerMoves ?? []), ...moves];
  const problems = fold?.problems ?? [];
  const conflicts = fold?.conflicts ?? [];
  const bakedTitles = fold?.bakedTitles ?? [];
  const patched = new Set(patches.map((p) => cellKey(p.ref, p.tier)));
  const sendKeeps = keeps.filter((k) => !patched.has(cellKey(k.ref, k.tier)));
  const count = patches.length + sendKeeps.length + customerMoves.length;
  const dirty = count > 0 || problems.length > 0 || conflicts.length > 0;

  const reset = React.useCallback(() => {
    setEditing(false);
    setEntries([]);
    setOpenKey(null);
    setNotice(null);
    setKeeps([]);
    setMoves([]);
    setFocus(null);
  }, []);

  // Ticked offers live in the draft (kind "offer" entries), so they outlive the open plan; the open plan's ticks are read back.
  const ticks = (fold?.open?.offers ?? []).map((o) =>
    entries.some((e) => e.kind === "offer" && e.id === offerId(openKey ?? "", o)),
  );
  // setOfferTicked may be called in the same batch as applyPlan, before the plan has rendered: applyPlan sets this too.
  const openRef = React.useRef<{ key: string; plan: PricePlan } | null>(null);
  openRef.current = fold?.open && openKey ? { key: openKey, plan: fold.open } : null;

  const editCell = (ref: string, tier: PriceTier, typed: string): PricePlan => {
    const key = cellKey(ref, tier);
    // Re-typing THIS cell recomputes its offers, so choices ticked on the old ones are cleared, never silently.
    const stale = entries.filter((e) => e.kind === "offer" && e.planKey === key);
    const next: DraftEntry[] = [
      ...entries.filter(
        (e) => !(e.kind === "cell" && e.key === key) && !(e.kind === "offer" && e.planKey === key),
      ),
      { kind: "cell", key, text: typed },
    ];
    hooksRef.current.onEdit?.();
    setEntries(next);
    setOpenKey(key);
    if (stale.length > 0) setNotice(clearedNotice(stale));
    const r = foldDraft(served!, rules, next, key, keeps, tierName, customers);
    return r.plans.get(key)!;
  };

  // The grid DTO guarantees revision and priceState (lead final ruling: both required on every write).
  const toRequest = (): SavePricesRequest | null =>
    !grid || conflicts.length > 0
      ? null
      : {
          expectedRevision: grid.revision,
          expectedPriceState: grid.priceState,
          patches: patches.map((p) => ({ ref: p.ref, tier: p.tier, to: p.to })),
          keeps: sendKeeps.map((k) => ({ ref: k.ref, tier: k.tier, value: k.value })),
          customerMoves,
        };

  const canSave =
    editing &&
    !save.isPending &&
    !gridQuery.isFetching &&
    count > 0 &&
    problems.length === 0 &&
    conflicts.length === 0 &&
    !!grid;

  const texts: Record<string, string> = {};
  for (const e of entries) if (e.kind === "cell") texts[e.key] = e.text;

  // A stale-write notice stays until the user acts: Reload prices (which resets the save) or the next Save (which
  // clears the mutation's error while it runs). A refetch behind their back never takes it away. The texts are the
  // draft as it was when the error came, so the add-unit hint only sticks to the attempt it was raised on.
  const errSeen = React.useRef<{ error: unknown; texts: Record<string, string> }>({
    error: null,
    texts: {},
  });
  if (save.error !== errSeen.current.error)
    errSeen.current = { error: save.error, texts: { ...texts } };
  const saveError = priceWriteError(save.error);

  // Everything a stale answer can rest on: the grid revision AND the customers' prices a ticked offer froze as `from`.
  const refetchPrices = () => {
    void qc.invalidateQueries({ queryKey: priceGridKey(productId) });
    void qc.invalidateQueries({ queryKey: productCustomerPricesKey(productId) });
  };

  // A ticked customer offer froze its moves' `from` when it was ticked. When the customers' prices arrive different,
  // the offer is no longer what the user saw: untick it with a notice (never silently re-tick; SA-799 a). The open
  // plan is re-planned from the fresh rows on its own, so it shows the new from/to, unticked.
  const staleOffersRef = React.useRef<() => void>(() => undefined);
  staleOffersRef.current = () => {
    const priceOf = (id: string, ref: string) =>
      customers.find((c) => c.customerId === id)?.set?.[ref] ?? null;
    const stale = entries.filter(
      (e) => e.kind === "offer" && e.moves.some((m) => priceOf(m.customerId, m.ref) !== m.from),
    );
    if (stale.length === 0) return;
    setEntries((es) => es.filter((e) => !stale.includes(e)));
    setNotice(clearedNotice(stale, "those customers' prices changed"));
  };
  React.useEffect(() => {
    if (customerRows) staleOffersRef.current();
  }, [customerRows]);

  const doSave = () => {
    const req = toRequest();
    if (!canSave || !req) return;
    save.mutate(req, {
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
    if (!lastSave || !grid) return;
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
        ? changesFrom(served, rules, asCellPatches(lastSave.undo?.patches ?? []))
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
      ? changesFrom(
          viewFromGrid(fresh),
          rulesFromGrid(fresh),
          asCellPatches(lastSave.undo?.patches ?? []),
        )
      : [];
    return {
      revision: fresh.revision,
      priceState: fresh.priceState,
      customerMoves: lastSave?.undo?.customerMoves.length ?? 0,
      // `ref` is the row's unique id (cell key); K5 renders `label`, `current` and `restoreTo`.
      rows: changes.map((c) => ({
        ref: `${c.ref}|${c.tier}`,
        label: `${tierName(c.tier)} ${c.label}`,
        current: formatMoney(c.from),
        restoreTo: formatMoney(c.to),
      })),
    };
  };

  const beginEditing = () => {
    setEditing(true);
    setLastSave(null);
    hooksRef.current.onEdit?.();
  };

  const api: GridEditApi = {
    editing,
    begin: (cell) => {
      beginEditing();
      if (cell) setFocus(cell);
    },
    text: (ref, tier, original) => texts[cellKey(ref, tier)] ?? original,
    setText: (ref, tier, text, original) => {
      if (text === original) {
        const key = cellKey(ref, tier);
        const stale = entries.filter((e) => e.kind === "offer" && e.planKey === key);
        if (stale.length > 0) setNotice(clearedNotice(stale));
        setEntries((es) =>
          es.filter(
            (e) =>
              !(e.kind === "cell" && e.key === key) && !(e.kind === "offer" && e.planKey === key),
          ),
        );
      } else editCell(ref, tier as PriceTier, text);
    },
    changed: (ref, tier) => cellKey(ref, tier) in texts,
    // The first price on the implicit base row: the server says the unit must exist first (400 PRICE_EDIT_INVALID).
    addUnitProblem: (ref, tier) => {
      const key = cellKey(ref, tier);
      const said =
        saveError?.code === "invalid" ? saveError.problems.find(ADD_UNIT_FIRST) : undefined;
      return said &&
        ref === "base" &&
        texts[key] !== undefined &&
        texts[key] === errSeen.current.texts[key]
        ? said
        : null;
    },
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
    discard: () => {
      // A refused save must not outlive the draft it refused: the next Edit starts clean on fresh prices.
      if (save.error != null) save.reset();
      if (saveError?.code === "stale") refetchPrices();
      reset();
    },
    dirty,
    editCell,
    plan:
      fold?.open && openKey
        ? {
            plan: fold.open,
            cell: openKey.startsWith("plan:") ? null : parseKey(openKey),
            ticked: ticks,
            keeps,
            customerKeeps: moves,
          }
        : null,
    ticks,
    notice,
    setOfferTicked: (i, on) => {
      const o = openRef.current;
      const offer = o?.plan.offers[i];
      if (!o || !offer) return;
      const id = offerId(o.key, offer);
      setEntries((es) => {
        const rest = es.filter((e) => !(e.kind === "offer" && e.id === id));
        if (!on) return rest;
        const baked: DraftEntry = {
          kind: "offer",
          id,
          planKey: o.key,
          title: offer.title,
          patches: offer.kind === "tier" ? offer.patches : [],
          // Only the wire fields: `against` / `cause` are display facts and must not reach the server.
          moves:
            offer.kind === "customer"
              ? offer.moves.map(({ customerId, ref, tier, from, to }) => ({
                  customerId,
                  ref,
                  tier,
                  from,
                  to,
                }))
              : [],
        };
        return [...rest, baked];
      });
    },
    keep: (pin) =>
      setKeeps((ks) =>
        ks.some((k) => k.ref === pin.ref && k.tier === pin.tier) ? ks : [...ks, pin],
      ),
    unkeep: (pin) =>
      setKeeps((ks) => ks.filter((k) => !(k.ref === pin.ref && k.tier === pin.tier))),
    keepCustomer: (move, on = true) =>
      setMoves((ms) => {
        const rest = ms.filter(
          (m) => !(m.customerId === move.customerId && m.ref === move.ref && m.tier === move.tier),
        );
        return on ? [...rest, move] : rest;
      }),
    applyPlan: (plan) => {
      beginEditing();
      const key = `plan:${planSeq.current++}`;
      setEntries([...entries, { kind: "plan", key, plan }]);
      setOpenKey(key);
      openRef.current = { key, plan };
    },
    resetAllToAuto: () => {
      if (!served) return;
      const next: DraftEntry[] = [];
      for (const r of served.rows)
        for (const t of [1, 2, 3, 4, 5] as const)
          if (r.set[t - 1] != null && !(r.ref === served.anchor && t === 1))
            next.push({ kind: "cell", key: cellKey(r.ref, t), text: "" });
      // Ticked offers (and the customer moves in them) were worked out against the plan this undoes: say so.
      const gone = entries.filter((e) => e.kind === "offer");
      if (gone.length > 0) setNotice(clearedNotice(gone, "you reset every price to Auto"));
      setEntries(next);
      setOpenKey(null);
    },
    toRequest,
    save: doSave,
    saving: save.isPending,
    saveError,
    canSave,
    lastSave,
    undo,
    conflictRow: (c) => ({
      ref: `${c.customerId}|${c.ref}|${c.tier}`,
      label: `${customerRows?.find((r) => r.customerId === c.customerId)?.name ?? "A customer"}, ${tierName(c.tier as PriceTier)} ${grid?.rows.find((r) => r.ref === c.ref)?.label ?? c.ref}`,
      current: c.current == null ? "No set price" : formatMoney(c.current),
      restoreTo: c.expected == null ? "No set price" : formatMoney(c.expected),
    }),
    reload: () => {
      save.reset();
      refetchPrices();
    },
    markUndone: () => {
      setLastSave(null);
      setUndoStale(false);
    },
    undoPreview,
    loadUndoPreview,
    problems,
    conflicts,
    bakedTitles,
    count,
    keeps,
    tierName,
    api,
  };
}
