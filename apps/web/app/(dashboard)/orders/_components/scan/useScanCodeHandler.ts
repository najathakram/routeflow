"use client";

import * as React from "react";
import type { useToast } from "@routeflow/ui/web";
import {
  levelsForScannedCode,
  isSharedScanCode,
  resolveScanSellLevel,
  scanMatchIsForCode,
  type ScanBarcodeRow,
} from "@routeflow/scanning";
import type { SellLevel } from "@routeflow/pricing";
import { UNITS_LOADING_SCAN_MESSAGE } from "@/lib/default-unit-line";
import { resolveProductByCode, type BarcodeResolveResult } from "@/lib/barcode-resolve";
import { genericToastCopy } from "@/lib/generic-toast-copy";

type ToastFn = ReturnType<typeof useToast>["toast"];

/** What resolving one scanned code came to — what the scan screen cues, highlights and undoes. */
export type ScanResolution =
  | { kind: "added"; product: any; created: boolean }
  /** #2865 (SA-632 H2): a scan of a different level landed on a line still waiting for its default unit. */
  | { kind: "refused"; message: string }
  | { kind: "archived"; name: string }
  /** B1219: one fuzzy match, no exact code - NOT added; the caller offers "Did you mean ...?". */
  | { kind: "suggested"; product: any }
  | { kind: "unknown" }
  | {
      kind: "error";
      message: string;
      /** The lookup failed for CONNECTIVITY (no response at all) — worth retrying, unlike a 4xx/5xx. */
      offline?: boolean;
    };

/**
 * Did this lookup fail because the request never got an answer (no signal, DNS, timeout, browser
 * offline)? An HTTP response — even a 500 — means the server was reached, so it is NOT a signal
 * problem and must not be retried as one.
 */
export function isConnectivityError(err: unknown): boolean {
  const e = err as { response?: unknown; code?: string; message?: string } | null | undefined;
  if (e?.response) return false;
  if (typeof navigator !== "undefined" && navigator.onLine === false) return true;
  return (
    e?.code === "ERR_NETWORK" ||
    e?.code === "ECONNABORTED" ||
    e?.code === "ETIMEDOUT" ||
    e?.message === "Network Error" ||
    /timeout/i.test(e?.message ?? "")
  );
}

/**
 * #2717 M4a-1 (SA-580 R1/R2/R4): the level the scanned `code` carries on `product`. The server's
 * `scanMatch.levels` wins when present (it saw the row that hit); otherwise the levels are worked
 * out from the product's cached `barcodes[]` / legacy columns. The line's mode never matters.
 */
export function scanLevelsForHit(code: string, product: any): SellLevel[] {
  const sm = product?.scanMatch as { code?: string; levels?: SellLevel[] } | undefined;
  // scanMatch is stamped by the FIRST scan and snapshotted on the line's product: trust it only for
  // the code that produced it, else a later unit-code scan inherits the box code's levels.
  return sm?.levels && sm.levels.length > 0 && scanMatchIsForCode(code, sm.code)
    ? sm.levels
    : levelsForScannedCode(code, {
        barcode: product?.barcode,
        sku: product?.sku,
        unitSku: product?.unitSku,
        unitsPerBox: product?.unitsPerBox,
        barcodes: product?.barcodes as ScanBarcodeRow[] | undefined,
      });
}

/** #2784: a code that resolves at BOTH levels is "shared"; only then may the new line start on the default unit. */
export function scanCodeIsShared(code: string, product: any): boolean {
  return isSharedScanCode(scanLevelsForHit(code, product));
}

export function scanLevelForHit(code: string, product: any): SellLevel {
  return resolveScanSellLevel(
    { unitsPerBox: product?.unitsPerBox },
    scanLevelsForHit(code, product),
  );
}

export interface ScanCodeHandlerDeps {
  /**
   * Adds (or increments) a resolved product on the order. May report whether it CREATED the line
   * (vs incremented an existing one) so a caller can undo the scan; a caller that does not care
   * returns nothing and `created` defaults to true.
   */
  addLineItem: (
    product: any,
    level: SellLevel,
    opts?: { startOnDefaultUnit?: boolean },
  ) => { created: boolean; refused?: boolean } | void;
  /** Nothing in the catalog matched — the caller opens create-product with `code` as the SKU. */
  onUnknownCode: (code: string) => void;
  /**
   * B1219: the fuzzy matches (one, or several) to confirm - "Did you mean ...?". Never auto-added.
   * Absent = a toast, nothing added.
   */
  onSuggestion?: (matches: any[], code: string) => void;
  /** B1219: true while another surface (the scan_v2 screen) owns the scan - no picker is raised. */
  suggestionsSuppressed?: () => boolean;
  /**
   * Local fast path: true while the order still holds a line for this product id. A code the handler
   * already resolved to such a product is added again from memory - no lookup, no network wait - so a
   * repeat scan costs nothing and cannot be lost behind a slow request.
   */
  hasLine?: (productId: string) => boolean;
  /** Changes whenever a NEW order starts: the remembered code -> product map never outlives its order. */
  sessionKey?: () => number | string;
  toast: ToastFn;
}

/**
 * The create-order barcode handler, moved verbatim out of CreateOrderModal (LANE-S step 4
 * prefactor — behaviour identical, pinned by CreateOrderModal.test.tsx's scan characterization).
 * It is the seam the redesigned scan screen (LANE-S step 5) reuses so both surfaces resolve a
 * code the same way. It now also RETURNS what happened (`ScanResolution`); the modal's existing
 * fire-and-forget call sites ignore that.
 *
 * Returned as a ref, re-pointed at the latest render's deps every render, so a keydown listener or
 * a camera callback that captured it once never goes stale — the same pattern the modal used
 * inline. Pass `addLineItem` as a thunk if it is declared further down the caller: it is read only
 * when a code is scanned, never at hook-call time.
 *
 * Resolution uses the shared lib ladder (barcode endpoint → candidate-aware scanCode search)
 * instead of the old inline copy, which swallowed 5xx/network errors as "not found" and skipped
 * unitSku on the exact-match check. This surface keeps its historical multi-match behaviour:
 * first row wins (the modal's scan flow has always auto-added; the edit page offers a picker).
 */
export function useScanCodeHandler(deps: ScanCodeHandlerDeps) {
  const handlerRef = React.useRef<
    (code: string, opts?: { quiet?: boolean; background?: boolean }) => Promise<ScanResolution>
  >(async () => ({ kind: "unknown" }));
  // code -> the product it resolved to (only a plain hit; never a suggestion/archived/unknown).
  const seenRef = React.useRef(new Map<string, any>());
  const seenSessionRef = React.useRef<number | string | undefined>(undefined);
  // `quiet` suppresses ONLY the lookup-failure toast: the scan screen shows its own status and
  // retries a queued scan every few seconds, which must not toast on every failed retry.
  handlerRef.current = async (
    code: string,
    opts?: { quiet?: boolean; background?: boolean },
  ): Promise<ScanResolution> => {
    const session = deps.sessionKey?.();
    if (seenSessionRef.current !== session) {
      seenRef.current.clear();
      seenSessionRef.current = session;
    }
    // Local fast path: a code already resolved to a product still on the order needs no lookup.
    const seen = deps.hasLine ? seenRef.current.get(code.trim()) : undefined;
    let result: BarcodeResolveResult | null =
      seen && deps.hasLine?.(String(seen.id)) ? { product: seen, source: "barcode" } : null;
    if (!result) {
      try {
        // Opus item 5: the try/catch covers ONLY the lookup. It used to also wrap `addLineItem`
        // below, so a throw from THAT (nothing to do with connectivity) was caught here and
        // misreported as `offline: true` — which queues the code for a retry that then adds it a
        // SECOND time, on top of whatever the first (throwing) call already committed.
        result = await resolveProductByCode(code);
      } catch (err: any) {
        // Network / 5xx — a transient failure is NOT "product doesn't exist";
        // don't open the create-product modal over it.
        // A failure with no HTTP response is the transient case ("check the connection"); anything the server answered is fixed copy.
        const message = err?.response ? genericToastCopy(err) : "Check the connection and rescan.";
        if (!opts?.quiet) {
          deps.toast({
            variant: "error",
            title: "Couldn't look up the code",
            description: message,
          });
        }
        return { kind: "error", message, offline: isConnectivityError(err) };
      }
    }
    if (result.archived) {
      // F30 / R5: the product exists but is retired — never put it on an
      // order silently, and never fall through to "create a new product"
      // for something the catalog already has.
      const name = result.product?.name || "Item";
      deps.toast({
        variant: "error",
        title: `${name} is archived — reactivate to sell`,
      });
      return { kind: "archived", name };
    }
    if ((result.suggestion || result.ambiguous) && result.product) {
      // B1219: no exact code matched and the fuzzy search found one or more products - a guess, so
      // it is offered, never added. A surface with no picker says so instead of dropping the scan.
      // 2+ fuzzy hits used to add the FIRST row here; they are offered together instead.
      const matches = result.matches?.length ? result.matches : [result.product];
      if (deps.suggestionsSuppressed?.()) {
        // The scan screen owns the scan and reports `suggested` itself; no picker is left behind.
      } else if (deps.onSuggestion) deps.onSuggestion(matches, code);
      else
        deps.toast({
          variant: "error",
          title: `No exact match for ${code}`,
          description: `Closest: ${result.product?.name || "Item"}. Search for it to add it.`,
        });
      return { kind: "suggested", product: result.product };
    }
    if (!result.notFound && result.product) {
      if (deps.hasLine) seenRef.current.set(code.trim(), result.product);
      // addLineItem clears search + refocuses — outside the try above: a throw here is a real
      // bug, never a connectivity failure, and must never be silently queued/re-added.
      const level = scanLevelForHit(code, result.product);
      // #2784: only a SHARED code may start on the default selling unit (box-only / unit-only: the code decides).
      const added = scanCodeIsShared(code, result.product)
        ? deps.addLineItem(result.product, level, { startOnDefaultUnit: true })
        : deps.addLineItem(result.product, level);
      if (added?.refused) return { kind: "refused", message: UNITS_LOADING_SCAN_MESSAGE };
      return { kind: "added", product: result.product, created: added?.created ?? true };
    }
    // Nothing found — let the caller open create-product with the scanned barcode as SKU. Not for a
    // BACKGROUND retry: a queued scan resolving minutes later must not pop a dialog mid-scan (and
    // several would overwrite each other's SKU); the scan screen reports it and the operator can
    // rescan the code when ready to create it.
    if (!opts?.background) deps.onUnknownCode(code);
    return { kind: "unknown" };
  };
  return handlerRef;
}
