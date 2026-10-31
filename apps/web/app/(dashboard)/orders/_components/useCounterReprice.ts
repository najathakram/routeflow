"use client";

import * as React from "react";
import { useCustomerPrices } from "@/lib/api/customers";
import { useCustomerPriceLayer } from "@/lib/api/useCustomerPriceLayer";
import { useCustomerPriceHistory } from "@/lib/api/orders";
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
 * CustomerPrice tier, else the customer's default tier -> getTierPrice). The display reads the server's rule, and the sale
 * request carries no price for an unedited line (the server prices it).
 * `blocked` is true while the lookup is in flight or after it failed (Pay waits); the old prices stay on screen.
 *
 * S19b (SA-811a, SA-813): flag on, the customer's price layer (`useCustomerPriceLayer`) joins the lookup: a layered product
 * prices at the customer's price through `customerLinePrice`, and while the layer is pending or failed the prices are
 * UNCONFIRMED (`blocked`/`failed`, Pay waits, Retry refetches both). Flag off: no layer request, master's numbers.
 *
 * SA-1068: the customer's remembered prices (`useCustomerPriceHistory`, the server's own read) join the lookup the same way: an
 * above-list remembered price is what the server books for a plain line, so `rememberedOf` puts it on the screen, and while
 * the read is pending or failed the prices are unconfirmed (Pay waits, Retry refetches it). A walk-in has no customer, so no read.
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
  const history = useCustomerPriceHistory(customer?.id);
  const historyRef = React.useRef(history.data);
  historyRef.current = history.data;
  const rememberedOf = React.useCallback(
    (productId: string): number | null => historyRef.current?.[productId]?.lastPrice ?? null,
    [],
  );
  // The remembered prices of the cart's products: a refetch that changes one re-prices the cart.
  const rememberedSig = lines.map((l) => rememberedOf(l.productId) ?? "").join("|");
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

  const answered = customer === null || (prices.isSuccess && priceLayer.ready && history.isSuccess);
  React.useEffect(() => {
    if (locked) {
      // The held / in-flight cart is frozen: it is never re-priced.
      appliedKeyRef.current = key;
      setAppliedKey(key);
      return;
    }
    if (!answered) return; // in flight or failed: the old prices stay
    const before = linesRef.current;
    const r = repriceLines(before, tierFor, layerOf, rememberedOf);
    if (r.lines !== before)
      setLines((cur) => repriceLines(cur, tierFor, layerOf, rememberedOf).lines);
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
  }, [key, answered, tierFor, locked, layerSig, rememberedSig]);

  // SA-813 M1: an INCOMPLETE layer (past the row cap) does not confirm a cart product it omits.
  const incomplete =
    priceLayer.enabled && priceLayer.ready && lines.some((l) => !priceLayer.lineReady(l.productId));
  // SA-1068: no customer = no read. Pending = not answered yet; failed = errored and not retrying.
  const historyFailed = customer !== null && history.isError && !history.isFetching;
  const historyPending = customer !== null && !history.isSuccess && !historyFailed;
  const failed =
    priceLayer.failed ||
    historyFailed ||
    (appliedKey !== key && prices.isError && !prices.isFetching);
  // SA-813: a pending or failed layer leaves the prices unconfirmed even when the customer key is already applied.
  const blocked =
    appliedKey !== key ||
    priceLayer.pending ||
    priceLayer.failed ||
    incomplete ||
    historyPending ||
    historyFailed;

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
      if (customer !== null) void history.refetch();
      // refetch() runs even a DISABLED query (TanStack v5): flag off it would hit a gated route (403 + upgrade toast).
      if (priceLayer.enabled) priceLayer.refetch();
    },
    tierFor,
    layerOf,
    /** SA-1068: the customer's remembered price for a product (the server's sticky upsell), or null. */
    rememberedOf,
    /** SA-813 M1/M3 + SA-1068: the layer or remembered-price read is pending or failed - prices are UNCONFIRMED (null = confirmed). */
    unconfirmed: (priceLayer.failed || historyFailed
      ? "failed"
      : priceLayer.pending || historyPending
        ? "pending"
        : incomplete
          ? "incomplete"
          : null) as "pending" | "failed" | "incomplete" | null,
  };
}
