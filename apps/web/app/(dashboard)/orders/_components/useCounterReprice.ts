"use client";

import * as React from "react";
import { useCustomerPrices } from "@/lib/api/customers";
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

  const answered = customer === null || prices.isSuccess;
  React.useEffect(() => {
    if (locked) {
      // The held / in-flight cart is frozen: it is never re-priced.
      appliedKeyRef.current = key;
      setAppliedKey(key);
      return;
    }
    if (!answered) return; // in flight or failed: the old prices stay
    const before = linesRef.current;
    const r = repriceLines(before, tierFor);
    if (r.lines !== before) setLines((cur) => repriceLines(cur, tierFor).lines);
    if (appliedKeyRef.current !== key) {
      const text = before.length
        ? repriceNote(
            customer?.businessName ?? "Walk-in customer",
            r.changed,
            r.kept,
            tierLabel(tierLabels, customer?.pricingTier ?? 1),
          )
        : null;
      setNote(text ? { text, prevLines: before } : null);
    }
    appliedKeyRef.current = key;
    setAppliedKey(key);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, answered, tierFor, locked]);

  const failed = appliedKey !== key && prices.isError && !prices.isFetching;
  const blocked = appliedKey !== key;

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
    retry: () => void prices.refetch(),
    tierFor,
  };
}
