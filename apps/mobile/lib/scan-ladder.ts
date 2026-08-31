/**
 * The shared scan ladder used by every sale builder.
 *
 * Both the order builder (`components/NewOrderScreen.tsx`) and the invoice
 * builder (`app/(operator)/(tabs)/invoices/new.tsx`) had their own copy of this
 * three-step resolution, and the order-EDIT screen had a weaker one that could
 * only report a miss. Extracting it means the editors get the same
 * ambiguous-pick and create-on-miss branches instead of a dead end.
 *
 * The ladder itself is pure: the network call, the cart write and the two
 * hand-offs are injected, so it unit-tests in the node Jest env.
 */
import { normalizeScanCode } from "./barcode-normalize";
import { scanUnitKind, looksLikeScanCode, type ScanMatchable } from "./wedge-scan";
import type { BarcodeResolveResult } from "./barcode-resolve";
import type { ScanOutcome } from "./scan-loop";

export interface ScanLadderDeps<T extends ScanMatchable> {
  /**
   * The rows already in memory — the local fast-path candidate set. Pass a
   * GETTER when the handler is memoized, so a re-render's rows are visible;
   * an array is fine when the handler is rebuilt each render (as the builders do).
   */
  products: readonly T[] | (() => readonly T[]);
  /** Put the product in the cart and describe what happened. Screen-owned. */
  accept: (product: T, unitKind: "case" | "piece") => ScanOutcome;
  /**
   * Server fallback (`resolveProductByCode`), injected to keep this testable.
   * MUST forward `signal` to the underlying request: the ladder's deadline
   * works by ABORTING the lookup (see {@link SCAN_RESOLVE_TIMEOUT_MS}), and a
   * resolve that ignores the signal can still settle — and still `accept` —
   * long after the operator was told the scan failed.
   */
  resolve: (code: string, signal?: AbortSignal) => Promise<BarcodeResolveResult<T>>;
  /** Several substring hits — open a picker seeded with the code. */
  onAmbiguous: (code: string) => void;
  /**
   * No match — open the inline create sheet seeded with the code. Omit it when
   * the caller may not create products (drivers): the miss then reports plainly
   * instead of offering a button that leads nowhere.
   */
  onCreate?: (code: string) => void;
}

function resolveProducts<T extends ScanMatchable>(p: ScanLadderDeps<T>["products"]): readonly T[] {
  return typeof p === "function" ? p() : p;
}

/**
 * Caps ONE scan lookup so a slow resolve can't hold the camera's pending
 * buffer (and its `isResolving` indicator) open for api-client's full request
 * timeout — F30 / R2's shortened "looking up…" window.
 *
 * The deadline lives HERE, around the awaited request, and it ABORTS rather
 * than races. A `Promise.race` in the camera would only discard the VALUE: the
 * ladder below would keep running and its `deps.accept` — a real cart write —
 * would land seconds after the operator was told "try again" and re-presented
 * the item, giving qty 2 for one physical scan. Scoped to this call: the
 * signal cancels only the lookup, never api-client's own axios timeout.
 */
export const SCAN_RESOLVE_TIMEOUT_MS = 5000;

/**
 * Build the continuous-scan handler: local rows → server resolve → ambiguous →
 * miss. Every branch STAYS IN SCAN MODE and carries its hand-off on the feedback
 * pill, because closing the scanner on a mis-read is what stranded the operator
 * (the owner's "scanning prompt disappears").
 */
export function makeScanHandler<T extends ScanMatchable>(
  deps: ScanLadderDeps<T>,
): (code: string) => Promise<ScanOutcome> {
  return async function handleBarcodeScanned(code: string): Promise<ScanOutcome> {
    const trimmed = code.trim();
    if (!trimmed) return;

    // 1) Local fast-path over the rows already in memory. Uses the same
    //    candidate set the server does (UPC-E/EAN-13/leading-zero variants), so
    //    a code the server would resolve doesn't cost a round trip.
    const candidates = new Set(normalizeScanCode(trimmed).map((c) => c.toUpperCase()));
    const hit = (v?: string | null) => !!v && candidates.has(v.toUpperCase());
    const local = resolveProducts(deps.products).find(
      (p) =>
        hit(p.barcode) ||
        hit(p.sku) ||
        hit(p.unitSku) ||
        (p.id ?? "").toLowerCase() === trimmed.toLowerCase(),
    );
    if (local) return deps.accept(local, scanUnitKind(trimmed, local));

    // 2) Server fallback: barcode → exact SKU → name/SKU substring → notFound.
    //    Bounded by SCAN_RESOLVE_TIMEOUT_MS — an abort, so a lookup that blows
    //    the deadline is cancelled and can never reach `deps.accept`.
    const controller = new AbortController();
    const deadline = setTimeout(() => controller.abort(), SCAN_RESOLVE_TIMEOUT_MS);
    try {
      const result = await deps.resolve(trimmed, controller.signal);
      if (result.ambiguous) {
        // Deliberately NOT matches[0]: with numeric product names a 12-digit
        // scan substring-matches broadly, so a guess puts the wrong item on the
        // order. The picker stacks over the paused camera, so choosing costs one
        // tap and scanning resumes immediately.
        return {
          feedback: {
            kind: "error",
            text: `${result.matches?.length ?? 0} products match "${trimmed}"`,
            action: { label: "Choose", onPress: () => deps.onAmbiguous(trimmed) },
          },
        };
      }
      if (result.archived && result.product) {
        // F30 / R5: a resolved-but-inactive product is a distinct outcome —
        // never silently added, and never reported as if it doesn't exist.
        const archivedProduct = result.product as { name?: string };
        return {
          feedback: {
            kind: "error",
            text: `${archivedProduct?.name ?? "Item"} is archived — reactivate to sell`,
          },
        };
      }
      if (!result.notFound && result.product?.id) {
        // Classify against the RESOLVED product's own codes — the endpoint
        // resolves either code but doesn't say which one matched.
        return deps.accept(result.product, scanUnitKind(trimmed, result.product));
      }
    } catch (err: any) {
      if (controller.signal.aborted) {
        // Deadline hit: the request was CANCELLED, so nothing was added and
        // re-presenting the item is safe — which is the whole point of
        // aborting instead of abandoning a still-live lookup.
        return { feedback: { kind: "error", text: "Still looking that up — try again." } };
      }
      // Network / 5xx — surface it, so a lookup failure never reads as "this
      // product doesn't exist".
      const msg = err?.response?.data?.message ?? err?.message ?? "Couldn't look up barcode.";
      return { feedback: { kind: "error", text: msg } };
    } finally {
      clearTimeout(deadline);
    }

    // 3) Nothing matched. Stay in scan mode; the pill carries the hand-off.
    const text = `No product for "${trimmed}"`;
    if (deps.onCreate) {
      const create = deps.onCreate;
      return {
        feedback: {
          kind: "error",
          text,
          action: { label: "Create", onPress: () => create(trimmed) },
        },
      };
    }
    return { feedback: { kind: "error", text } };
  };
}

/**
 * Shared post-processing for the wedge-scanner path: a hardware scanner types
 * the code into the SEARCH box and sends Enter. Gated on `looksLikeScanCode` so
 * pressing Enter after typing a product NAME never adds anything.
 *
 * On a miss or an ambiguous hit the sheet IS the next step, so it opens directly
 * — a toast plus a tap is one interaction too many with a scanner in hand. The
 * caller owns the in-flight ref (it is a React ref) and the search field.
 */
export async function runWedgeSubmit(opts: {
  /** Raw search term; trimmed and gated here. */
  term: string;
  scan: (code: string) => Promise<ScanOutcome>;
  clearSearch: () => void;
  showInline: (text: string) => void;
}): Promise<void> {
  const code = opts.term.trim();
  if (!code || !looksLikeScanCode(code)) return;

  const outcome = await opts.scan(code);
  if (!outcome || !outcome.feedback) return;

  if (outcome.feedback.kind === "added") {
    opts.showInline(outcome.feedback.text);
    return;
  }
  if (outcome.feedback.action) {
    opts.clearSearch();
    outcome.feedback.action.onPress();
    return;
  }
  opts.showInline(outcome.feedback.text);
}
