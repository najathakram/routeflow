"use client";

import * as React from "react";
import type { SellLevel } from "@routeflow/pricing";
import { cueForOutcome } from "@routeflow/scanning";
import {
  archivedMessage,
  resolveProductByCode,
  SCAN_LOOKUP_TIMEOUT_MS,
  type BarcodeResolveResult,
} from "@/lib/barcode-resolve";
import { fetchCategoryPage, findCategoryProducts } from "@/lib/counter-category-search";
import { parseScanField } from "@/lib/counter-sale";
import { displayProductName } from "@/lib/product-display";
import { playScanCue } from "@/lib/scan-cue";
import { scanLevelForHit } from "./scan/useScanCodeHandler";
import { ADDED_CONFIRMATION_MS, addedCopy, noProductCopy } from "./counter-scan-feedback";

/** Fixed copy: a FAILED lookup is never "No product found", and never shows the server's own text. */
export const COUNTER_SCAN_FAILED_COPY =
  "Couldn't look up the code. Check the connection and try again.";

/**
 * One entry of the scan queue: a code (`qty` set when it came as "2*code" / "2x code", F01), or a 1-3 digit entry that is a
 * code only if a product matches it EXACTLY. `camera` marks a code the camera decoded (SA-1059): only those are answered with
 * the accept / reject cue, a wedge or typed scan stays silent as it always was.
 */
type ScanItem =
  | { kind: "code"; code: string; qty?: number; camera?: boolean }
  | { kind: "short"; n: number; code: string };

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
  /** Returns false when the cart refused the add (a line at its cap): nothing is confirmed then. */
  add: (product: any, level: SellLevel, n: number) => boolean | void;
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
  // W-1042: `code` is set only on a final not-found (after the category browse): the miss line offers Create item for it.
  const [miss, setMiss] = React.useState({ message: "", code: "" });
  const message = miss.message;
  const setMessage = React.useCallback(
    (text: string, code = "") => setMiss({ message: text, code }),
    [],
  );
  // F05: "Added <name>" for the latest scan that landed; it fades by itself and goes at once on a miss.
  const [added, setAdded] = React.useState("");
  const addedTimerRef = React.useRef<number | null>(null);
  const clearAdded = React.useCallback(() => {
    if (addedTimerRef.current !== null) window.clearTimeout(addedTimerRef.current);
    addedTimerRef.current = null;
    setAdded("");
  }, []);
  const confirmAdded = React.useCallback((product: any) => {
    if (addedTimerRef.current !== null) window.clearTimeout(addedTimerRef.current);
    setAdded(addedCopy(displayProductName(product)));
    addedTimerRef.current = window.setTimeout(() => {
      addedTimerRef.current = null;
      setAdded("");
    }, ADDED_CONFIRMATION_MS);
  }, []);
  const [picker, setPicker] = React.useState<ScanPicker | null>(null);
  const [failed, setFailed] = React.useState(false);
  const [waiting, setWaiting] = React.useState(0);

  React.useEffect(() => {
    aliveRef.current = true;
    return () => {
      aliveRef.current = false;
      if (addedTimerRef.current !== null) window.clearTimeout(addedTimerRef.current);
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
  // SA-1059: a camera scan is answered by sound (the clerk is looking at the item, not the screen): the shared decision turns
  // "added" into the accept cue and every other outcome (a miss, a refused add, an ambiguous pick, a failed lookup) into reject.
  const cue = (item: ScanItem, kind: "added" | "error") => {
    if (item.kind === "code" && item.camera)
      playScanCue(cueForOutcome({ feedback: { kind, text: item.code } }));
  };

  const drain = React.useCallback(async (): Promise<void> => {
    if (runningRef.current || pausedRef.current) return;
    runningRef.current = true;
    try {
      while (queueRef.current.length > 0 && !pausedRef.current) {
        const epoch = epochRef.current;
        const item = queueRef.current[0];
        // F01: the prefix is this code's quantity; it never touches the carry (a dropped item must leave none behind)
        const qty = item.kind === "code" && item.qty ? item.qty : carryRef.current;
        let result: BarcodeResolveResult | null = null;
        let lookupFailed = false;
        if (!depsRef.current.locked) {
          try {
            // Row 541: a lookup that never answers ends at the deadline as a failure (the retry cue), never a stuck till.
            result = await resolveProductByCode(item.code, { timeoutMs: SCAN_LOOKUP_TIMEOUT_MS });
          } catch {
            lookupFailed = true;
          }
        }
        if (!aliveRef.current || epoch !== epochRef.current) return; // the sale was reset meanwhile
        if (depsRef.current.locked) {
          cue(item, "error"); // dropped, not counted
          shift(); // a late lookup must not change a locked cart
          continue;
        }
        if (lookupFailed || !result) {
          cue(item, "error");
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
            cue(item, "error"); // not counted until one is chosen
            pausedRef.current = true;
            setPicker({
              code: item.code,
              qty,
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
          cue(item, "error");
          clearAdded();
          setMessage(noProductCopy(item.code), item.code);
          setCarry(1);
        } else if (result.archived) {
          cue(item, "error");
          clearAdded();
          setMessage(archivedMessage(result.product));
          setCarry(1);
        } else if (result.ambiguous && result.matches) {
          cue(item, "error"); // not counted until one is chosen
          pausedRef.current = true;
          setPicker({ code: item.code, qty, matches: result.matches });
          return; // the item stays at the head until one is chosen
        } else {
          const applied = depsRef.current.add(
            result.product,
            scanLevelForHit(item.code, result.product),
            qty,
          );
          // A refused add (the line is at its cap) must not say "Added": the item was never rung up.
          cue(item, applied === false ? "error" : "added");
          if (applied === false) clearAdded();
          else confirmAdded(result.product);
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
  }, [clearAdded, confirmAdded, setMessage]);

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
      queueRef.current.push({ kind: "code", code: parsed.code, qty: parsed.qty });
      setPendingQty(1);
    }
    setWaiting(queueRef.current.length);
    void drain();
  };

  /**
   * SA-1059: a code the CAMERA decoded joins the same queue, but never through `parseScanField`: that is a parser for typed text,
   * and on a machine read it would turn a decoded "123" into a quantity and "2x1234" into quantity 2 of "1234". The code is
   * looked up whole. The carry is left alone, so a typed quantity still multiplies the next scan in queue order.
   */
  const submitCamera = (code: string) => {
    if (!code) return;
    queueRef.current.push({ kind: "code", code, camera: true });
    setPendingQty(1); // as `submit` does for a code: the chip is spent once the scan is queued
    setWaiting(queueRef.current.length);
    void drain();
  };

  const choose = (product: any) => {
    const qty = picker?.qty ?? 1;
    setPicker(null);
    const applied = depsRef.current.add(product, "BOX", qty); // a picker click is a whole selling unit, as in Create Order
    // SA-1059: the camera scan waiting in the picker is counted now, and the clerk who was looking at the item hears it
    // (the ambiguous outcome itself was cued "rejected": not counted until one is chosen).
    const head = queueRef.current[0];
    if (head) cue(head, applied === false ? "error" : "added");
    if (applied === false) clearAdded();
    else confirmAdded(product);
    setCarry(1);
    setMessage("");
    shift();
    resume();
  };
  /** W-852: a row chosen from the live match list adds like a picker click: a whole selling unit, the typed quantity. */
  const pick = (product: any) => {
    depsRef.current.add(product, "BOX", carryRef.current);
    confirmAdded(product);
    setCarry(1);
    setMessage("");
  };
  const [moreBusy, setMoreBusy] = React.useState(false);
  const moreRef = React.useRef(false); // a ref: a double click must not send two requests
  /** CQ-10: the next page of the open category list, appended (a product never appears twice). */
  const loadMore = async () => {
    const cur = picker;
    if (!cur?.category || !cur.category.hasMore || moreRef.current) return;
    const epoch = epochRef.current;
    const name = cur.category.name;
    moreRef.current = true;
    setMoreBusy(true);
    try {
      const next = await fetchCategoryPage(name, cur.category.page + 1);
      // a reply for a picker that is gone (cancelled, reset, or another category now open) is dropped
      if (!aliveRef.current || epoch !== epochRef.current) return;
      setPicker((p) => {
        if (!p?.category || p.category.name !== name) return p;
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
      moreRef.current = false;
      setMoreBusy(false);
    }
  };
  const cancelPicker = () => {
    epochRef.current += 1; // a page still on the wire for this picker must not land in the next one
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
    clearAdded();
    setPicker(null);
    setFailed(false);
    setWaiting(0);
  };
  /** F05: the miss message goes at the next keystroke in the box. */
  const dismissMessage = () => setMessage("");

  return {
    pendingQty,
    message,
    missCode: miss.code,
    added,
    dismissMessage,
    picker,
    failed,
    waiting,
    submit,
    submitCamera,
    pick,
    choose,
    loadMore,
    moreBusy,
    cancelPicker,
    retry,
    dismissFailure,
    reset,
  };
}
