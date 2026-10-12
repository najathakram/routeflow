"use client";

import * as React from "react";
import type { SellLevel } from "@routeflow/pricing";
import {
  archivedMessage,
  resolveProductByCode,
  type BarcodeResolveResult,
} from "@/lib/barcode-resolve";
import { fetchCategoryPage, findCategoryProducts } from "@/lib/counter-category-search";
import { parseScanField } from "@/lib/counter-sale";
import { scanLevelForHit } from "./scan/useScanCodeHandler";

/** Fixed copy: a FAILED lookup is never "No product found", and never shows the server's own text. */
export const COUNTER_SCAN_FAILED_COPY =
  "Couldn't look up the code. Check the connection and try again.";
export const COUNTER_SCAN_NOT_FOUND_COPY = "No product found for that code.";

/** One entry of the scan queue: a code, or a 1-3 digit entry that is a code only if a product matches it EXACTLY. */
type ScanItem = { kind: "code"; code: string } | { kind: "short"; n: number; code: string };

export interface ScanPicker {
  code: string;
  qty: number;
  matches: any[];
  /** CQ-10: set when the typed text named a CATEGORY: its stored name, the page shown and the total in it. */
  category?: { name: string; page: number; total: number; hasMore: boolean };
}

interface Deps {
  /** Locked (outcome unknown): a late result must not change the cart. */
  locked: boolean;
  /** Puts one resolved product on the cart. */
  add: (product: any, level: SellLevel, n: number) => void;
  refocus: () => void;
}

/**
 * B1206-B1208, D5: the till's scan pipeline. Every submitted scan joins ONE FIFO queue and is resolved in order
 * through the shared `resolveProductByCode` ladder (exact barcode/sku/unit code first), so a second scan before the
 * first lookup returns is never dropped, two scans of one code count twice, and a typed quantity multiplies the
 * next scan IN QUEUE ORDER. Ambiguity opens a picker (never row 0); a failed lookup pauses the queue behind a
 * retryable error. Money is not touched here: the callback adds a line and the screen prices it.
 */
export function useCounterSaleScan(deps: Deps) {
  const depsRef = React.useRef(deps);
  depsRef.current = deps;
  const queueRef = React.useRef<ScanItem[]>([]);
  const carryRef = React.useRef(1); // the typed quantity waiting for the next scan, at PROCESSING time
  const runningRef = React.useRef(false);
  const pausedRef = React.useRef(false);
  const epochRef = React.useRef(0);
  const aliveRef = React.useRef(true);
  const [pendingQty, setPendingQty] = React.useState(1); // display only
  const [message, setMessage] = React.useState("");
  const [picker, setPicker] = React.useState<ScanPicker | null>(null);
  const [failed, setFailed] = React.useState(false);
  const [waiting, setWaiting] = React.useState(0);

  React.useEffect(() => {
    aliveRef.current = true;
    return () => {
      aliveRef.current = false;
    };
  }, []);

  const setCarry = (n: number) => {
    carryRef.current = n;
    setPendingQty(n);
  };
  const shift = () => {
    queueRef.current.shift();
    setWaiting(queueRef.current.length);
  };

  const drain = React.useCallback(async (): Promise<void> => {
    if (runningRef.current || pausedRef.current) return;
    runningRef.current = true;
    try {
      while (queueRef.current.length > 0 && !pausedRef.current) {
        const epoch = epochRef.current;
        const item = queueRef.current[0];
        let result: BarcodeResolveResult | null = null;
        let lookupFailed = false;
        if (!depsRef.current.locked) {
          try {
            result = await resolveProductByCode(item.code);
          } catch {
            lookupFailed = true;
          }
        }
        if (!aliveRef.current || epoch !== epochRef.current) return; // the sale was reset meanwhile
        if (depsRef.current.locked) {
          shift(); // a late lookup must not change a locked cart
          continue;
        }
        if (lookupFailed || !result) {
          pausedRef.current = true;
          setFailed(true);
          return;
        }
        const exact = !result.notFound && result.source !== "search";
        if (item.kind === "short" && !exact) {
          setCarry(item.n); // not a product: a quantity for the next scan
          setMessage("");
          shift();
          continue;
        }
        if (result.notFound) {
          // CQ-10: not a code, but possibly a CATEGORY name: list its products (a miss here is still "not found")
          const byCategory = item.kind === "code" ? await findCategoryProducts(item.code) : null;
          if (!aliveRef.current || epoch !== epochRef.current) return;
          if (byCategory) {
            pausedRef.current = true;
            setPicker({
              code: item.code,
              qty: carryRef.current,
              matches: byCategory.products,
              category: {
                name: byCategory.category,
                page: byCategory.page,
                total: byCategory.total,
                hasMore: byCategory.hasMore,
              },
            });
            return; // the item stays at the head until one is chosen
          }
          setMessage(COUNTER_SCAN_NOT_FOUND_COPY);
          setCarry(1);
        } else if (result.archived) {
          setMessage(archivedMessage(result.product));
          setCarry(1);
        } else if (result.ambiguous && result.matches) {
          pausedRef.current = true;
          setPicker({ code: item.code, qty: carryRef.current, matches: result.matches });
          return; // the item stays at the head until one is chosen
        } else {
          depsRef.current.add(
            result.product,
            scanLevelForHit(item.code, result.product),
            carryRef.current,
          );
          setMessage("");
          setCarry(1);
        }
        shift();
      }
    } finally {
      runningRef.current = false;
      if (aliveRef.current && !pausedRef.current && queueRef.current.length > 0) void drain();
      else depsRef.current.refocus();
    }
  }, []);

  const resume = () => {
    pausedRef.current = false;
    void drain();
  };

  /** One submitted field value. Returns nothing; the queue decides. */
  const submit = (raw: string) => {
    const parsed = parseScanField(raw);
    if (parsed.kind === "qty") {
      queueRef.current.push({ kind: "short", n: parsed.qty, code: String(parsed.qty) });
      setPendingQty(parsed.qty); // shown at once; confirmed (or turned into a code) when it is processed
    } else {
      if (!parsed.code) return;
      queueRef.current.push({ kind: "code", code: parsed.code });
      setPendingQty(1);
    }
    setWaiting(queueRef.current.length);
    void drain();
  };

  const choose = (product: any) => {
    const qty = picker?.qty ?? 1;
    setPicker(null);
    depsRef.current.add(product, "BOX", qty); // a picker click is a whole selling unit, as in Create Order
    setCarry(1);
    setMessage("");
    shift();
    resume();
  };
  const [moreBusy, setMoreBusy] = React.useState(false);
  /** CQ-10: the next page of the open category list, appended (a product never appears twice). */
  const loadMore = async () => {
    const cur = picker;
    if (!cur?.category || !cur.category.hasMore || moreBusy) return;
    setMoreBusy(true);
    try {
      const next = await fetchCategoryPage(cur.category.name, cur.category.page + 1);
      if (!aliveRef.current) return;
      setPicker((p) => {
        if (!p?.category) return p;
        const have = new Set(p.matches.map((m: any) => m.id));
        return {
          ...p,
          matches: [...p.matches, ...next.products.filter((m: any) => !have.has(m.id))],
          category: { ...p.category, page: next.page, total: next.total, hasMore: next.hasMore },
        };
      });
    } catch {
      // the list stays as it is; "Show more" can be tried again
    } finally {
      setMoreBusy(false);
    }
  };
  const cancelPicker = () => {
    setPicker(null);
    setCarry(1);
    shift();
    resume();
  };
  const retry = () => {
    setFailed(false);
    resume();
  };
  const dismissFailure = () => {
    setFailed(false);
    shift();
    setCarry(1);
    resume();
  };
  const reset = () => {
    epochRef.current += 1;
    queueRef.current = [];
    pausedRef.current = false;
    setCarry(1);
    setMessage("");
    setPicker(null);
    setFailed(false);
    setWaiting(0);
  };

  return {
    pendingQty,
    message,
    picker,
    failed,
    waiting,
    submit,
    choose,
    loadMore,
    moreBusy,
    cancelPicker,
    retry,
    dismissFailure,
    reset,
  };
}
