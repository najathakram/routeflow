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
import { productTierLabel } from "@/lib/tier-one-label";
import type { UndoPreviewRow } from "../confirm/types";
import type { CellFocus, GridEditApi } from "./edit-types";
import {
  cellKey,
  changesFrom,
  foldDraft,
  offerId,
  parseKey,
  staleKeepMoves,
  staleOfferEntries,
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
// A ticked customer offer or a customer Keep froze what the customers looked like; these say it was cleared because
// they changed (never silently). The offer one says how to get the fresh offer back.
const OFFER_CLEARED =
  "Your earlier choice to update customer prices was cleared because those customers' prices changed. Tick it again to use the new prices.";
const KEEP_CLEARED =
  "Your earlier choice to keep a customer price was cleared because that customer's prices changed.";
// K3b NIT-1: a Keep also goes when the OWNER's own action removes the price change it was made on. Never blamed on prices.
const keepClearedBy = (why: string) =>
  `Your earlier choice to keep a customer price was cleared because ${why}.`;
const PRICE_CHANGE_UNDONE = "that price change was undone";
// A tick that was never made (the plan it came from is older than the customers), so nothing was "cleared".
const TICK_REFUSED =
  "Those customers' prices changed, so this choice can't be used. Review the new prices.";
// Adds a line to the notice (once), so a notice an edit just raised is never replaced by one found at render.
const withLine = (notice: string | null, line: string) =>
  notice == null ? line : notice.includes(line) ? notice : `${notice} ${line}`;
const asCellPatches = (ps: readonly { ref: string; tier: number; to: number | null }[]) =>
  ps.map((p): CellPatch => ({ ref: p.ref, tier: p.tier as PriceTier, to: p.to }));

/** The shared draft store (SPRINT-CONTRACT §3). K3 may add to it, never rename. */
export interface PriceDraft {
  grid: ProductPriceGridDto | undefined;
  /** The draft ladder (edits, ticked offers and Keeps applied). */
  view: LadderView | null;
  editing: boolean;
  startEditing: (focus?: CellFocus) => void;
  /**
   * K11-13: the cell the last `startEditing(cell)` asked to focus, recorded synchronously (a ref, not state) so the
   * grid's "focus the first box" step can see it in the very render where editing turned on and stand aside.
   */
  beginTarget: React.MutableRefObject<CellFocus | null>;
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
   * `replan` works the same change out for the customers as they are now, so the customer offer keeps showing
   * their current prices (K3b).
   */
  applyPlan: (
    plan: PricePlan,
    replan: (customers: readonly CustomerPricingWithId[]) => PricePlan,
    /** K11-15: what this Apply did, as "Case raised 5%"; the bar says it while the draft is still exactly that. */
    lead?: string,
  ) => void;
  /** K11-15: what Apply staged ("Case raised 5%"), only while the draft equals it; any later edit makes it null. */
  appliedLead: string | null;
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
  const tierName = React.useCallback((t: PriceTier) => productTierLabel(labels, t), [labels]);
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
  const beginTarget = React.useRef<CellFocus | null>(null);
  const [lastSave, setLastSave] = React.useState<PriceDraft["lastSave"]>(null);
  const [undoStale, setUndoStale] = React.useState(false);
  const [notice, setNotice] = React.useState<string | null>(null);
  // K11-15: the leads Apply staged and the draft they produced (its signature); read back once the draft has rendered.
  // `sig` is null for the render Apply produced (the draft is exactly what Apply made, so the sentence shows at once);
  // an effect then records the draft's signature, and any later difference is an edit.
  const [applied, setApplied] = React.useState<{ leads: string[]; sig: string | null } | null>(
    null,
  );

  // SA-799: a plain cell edit shows customer changes too. Same query (and cache entry) as Change prices' names; only
  // fetched while editing, so the product page costs nothing extra when nobody edits.
  // Also after a save: a strict undo names the customers whose prices changed since.
  const customersQuery = useProductCustomerPrices(productId, editing || lastSave != null);
  const customerRows = customersQuery.data?.customers;
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
  const sig = JSON.stringify([patches, customerMoves, sendKeeps]);
  React.useEffect(() => {
    if (applied && applied.sig === null) setApplied({ leads: applied.leads, sig });
  }, [applied, sig]);
  const appliedLead =
    applied && count > 0 && (applied.sig === null || applied.sig === sig)
      ? new Intl.ListFormat("en").format(applied.leads)
      : null;

  const reset = React.useCallback(() => {
    setEditing(false);
    setEntries([]);
    setOpenKey(null);
    setNotice(null);
    setKeeps([]);
    setMoves([]);
    setFocus(null);
    setApplied(null);
  }, []);

  // Ticked offers live in the draft (kind "offer" entries), so they outlive the open plan; the open plan's ticks are read back.
  const ticks = (fold?.open?.offers ?? []).map((o) =>
    entries.some((e) => e.kind === "offer" && e.id === offerId(openKey ?? "", o)),
  );
  // setOfferTicked may be called in the same batch as applyPlan, before the plan has rendered: applyPlan sets this too.
  const openRef = React.useRef<{ key: string; plan: PricePlan } | null>(null);
  openRef.current = fold?.open && openKey ? { key: openKey, plan: fold.open } : null;

  // K3b: a ticked offer baked its customer moves, and a customer Keep its `from`; the customers can arrive different
  // (another user, a Reload). Decided here, at render, from the entries, the fold's fresh plans and the customers:
  // an effect keyed on `customerRows` would never fire for identical data (structural sharing keeps the reference).
  // A stale choice is removed from the draft itself, so the data coming back never ticks it again.
  const priceOf = (customerId: string, ref: string) =>
    customerRows?.find((c) => c.customerId === customerId)?.set?.[ref] ?? null;
  const staleOffers = React.useMemo(
    () => (fold && customerRows ? staleOfferEntries(entries, fold.plans) : []),
    [entries, fold, customerRows],
  );
  const staleKeeps = React.useMemo(
    () => (fold && customerRows ? staleKeepMoves(moves, fold.plans, customers) : []),
    [moves, fold, customerRows, customers],
  );
  if (staleOffers.length > 0 || staleKeeps.length > 0) {
    setEntries((es) => es.filter((e) => !staleOffers.includes(e)));
    setMoves((ms) => ms.filter((m) => !staleKeeps.includes(m)));
    setNotice((n) => {
      const said = staleOffers.length > 0 ? withLine(n, OFFER_CLEARED) : n;
      return staleKeeps.length > 0 ? withLine(said, KEEP_CLEARED) : said;
    });
  }

  // K3b NIT-1: the owner's own action (a re-type, a cell put back, Reset all to Auto) can remove the price change a customer
  // Keep was made on. The render check above would drop it too, but say the customers' prices changed; this drops it
  // here, said as the owner's doing. A Keep whose customer has a price of their own now is the customers' doing: left to it.
  const dropKeepsLackingPlan = (next: readonly DraftEntry[], why: string) => {
    if (!served || !customerRows || moves.length === 0) return;
    const plans = foldDraft(served, rules, next, null, keeps, tierName, customers).plans;
    const gone = staleKeepMoves(moves, plans, customers).filter(
      (m) =>
        (customers.find((c) => c.customerId === m.customerId)?.set?.[m.ref] ?? null) === m.from,
    );
    if (gone.length === 0) return;
    setMoves((ms) => ms.filter((m) => !gone.includes(m)));
    setNotice((n) => withLine(n, keepClearedBy(why)));
  };

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
    dropKeepsLackingPlan(next, "you changed that price again");
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
    !customersQuery.isFetching &&
    count > 0 &&
    problems.length === 0 &&
    conflicts.length === 0 &&
    !!grid;

  // In entry order: a plan or a ticked offer that comes AFTER a typed cell patches over it (the fold writes the later
  // value), so the typed text is dropped and the drafted value shows; a cell typed after them wins, as it does in the fold.
  const texts: Record<string, string> = {};
  for (const e of entries) {
    if (e.kind === "cell") texts[e.key] = e.text;
    else
      for (const p of e.kind === "plan" ? e.plan.patches : e.patches)
        delete texts[cellKey(p.ref, p.tier)];
  }
  // F03: a price a Change prices plan or a ticked offer wrote into the draft shows in its box like a typed one (an Auto
  // price the draft sets back to Auto shows empty), instead of the saved price with the new one as a faint hint.
  const drafted = new Map(
    patches.map((p) => [cellKey(p.ref, p.tier), p.to == null ? "" : String(p.to)]),
  );
  // A cell a plan or an offer patched has to be typed back to its saved price as a draft entry, not by dropping one.
  const patchedByPlan = (key: string) =>
    entries.some(
      (e) =>
        e.kind !== "cell" &&
        (e.kind === "plan" ? e.plan.patches : e.patches).some(
          (p) => cellKey(p.ref, p.tier) === key,
        ),
    );

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
      beginTarget.current = cell ?? null;
      if (cell) setFocus(cell);
    },
    text: (ref, tier, original) => {
      const key = cellKey(ref, tier);
      return texts[key] ?? drafted.get(key) ?? original;
    },
    setText: (ref, tier, text, original) => {
      const key = cellKey(ref, tier);
      if (text === original && !patchedByPlan(key)) {
        const stale = entries.filter((e) => e.kind === "offer" && e.planKey === key);
        if (stale.length > 0) setNotice(clearedNotice(stale));
        const next = entries.filter(
          (e) =>
            !(e.kind === "cell" && e.key === key) && !(e.kind === "offer" && e.planKey === key),
        );
        dropKeepsLackingPlan(next, PRICE_CHANGE_UNDONE);
        setEntries((es) =>
          es.filter(
            (e) =>
              !(e.kind === "cell" && e.key === key) && !(e.kind === "offer" && e.planKey === key),
          ),
        );
      } else editCell(ref, tier as PriceTier, text);
    },
    changed: (ref, tier) => cellKey(ref, tier) in texts || drafted.has(cellKey(ref, tier)),
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
    beginTarget,
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
      // The moves froze `from` when the plan was made; refuse a tick that no longer matches the customers' prices.
      if (on && customerRows && offer.kind === "customer") {
        if (offer.moves.some((m) => priceOf(m.customerId, m.ref) !== m.from)) {
          setNotice((n) => withLine(n, TICK_REFUSED));
          return;
        }
      }
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
    applyPlan: (plan, replan, lead) => {
      // Only a draft that was empty, or still exactly the last Apply, can be described by Apply's words.
      const leads =
        lead && (count === 0 || appliedLead)
          ? [...(count === 0 ? [] : applied!.leads), lead]
          : null;
      setApplied(leads ? { leads, sig: null } : null);
      beginEditing();
      const key = `plan:${planSeq.current++}`;
      setEntries([...entries, { kind: "plan", key, plan, replan }]);
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
      dropKeepsLackingPlan(next, PRICE_CHANGE_UNDONE);
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
    appliedLead,
    keeps,
    tierName,
    api,
  };
}
