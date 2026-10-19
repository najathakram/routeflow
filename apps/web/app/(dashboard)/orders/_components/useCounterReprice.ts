"use client";

import * as React from "react";
import { useCustomerPrices } from "@/lib/api/customers";
import { useCustomerPriceLayer } from "@/lib/api/useCustomerPriceLayer";
import type { SaleLine } from "./counter-sale-scan";
import { useTierLabels } from "@/lib/api/tier-labels";
import { tierLabel } from "@/lib/tier-label";
import { repriceLines, repriceNote } from "./counter-sale-reprice";

interface PickedLike {
  id: string;
  businessName: string;
  pricingTier?: number | null;
}

interface Note {
  text: string;
  prevLines: SaleLine[];
}

const keyOf = (c: PickedLike | null) => (c ? `${c.id}:${c.pricingTier ?? 1}` : "walk-in");

/**
 * POS-2: when the customer on the counter sale changes (picked after items were scanned as a walk-in, or reverted to
 * walk-in), every line is re-priced for them through the lookup Create Order uses (`useCustomerPrices` -> the per-product
 * CustomerPrice tier, else the customer's default tier -> getTierPrice). DISPLAY ONLY: the sale request carries no price.
 * `blocked` is true while the lookup is in flight or after it failed (Pay waits); the old prices stay on screen.
 *
 * S19b (SA-811a, SA-813): flag on, the customer's price layer (`useCustomerPriceLayer`) joins the lookup: a layered product
 * prices at the customer's price through `customerLinePrice`, and while the layer is pending or failed the prices are
 * UNCONFIRMED (`blocked`/`failed`, Pay waits, Retry refetches both). Flag off: no layer request, master's numbers.
 */
export function useCounterReprice<C extends PickedLike>(deps: {
  customer: C | null;
  lines: SaleLine[];
  setLines: React.Dispatch<React.SetStateAction<SaleLine[]>>;
  /** Outcome unknown: the held cart is frozen, never re-priced. */
  locked: boolean;
  /** SA-748: bumped when a parked cart is restored, so its lines are re-priced even when the customer did not change. */
  epoch?: number;
}) {
  const { customer, lines, setLines, locked, epoch = 0 } = deps;
  const key = keyOf(customer) + (epoch ? `#${epoch}` : "");
  const prices = useCustomerPrices(customer?.id);
  const cpMap = React.useMemo(() => {
    const m = new Map<string, number | null>();
    const rows: unknown = prices.data;
    if (Array.isArray(rows)) {
      for (const cp of rows as { productId: string; pricingTier?: number | null }[]) {
        m.set(cp.productId, cp.pricingTier ?? null);
      }
    }
    return m;
  }, [prices.data]);
  const priceLayer = useCustomerPriceLayer(customer?.id);
  const layerOfRef = React.useRef(priceLayer.layerOf);
  layerOfRef.current = priceLayer.layerOf;
  const layerOf = React.useCallback((productId: string) => layerOfRef.current(productId), []);
  // The layer's content for the cart's products: a refetch that changes a price re-prices the cart.
  const layerSig = priceLayer.enabled
    ? lines.map((l) => JSON.stringify(priceLayer.layerOf(l.productId) ?? null)).join("|")
    : "";
  const tierFor = React.useCallback(
    (productId: string) => cpMap.get(productId) ?? customer?.pricingTier ?? 1,
    [cpMap, customer?.pricingTier],
  );

  const [appliedKey, setAppliedKey] = React.useState(key);
  const [note, setNote] = React.useState<Note | null>(null);
  const { data: tierLabels } = useTierLabels();
  const linesRef = React.useRef(lines);
  linesRef.current = lines;
  const appliedKeyRef = React.useRef(key);

  const answered = customer === null || (prices.isSuccess && priceLayer.ready);
  React.useEffect(() => {
    if (locked) {
      // The held / in-flight cart is frozen: it is never re-priced.
      appliedKeyRef.current = key;
      setAppliedKey(key);
      return;
    }
    if (!answered) return; // in flight or failed: the old prices stay
    const before = linesRef.current;
    const r = repriceLines(before, tierFor, layerOf);
    if (r.lines !== before) setLines((cur) => repriceLines(cur, tierFor, layerOf).lines);
    if (appliedKeyRef.current !== key) {
      const text = before.length
        ? repriceNote(
            customer?.businessName ?? "Walk-in customer",
            r.changed,
            r.kept,
            tierLabel(tierLabels, customer?.pricingTier ?? 1),
            r.dropped,
          )
        : null;
      setNote(text ? { text, prevLines: before } : null);
    }
    appliedKeyRef.current = key;
    setAppliedKey(key);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, answered, tierFor, locked, layerSig]);

  // SA-813 M1: an INCOMPLETE layer (past the row cap) does not confirm a cart product it omits.
  const incomplete =
    priceLayer.enabled && priceLayer.ready && lines.some((l) => !priceLayer.lineReady(l.productId));
  const failed = priceLayer.failed || (appliedKey !== key && prices.isError && !prices.isFetching);
  // SA-813: a pending or failed layer leaves the prices unconfirmed even when the customer key is already applied.
  const blocked = appliedKey !== key || priceLayer.pending || priceLayer.failed || incomplete;

  const undo = () => {
    if (!note) return;
    // PRICES ONLY: the customer stays on the sale; lines added since keep the price they were given.
    const old = note.prevLines;
    setLines((cur) =>
      cur.map((l) => {
        const o = old.find((p) => p.tempId === l.tempId);
        if (!o) return l;
        // POS-5: an edited line's price state (net, tier price, choice) goes back with the prices.
        const { override: _o, tierPrice: _t, priceEdited: _e, ...rest } = l;
        return {
          ...rest,
          unitPrice: o.unitPrice,
          priceType: o.priceType,
          ...(o.override
            ? { tierPrice: o.tierPrice, override: o.override, priceEdited: true as const }
            : {}),
        };
      }),
    );
    setNote(null);
  };

  return {
    blocked,
    failed,
    noteText: note?.text ?? null,
    undo,
    dismiss: () => setNote(null),
    retry: () => {
      void prices.refetch();
      // refetch() runs even a DISABLED query (TanStack v5): flag off it would hit a gated route (403 + upgrade toast).
      if (priceLayer.enabled) priceLayer.refetch();
    },
    tierFor,
    layerOf,
    /** SA-813 M1/M3: flag on and the layer read is pending or failed - prices are UNCONFIRMED (null = confirmed). */
    unconfirmed: (priceLayer.failed
      ? "failed"
      : priceLayer.pending
        ? "pending"
        : incomplete
          ? "incomplete"
          : null) as "pending" | "failed" | "incomplete" | null,
  };
}
