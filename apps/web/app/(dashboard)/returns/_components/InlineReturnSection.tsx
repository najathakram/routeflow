"use client";

// ─── Inline return capture — the shared one-step UI (#2406, R-1 / SA-1069 section A) ───────────────────
//
// Extracted from RecordInlineReturnDialog (SA-484): one list of what came back, with the credit worked out live under it.
// There is no second step: add a product (it lands at 1 piece), set its quantity, and the credit follows after a short pause.
// Every line has a collapsed options row that shows its defaults in words ("Credit $14.40 · Bought too many · Back to
// stock"); open it to change them, leave it and the default goes. The section has NO opinion on what happens after the
// credit is known — that varies per host. RecordInlineReturnDialog still owns its own order-picker, "success"/"refused"
// screens and the immediate capture call; CreateOrderModal and the order-edit page instead read the latest draft via
// `onStateChange` and fold it into their own order create/update payload at SAVE time (see OrderInlineReturnsSection, the
// thin wrapper both of those hosts mount). No client-side money math: every dollar figure rendered here comes verbatim from
// the quote, and a quote is shown as current only while it is for exactly the lines on screen (useLiveReturnQuote).
import * as React from "react";
import { ChevronDown, ChevronRight } from "lucide-react";
import { Button, Input, Select, useToast } from "@routeflow/ui/web";
import { BarcodeScannerButton } from "@/components/BarcodeScannerButton";
import { useScanCodeHandler } from "../../orders/_components/scan/useScanCodeHandler";
import { DidYouMeanPicker } from "@/components/scan/DidYouMeanPicker";
import { useOrder } from "@/lib/api/orders";
import { returnReasonOptions } from "@/lib/reason-copy";
import { LINE_UNDO_MS } from "@/app/(dashboard)/orders/_components/useCounterLineUndo";
import { useProducts } from "@/lib/api/products";
import { useOptionalAuth } from "@/lib/auth-context";
import type {
  InlineReturnQuoteChunk,
  InlineReturnQuoteResponse,
  ReturnReason,
} from "@routeflow/types";
import {
  ALREADY_RETURNED_DRIVER_NOTE,
  ALREADY_RETURNED_LABEL,
  ALREADY_RETURNED_NOTE,
  applyCoveredToProduct,
  applyReturnScan,
  boxedProductIds,
  canOverrideReturnCredit,
  CREDIT_OVERRIDE_REASON_MAX,
  creditOverrideNote,
  DEFAULT_RETURN_REASON,
  hasAnyQtyEntered,
  isBoxedProduct,
  lineQuoteFacts,
  ALREADY_RETURNED_NOTHING_LEFT_MESSAGE,
  NOTHING_BOUGHT_BEFORE_MESSAGE,
  restocksForReason,
  rulingLineIndex,
  sumChunkTotals,
  type InlineReturnLineDraft,
  type LineQuoteFacts,
} from "@routeflow/returns";
import { unitWords } from "@routeflow/pricing";
import { countNoun } from "@/lib/plural";
import { creditOutcomeLine, type CreditContext } from "./refund-copy";
import { useLiveReturnQuote, type LiveQuoteStatus } from "./useLiveReturnQuote";

// U-3a: returns carry no per-product label yet, so this prints the default words.
const UW = unitWords();

// See RecordInlineReturnDialog's original SA-108 comment: `lineKey` is a section-local
// synthetic row identity (never sent on the wire) so two rows of the same product — a Case
// line and a pack line from a source order, say — can be edited/removed independently.
type SectionLine = InlineReturnLineDraft & { lineKey: string };

/** A-4 (M3): the quote has priced at least one chunk of this product, so its neverSold flag is an answer rather than an absence. */
function quotePricedProduct(facts: LineQuoteFacts): boolean {
  return facts.covered.length + facts.notOnInvoice.length + facts.alreadyReturned.length > 0;
}

function money(n: number): string {
  return n.toLocaleString("en-US", { style: "currency", currency: "USD" });
}

export type InlineReturnQuoteStatus = LiveQuoteStatus;

export interface InlineReturnSectionState {
  lines: InlineReturnLineDraft[];
  /** The quote for exactly these lines, or null: never a quote from lines that have since changed (SA-1069 M4). */
  quote: InlineReturnQuoteResponse | null;
  quoteStatus: InlineReturnQuoteStatus;
  /** "Reason for all items". Always set: it starts on the server's own default. */
  captureReason: ReturnReason;
  /** Why there is no credit to save: a half-typed credit price (M14), or the sentence for a refused or failed quote, else
   *  null. The host shows it when a save is blocked, since the section's own copy can be off screen at the till. */
  problem: string | null;
}

export interface InlineReturnSectionProps {
  customerId: string;
  /** Prefills lines from this order's own line items (mirrors the original dialog's
   *  "opened from an order" hydration) — used by the dialog and the order-edit host. Omit for
   *  a customer with no carrying order yet (CreateOrderModal — the order doesn't exist yet). */
  entryOrderId?: string;
  /** SA-740: the sale this return is from, sent on the quote (REQUIRED for a walk-in; the host
   *  also sends it on the capture). Omit for a named customer, whose return may spill across orders. */
  sourceOrderId?: string;
  /** SA-1060 A-4: the order being EDITED, sent on the quote so it prices what the edit's save will see (the order edit's Returns
   *  section passes it; New order, the counter and the Returns dialog never do). */
  editingOrderId?: string;
  /** Bumping this value resets every field and re-seeds from `entryOrderId` — mirrors the
   *  original dialog's "fresh attempt every time it opens" effect. */
  resetToken?: string | number;
  /** False = the host is not ready to price a return (the dialog needs an order picked first): nothing is asked. */
  getQuoteEnabled?: boolean;
  /** Said under the list while `getQuoteEnabled` is false and a quantity is entered. */
  waitingFor?: string;
  onStateChange?: (state: InlineReturnSectionState) => void;
  /** Rendered in the action row under the summary, always (e.g. the dialog's own Cancel button). */
  renderActions?: () => React.ReactNode;
  /** POS-4b: after a capture is saved every input, the add box and the options are disabled (its lines can no longer change). */
  locked?: boolean;
  /** Rendered in the action row once the quote is current (e.g. the dialog's confirm/capture button). */
  renderQuoteActions?: (quote: InlineReturnQuoteResponse) => React.ReactNode;
  /** POS-4b: rendered above the action row once the quote is current (the dialog's refund-vs-credit choice). */
  renderQuoteFooter?: (quote: InlineReturnQuoteResponse) => React.ReactNode;
  /** POS-4b: a re-fetched quote (REFUND_AMOUNT_CHANGED) that replaces the one on screen. */
  quoteOverride?: InlineReturnQuoteResponse | null;
  /** Show only the Total: the host replaced the total with the server's own figure, so the old breakdown would no longer add up. */
  totalOnly?: boolean;
  /** W21b: replaces the default store-credit line under the totals (the dialog sets it when Refund is chosen).
   *  null = no line under the totals (the host shows it with its own choice). */
  quoteNote?: string | null;
  /** SA-959: this return cannot be refunded here. The sentence is the summary's main message, and there is no footer:
   *  there is nothing to confirm. */
  refusal?: string;
  /** Where the credit goes, for the default note under the totals: "thisOrder" on order create/edit (the credit is held for
   *  the carrying order first). Defaults to the neutral "account" line, which promises nothing about which order uses it. */
  creditContext?: CreditContext;
  /** Named in the default credit note ("for Acme Foods"); omitted = "the customer". */
  customerName?: string;
  /** The words of the reason list: the counter says what happened at the register. Defaults to the entry order's. */
  reasonContext?: "counter" | "delivery";
  /** Renders nothing while true, but keeps every hook (and internal lines/quote/reason state)
   *  running — a host that overlays its own screen on top (RecordInlineReturnDialog's
   *  "success"/"refused") sets this instead of unmounting, so a "Back" resumes with the SAME
   *  draft the operator already typed/fetched, and so its own same-named actions (e.g. "Back")
   *  never collide with this section's DOM while it is hidden. */
  hidden?: boolean;
}

/** A line the operator chose "Return only what was bought" for: what its rows held before, so choosing the other option
 *  (or typing the number back) puts them back, and the pieces it was set to, so a different typed number ends the choice. */
type Trim = { rows: { lineKey: string; boxes: string; pieces: string }[]; applied: string };

export function InlineReturnSection({
  customerId,
  entryOrderId,
  sourceOrderId,
  editingOrderId,
  resetToken,
  getQuoteEnabled = true,
  waitingFor,
  onStateChange,
  renderActions,
  renderQuoteActions,
  renderQuoteFooter,
  locked = false,
  quoteOverride,
  totalOnly = false,
  quoteNote,
  refusal,
  creditContext = "account",
  customerName,
  reasonContext,
  hidden = false,
}: InlineReturnSectionProps) {
  const { data: entryOrder } = useOrder(entryOrderId ?? "");
  // R7b 3.1: a counter sale's reasons read in register words (same enum values)
  const context = reasonContext ?? (entryOrder?.counterSale ? "counter" : "delivery");
  const REASON_OPTIONS = React.useMemo(() => returnReasonOptions(context), [context]);

  const [lines, setLines] = React.useState<SectionLine[]>([]);
  const [captureReason, setCaptureReason] = React.useState<ReturnReason>(DEFAULT_RETURN_REASON);
  const [trimmed, setTrimmed] = React.useState<Record<string, Trim>>({});
  const [productSearch, setProductSearch] = React.useState("");
  const [focusLine, setFocusLine] = React.useState<string | null>(null);
  const rootRef = React.useRef<HTMLDivElement>(null);

  // #2695 (SA-557): staff only — the server refuses the fields from anyone else with a 400.
  const canOverrideCredit = canOverrideReturnCredit(useOptionalAuth()?.user?.role);

  const live = useLiveReturnQuote({
    lines,
    customerId,
    sourceOrderId,
    editingOrderId,
    enabled: getQuoteEnabled && !locked,
  });
  const quote = quoteOverride ?? live.quote;
  const quoteStatus: InlineReturnQuoteStatus = quoteOverride ? "current" : live.status;
  // While the next quote is pending the last one stays on screen DIMMED (details only): the credit figure and the host's
  // actions wait for a current one.
  const problem =
    !quoteOverride && (live.status === "refused" || live.status === "failed") && live.message
      ? live.message
      : null;
  const detailQuote = quote ?? (quoteStatus === "pending" ? live.lastQuote : null);

  const { data: productResults } = useProducts(
    { search: productSearch, limit: 10 },
    { enabled: productSearch.trim().length > 1 },
  );

  // Fresh attempt whenever resetToken (or the entry order) changes.
  React.useEffect(() => {
    setCaptureReason(DEFAULT_RETURN_REASON);
    setTrimmed({});
    setProductSearch("");
    if (entryOrder?.lineItems) {
      setLines(
        entryOrder.lineItems
          .filter((li) => !!li.productId && li.status !== "CANCELLED")
          .map((li) => ({
            lineKey: crypto.randomUUID(),
            productId: li.productId as string,
            productName: li.product?.name ?? li.name ?? "Unlisted item",
            unit: li.product?.unit,
            unitsPerBox: li.unitsPerBox ?? li.product?.unitsPerBox ?? null,
            qtySold: li.qty,
            // nothing sold is presumed returned: seeded rows stay blank until the operator counts them
            boxes: "",
            pieces: "",
            reason: "" as ReturnReason | "",
            note: "",
          })),
      );
    } else {
      setLines([]);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [resetToken, entryOrderId, entryOrder?.id]);

  React.useEffect(() => {
    onStateChange?.({ lines, quote, quoteStatus, captureReason, problem });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [lines, quote, quoteStatus, captureReason, problem]);

  function updateLine(lineKey: string, patch: Partial<InlineReturnLineDraft>) {
    setLines((prev) => prev.map((l) => (l.lineKey === lineKey ? { ...l, ...patch } : l)));
  }

  // R7b 3.1: Remove keeps the line for LINE_UNDO_MS in ONE slot (a newer removal makes the older one final), shown in
  // the line's own place as "Removed {name} · Undo"
  const [removed, setRemoved] = React.useState<{ line: SectionLine; index: number } | null>(null);
  const removedTimer = React.useRef<number | null>(null);
  const clearRemoved = React.useCallback(() => {
    if (removedTimer.current !== null) window.clearTimeout(removedTimer.current);
    removedTimer.current = null;
    setRemoved(null);
  }, []);
  React.useEffect(
    () => () => {
      if (removedTimer.current !== null) window.clearTimeout(removedTimer.current);
    },
    [],
  );
  // a fresh attempt (reset or another order) never offers to undo into the old one
  React.useEffect(() => {
    clearRemoved();
  }, [resetToken, entryOrderId, entryOrder?.id, clearRemoved]);

  function removeLine(lineKey: string) {
    if (locked) return;
    const index = lines.findIndex((l) => l.lineKey === lineKey);
    if (index < 0) return;
    const line = lines[index];
    setLines((prev) => prev.filter((l) => l.lineKey !== lineKey));
    if (removedTimer.current !== null) window.clearTimeout(removedTimer.current);
    setRemoved({ line, index });
    removedTimer.current = window.setTimeout(clearRemoved, LINE_UNDO_MS);
  }

  function undoRemove() {
    if (!removed || locked) return;
    const { line, index } = removed;
    setLines((prev) => {
      const at = Math.min(index, prev.length);
      return [...prev.slice(0, at), line, ...prev.slice(at)];
    });
    clearRemoved();
  }

  // #2694 + R-1 M2: a scan, a search pick and "Did you mean" all add through ONE rule — a new product becomes a line at 1
  // piece, a repeat adds a piece to its line (applyReturnScan). A search pick also puts the cursor in that line's Qty with
  // the 1 selected, so typing replaces it; a scan leaves the focus alone (the scanner keeps typing into the add box).
  // Returns never create a product, so an unknown code is a message.
  const { toast } = useToast();
  const productSearchRef = React.useRef<HTMLInputElement>(null);
  const linesRef = React.useRef(lines);
  linesRef.current = lines;
  // B1219: a single fuzzy match is offered here ("Did you mean ...?"), never added unasked.
  const [scanMatches, setScanMatches] = React.useState<any[]>([]);
  const addProduct = (product: any, opts: { focusQty: boolean }) => {
    // M10: once the return is saved the lines are the saved return's — a scan or a pick adds nothing
    if (locked) return { created: false };
    const existing = linesRef.current[rulingLineIndex(linesRef.current, product.id)];
    const lineKey = existing?.lineKey ?? crypto.randomUUID();
    // the product sits in the Undo slot: adding it again replaces that, so it is never in the list twice
    if (removed?.line.productId === product.id) clearRemoved();
    setLines(
      (prev) => applyReturnScan<SectionLine>(prev, product, (base) => ({ ...base, lineKey })).lines,
    );
    setProductSearch("");
    if (opts.focusQty) setFocusLine(lineKey);
    return { created: !existing };
  };
  const scanHandlerRef = useScanCodeHandler({
    addLineItem: (product) => addProduct(product, { focusQty: false }),
    onSuggestion: (matches) => setScanMatches(matches),
    onUnknownCode: (code) => toast({ variant: "error", title: `No product with barcode ${code}` }),
    toast,
  });
  function handleProductSearchEnter() {
    const code = productSearch.trim();
    if (!code) return;
    setProductSearch("");
    void scanHandlerRef.current(code);
  }
  React.useEffect(() => {
    if (!focusLine) return;
    const input = rootRef.current?.querySelector<HTMLInputElement>(
      `[data-qty-line="${focusLine}"] input`,
    );
    if (input) {
      input.focus();
      input.select();
    }
    setFocusLine(null);
  }, [focusLine, lines]);

  // M8: "Return only what was bought" for ONE line. The live quote does the rest.
  function chooseOnlyBought(productId: string) {
    if (!quote || locked) return;
    const next = applyCoveredToProduct(lines, quote, productId);
    if (next === lines) return;
    const rows = lines
      .filter((l) => l.productId === productId)
      .map((l) => ({ lineKey: l.lineKey, boxes: l.boxes, pieces: l.pieces }));
    const applied = next[rulingLineIndex(next, productId)]?.pieces ?? "";
    setTrimmed((t) => ({ ...t, [productId]: { rows, applied } }));
    setLines(next);
  }
  function chooseCurrentPrice(productId: string) {
    const trim = trimmed[productId];
    if (!trim || locked) return;
    setLines((prev) =>
      prev.map((l) => {
        const before = trim.rows.find((r) => r.lineKey === l.lineKey);
        return before ? { ...l, boxes: before.boxes, pieces: before.pieces } : l;
      }),
    );
    setTrimmed(({ [productId]: _gone, ...rest }) => rest);
  }
  const onlyBoughtActive = (productId: string) => {
    const trim = trimmed[productId];
    const ruling = lines[rulingLineIndex(lines, productId)];
    return !!trim && !!ruling && ruling.boxes === "0" && ruling.pieces === trim.applied;
  };

  const boxedIds = boxedProductIds(lines);
  const flaggedIds = new Set<string>(
    detailQuote ? detailQuote.chunks.filter((c) => c.alreadyReturned).map((c) => c.productId) : [],
  );
  const pending = quoteStatus === "pending";
  const current = quoteStatus === "current" && !!quote;

  if (hidden) return null;

  const undoRow = removed ? (
    <div
      role="status"
      className="flex items-center justify-between gap-2 rounded-lg border border-dashed border-surface-border bg-navy/5 p-3 text-sm text-navy"
      data-testid="return-line-undo"
    >
      <span className="min-w-0 break-words">Removed {removed.line.productName}</span>
      <button
        type="button"
        className="min-h-11 shrink-0 px-2 text-sm font-medium text-brand-600 hover:underline disabled:cursor-not-allowed disabled:opacity-50"
        onClick={undoRemove}
        disabled={locked}
      >
        Undo
      </button>
    </div>
  ) : null;

  const reasonLabel = (reason: ReturnReason | "") =>
    REASON_OPTIONS.find((o) => o.value === (reason || captureReason))?.label ?? "";

  return (
    <div ref={rootRef} className="space-y-4">
      <div>
        <h4 className="mb-2 text-sm font-semibold text-navy">What came back</h4>
        <div className="space-y-3">
          {lines.length === 0 && (
            <p className="text-sm text-navy/70">No products yet — search below to add one.</p>
          )}
          {lines.map((line, lineIndex) => {
            const firstIndex = lines.findIndex((l) => l.productId === line.productId);
            // buildCaptureRequest drops rows with no quantity, merges the rest of one product and keeps the first merged row's
            // reason, so that row's reason is what the server applies (and the stock outcome that follows) to the whole product
            const rulingIndex = rulingLineIndex(lines, line.productId);
            const ruling = lines[rulingIndex];
            // the product's quote facts, the credit and the already-returned reason all sit on the ruling row too
            const isRuling = lineIndex === rulingIndex;
            const productFacts = detailQuote ? lineQuoteFacts(detailQuote, line.productId) : null;
            const facts = isRuling ? productFacts : null;
            return (
              <React.Fragment key={line.lineKey}>
                {removed && removed.index === lineIndex ? undoRow : null}
                <ReturnLine
                  line={line}
                  boxed={isBoxedProduct(line)}
                  boxedForNote={boxedIds.has(line.productId)}
                  facts={facts}
                  credit={current && facts ? facts.total : null}
                  stale={!quote && !!detailQuote}
                  locked={locked}
                  reasonOptions={REASON_OPTIONS}
                  reasonLabel={reasonLabel(ruling.reason)}
                  // SA-1060 PR-2: goods this customer was never sold are not added to stock, whatever the reason (the quote says so).
                  // A-4 (M3): with no quote to say (not yet asked, refused, failed, or
                  // no chunk for THIS product: no quantity yet, or its quote still pending) a restocking reason claims nothing: null
                  stocks={
                    !restocksForReason(ruling.reason || captureReason)
                      ? false
                      : productFacts && quotePricedProduct(productFacts)
                        ? !productFacts.neverSold
                        : null
                  }
                  followsFirst={lineIndex !== rulingIndex}
                  rulingIsFirst={rulingIndex === firstIndex}
                  firstReason={ruling.reason}
                  canOverrideCredit={canOverrideCredit}
                  needsAlreadyReturnedReason={
                    isRuling &&
                    canOverrideCredit &&
                    flaggedIds.has(line.productId) &&
                    !(line.alreadyReturnedReason ?? "").trim()
                  }
                  onlyBoughtActive={onlyBoughtActive(line.productId)}
                  onlyBoughtAvailable={!!quote}
                  refused={live.status === "refused" && live.refusedProductId === line.productId}
                  onChange={(patch) => updateLine(line.lineKey, patch)}
                  onRemove={() => removeLine(line.lineKey)}
                  onEnterQty={() => productSearchRef.current?.focus()}
                  onOnlyBought={() => chooseOnlyBought(line.productId)}
                  onCurrentPrice={() => chooseCurrentPrice(line.productId)}
                />
              </React.Fragment>
            );
          })}
          {removed && removed.index >= lines.length ? undoRow : null}
        </div>
      </div>

      <div className="relative">
        <div className="flex items-end gap-2">
          <div className="min-w-0 flex-1">
            <Input
              className="max-lg:h-11"
              ref={productSearchRef}
              label="Add another product"
              placeholder="Search or scan a product"
              value={productSearch}
              disabled={locked}
              onChange={(e) => setProductSearch(e.target.value)}
              onKeyDown={(e) => {
                // The scanner button's wedge detector already handled (and preventDefault'd)
                // a scan's Enter — standing down here keeps ONE scan to ONE add (#2704).
                if (e.defaultPrevented) return;
                if (e.key === "Enter") {
                  e.preventDefault();
                  handleProductSearchEnter();
                }
              }}
            />
          </div>
          <BarcodeScannerButton
            inputRef={productSearchRef}
            onScan={(code) => void scanHandlerRef.current(code)}
            onError={(message) => toast({ variant: "error", title: message })}
            className="h-10 min-h-[44px] w-10 min-w-[44px] shrink-0"
            title="Scan barcode"
            disabled={locked}
          />
        </div>
        {scanMatches.length > 0 && (
          <div className="mt-2">
            <DidYouMeanPicker
              matches={scanMatches}
              onConfirm={(product) => {
                setScanMatches([]);
                addProduct(product, { focusQty: true });
              }}
              onCancel={() => setScanMatches([])}
            />
          </div>
        )}
        {!locked && productSearch.trim().length > 1 && (productResults?.data?.length ?? 0) > 0 && (
          <div className="absolute z-10 mt-1 w-full rounded-lg border border-surface-border bg-white shadow-card">
            {productResults!.data.map(
              (p: { id: string; name: string; unit?: string; unitsPerBox?: number | null }) => (
                <button
                  type="button"
                  key={p.id}
                  className="flex w-full items-center justify-between px-3 py-2 text-left text-sm hover:bg-surface-raised max-lg:min-h-11"
                  onClick={() =>
                    addProduct(
                      { id: p.id, name: p.name, unit: p.unit, unitsPerBox: p.unitsPerBox },
                      { focusQty: true },
                    )
                  }
                >
                  {p.name}
                </button>
              ),
            )}
          </div>
        )}
      </div>

      <Select
        className="max-lg:h-11"
        label="Reason for all items"
        value={captureReason}
        disabled={locked}
        onChange={(e) => setCaptureReason(e.target.value as ReturnReason)}
        options={REASON_OPTIONS}
      />

      {!getQuoteEnabled && waitingFor && hasAnyQtyEntered(lines) && (
        <p className="text-sm text-navy/70">{waitingFor}</p>
      )}
      {live.message && (live.status === "refused" || live.status === "failed") && (
        <div className="space-y-2">
          <p
            role={live.messageKind === "server" ? "alert" : undefined}
            className="text-sm text-danger"
          >
            {live.message}
          </p>
          {live.status === "failed" && (
            <Button
              type="button"
              className="max-lg:min-h-11"
              variant="secondary"
              onClick={live.retry}
            >
              Try again
            </Button>
          )}
        </div>
      )}

      {quoteStatus !== "none" &&
        live.status !== "refused" &&
        live.status !== "failed" &&
        (detailQuote || pending) && (
          <div
            data-testid="return-summary"
            aria-busy={pending}
            className={`rounded-lg bg-surface-raised p-3 ${pending ? "opacity-60" : ""}`}
          >
            {detailQuote ? (
              <>
                {!totalOnly && (
                  <div className="flex justify-between text-sm text-navy">
                    <span>Subtotal</span>
                    <span>{money(detailQuote.subtotal)}</span>
                  </div>
                )}
                {!totalOnly && (
                  <div className="flex justify-between text-sm text-navy">
                    <span>Tax</span>
                    <span>{money(detailQuote.taxAmount)}</span>
                  </div>
                )}
                {!totalOnly && detailQuote.categoryTax > 0 && (
                  <div className="flex justify-between text-sm text-navy">
                    <span>Category levy</span>
                    <span>{money(detailQuote.categoryTax)}</span>
                  </div>
                )}
                <div className="mt-1 flex justify-between border-t border-surface-border pt-1 text-sm font-semibold text-navy">
                  <span>Total</span>
                  <span>{money(detailQuote.total)}</span>
                </div>
                {current && quoteNote !== null && !refusal && (
                  <p className="mt-2 text-xs text-navy/70">
                    {quoteNote ??
                      creditOutcomeLine(money(detailQuote.total), creditContext, customerName)}
                  </p>
                )}
              </>
            ) : (
              <p role="status" className="text-sm text-navy/70">
                Working out the return credit…
              </p>
            )}
          </div>
        )}

      {current && refusal && (
        <p
          role="status"
          className="rounded-lg border border-amber-300 bg-amber-50 p-3 text-sm font-medium text-navy"
        >
          {refusal}
        </p>
      )}
      {current && !refusal && quote && renderQuoteFooter?.(quote)}
      <div className="flex flex-wrap justify-end gap-2">
        {renderActions?.()}
        {current && quote && renderQuoteActions?.(quote)}
      </div>
    </div>
  );
}

/** One return line: name and counts, Qty, and the collapsed options row that shows the line's defaults in words. */
function ReturnLine({
  line,
  boxed,
  boxedForNote,
  facts,
  credit,
  stale,
  locked,
  reasonOptions,
  reasonLabel,
  stocks,
  followsFirst,
  rulingIsFirst,
  firstReason,
  canOverrideCredit,
  needsAlreadyReturnedReason,
  onlyBoughtActive,
  onlyBoughtAvailable,
  refused,
  onChange,
  onRemove,
  onEnterQty,
  onOnlyBought,
  onCurrentPrice,
}: {
  line: SectionLine;
  boxed: boolean;
  boxedForNote: boolean;
  facts: LineQuoteFacts | null;
  /** The line's credit from a CURRENT quote, else null. */
  credit: number | null;
  /** The details come from the last quote while the next is pending. */
  stale: boolean;
  locked: boolean;
  reasonOptions: Array<{ value: ReturnReason; label: string }>;
  reasonLabel: string;
  /** true: back to stock; false: not added; null: not known yet (no quote has said whether it was ever sold). */
  stocks: boolean | null;
  /** A row of a product that is not the one whose reason rules (the first row with a quantity): it cannot take its own. */
  followsFirst: boolean;
  /** the ruling row is the product's first row, so the label can say "the first row" */
  rulingIsFirst: boolean;
  firstReason: ReturnReason | "";
  canOverrideCredit: boolean;
  needsAlreadyReturnedReason: boolean;
  onlyBoughtActive: boolean;
  onlyBoughtAvailable: boolean;
  refused: boolean;
  onChange: (patch: Partial<InlineReturnLineDraft>) => void;
  onRemove: () => void;
  onEnterQty: () => void;
  onOnlyBought: () => void;
  onCurrentPrice: () => void;
}) {
  const [userOpen, setUserOpen] = React.useState(false);
  const panelId = React.useId();
  const hasValue =
    (!!line.reason && !followsFirst) ||
    !!line.note ||
    !!line.creditUnitPrice ||
    !!line.overrideReason ||
    !!(line.alreadyReturnedReason ?? "").trim();
  // M9: a typed note or price is never out of sight, and a decision that is not optional opens by itself
  const forced = hasValue || needsAlreadyReturnedReason;
  const open = userOpen || forced;

  const hasExcess = !!facts && facts.notOnInvoicePieces > 0;
  const hasAlreadyReturned = !!facts && facts.alreadyReturnedPieces > 0;
  const coveredPieces = facts ? facts.covered.reduce((s, c) => s + c.pieces, 0) : 0;
  const showExcessChoice = hasExcess || hasAlreadyReturned || onlyBoughtActive;
  const onlyPossible = onlyBoughtAvailable && (onlyBoughtActive || coveredPieces > 0);

  const summaryWords = [
    credit !== null && facts && facts.total > 0 ? `Credit ${money(facts.total)}` : null,
    reasonLabel,
    stocks === null ? null : stocks ? "Back to stock" : "Not added to stock",
  ].filter(Boolean);

  const flagWords = [
    hasAlreadyReturned ? ALREADY_RETURNED_LABEL : null,
    hasExcess
      ? `${facts!.notOnInvoicePieces} not on any invoice · ${
          onlyBoughtActive ? "Return only what was bought" : "Credit at current price"
        }`
      : onlyBoughtActive
        ? "Returning only what was bought"
        : null,
  ].filter(Boolean);

  const excessChunks = facts ? [...facts.notOnInvoice, ...facts.alreadyReturned] : [];

  return (
    <div
      data-testid={`return-line-${line.productId}`}
      className={`rounded-lg border p-3 ${refused ? "border-danger" : "border-surface-border"}`}
    >
      <div className="flex items-center justify-between gap-2">
        <div className="min-w-0">
          <p className="text-sm font-medium text-navy">{line.productName}</p>
          {typeof line.qtySold === "number" && (
            <p className="text-xs text-navy/70">
              {line.qtySold}
              {line.unit && line.unit !== "each" ? ` ${line.unit}` : ""} sold
              {line.qtyAlreadyReturned ? ` · Returned ${line.qtyAlreadyReturned}` : ""}
            </p>
          )}
        </div>
        <button
          type="button"
          className="text-xs text-navy/50 hover:text-danger disabled:cursor-not-allowed disabled:opacity-50 max-lg:min-h-11 max-lg:min-w-11"
          disabled={locked}
          onClick={onRemove}
        >
          Remove
        </button>
      </div>
      <div className="mt-2 grid grid-cols-2 gap-2 sm:grid-cols-4">
        {boxed && (
          <Input
            className="max-lg:h-11"
            label={UW.pack.other}
            type="number"
            min={0}
            inputMode="numeric"
            enterKeyHint="done"
            disabled={locked}
            value={line.boxes}
            onChange={(e) => onChange({ boxes: e.target.value })}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                onEnterQty();
              }
            }}
          />
        )}
        <div data-qty-line={line.lineKey}>
          <Input
            className="max-lg:h-11"
            label={UW.base.other}
            type="number"
            min={0}
            inputMode="numeric"
            enterKeyHint="done"
            disabled={locked}
            aria-invalid={refused}
            value={line.pieces}
            onChange={(e) => onChange({ pieces: e.target.value })}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                onEnterQty();
              }
            }}
          />
        </div>
      </div>

      {flagWords.length > 0 && (
        <p
          data-testid={`return-line-flag-${line.productId}`}
          className={`mt-2 rounded border border-amber-300 bg-amber-50 px-2 py-1 text-xs font-medium text-navy ${stale ? "opacity-60" : ""}`}
        >
          {flagWords.join(" · ")}
        </p>
      )}

      <button
        type="button"
        className="mt-2 flex min-h-11 w-full items-center justify-between gap-2 text-left text-sm text-navy/70 hover:text-navy aria-disabled:cursor-not-allowed"
        aria-expanded={open}
        aria-controls={panelId}
        // forced open: the toggle does nothing but stays a button, so the summary it holds keeps its colour and its place in the
        // focus order
        aria-disabled={forced}
        title={forced ? "Clear these fields to hide them" : undefined}
        onClick={() => {
          if (!forced) setUserOpen((v) => !v);
        }}
      >
        <span data-testid={`return-line-summary-${line.productId}`} className="min-w-0">
          <span className="sr-only">Options for {line.productName}: </span>
          {summaryWords.join(" · ")}
        </span>
        {open ? (
          <ChevronDown className="h-4 w-4 shrink-0" aria-hidden />
        ) : (
          <ChevronRight className="h-4 w-4 shrink-0" aria-hidden />
        )}
      </button>
      <div id={panelId} hidden={!open} className="space-y-3">
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
          <Select
            className="max-lg:h-11"
            label={
              followsFirst
                ? rulingIsFirst
                  ? "Reason (same as the first row)"
                  : "Reason (same as the first row with a quantity)"
                : "Reason (optional)"
            }
            value={followsFirst ? firstReason : line.reason}
            disabled={locked || followsFirst}
            onChange={(e) => onChange({ reason: e.target.value as ReturnReason | "" })}
            options={[{ value: "", label: "Use default" }, ...reasonOptions]}
          />
          <Input
            className="max-lg:h-11"
            label="Note (optional)"
            disabled={locked}
            value={line.note}
            onChange={(e) => onChange({ note: e.target.value })}
          />
        </div>
        {canOverrideCredit && (
          <div className="grid grid-cols-1 gap-2 sm:grid-cols-[10rem_1fr]">
            <Input
              className="max-lg:h-11"
              label={boxedForNote ? `Credit price per ${UW.pack.lower}` : "Credit price"}
              type="text"
              inputMode="decimal"
              placeholder="Quoted price"
              disabled={locked}
              value={line.creditUnitPrice ?? ""}
              onChange={(e) => onChange({ creditUnitPrice: e.target.value })}
            />
            {(line.creditUnitPrice ?? "").trim() !== "" && (
              <Input
                className="max-lg:h-11"
                label="Why the lower price?"
                maxLength={CREDIT_OVERRIDE_REASON_MAX}
                disabled={locked}
                value={line.overrideReason ?? ""}
                onChange={(e) => onChange({ overrideReason: e.target.value })}
              />
            )}
          </div>
        )}

        {facts && facts.covered.length > 0 && (
          <div className={`space-y-2 ${stale ? "opacity-60" : ""}`}>
            {facts.spansOrders && (
              <p className="text-xs text-navy/70">
                Goods can come from more than one earlier order — each line below shows exactly
                where it was matched.
              </p>
            )}
            {facts.covered.map((chunk, i) => (
              <CoveredChunkRow
                key={`${chunk.sourceOrderId}-${chunk.sourceInvoiceItemId}-${i}`}
                chunk={chunk}
                boxed={boxedForNote}
              />
            ))}
          </div>
        )}

        {facts && excessChunks.length > 0 && (
          <div className={`space-y-1 text-xs text-navy/70 ${stale ? "opacity-60" : ""}`}>
            {hasAlreadyReturned && (
              <p className="text-amber-900">
                {canOverrideCredit ? ALREADY_RETURNED_NOTE : ALREADY_RETURNED_DRIVER_NOTE}
              </p>
            )}
            <p>
              {countNoun(
                facts.notOnInvoicePieces + facts.alreadyReturnedPieces,
                UW.base.lower,
                UW.base.lowerOther,
              )}{" "}
              priced at the customer&apos;s current price.
            </p>
            {facts.neverSold && (
              <p data-testid={`return-line-stock-note-${line.productId}`} className="text-navy">
                Not added to stock
              </p>
            )}
            {excessChunks.map((c, i) => (
              <CreditOverrideNote key={`excess-override-${i}`} chunk={c} boxed={boxedForNote} />
            ))}
            <div className="text-sm text-navy">
              <div className="flex justify-between">
                <span>Net</span>
                <span>{money(sumChunkTotals(excessChunks).subtotal)}</span>
              </div>
              <div className="flex justify-between">
                <span>Tax</span>
                <span>{money(sumChunkTotals(excessChunks).taxAmount)}</span>
              </div>
            </div>
          </div>
        )}

        {needsAlreadyReturnedReason || (hasAlreadyReturned && canOverrideCredit) ? (
          <Input
            className="max-lg:h-11"
            label={`Why credit ${line.productName} again (required)`}
            maxLength={CREDIT_OVERRIDE_REASON_MAX}
            disabled={locked}
            value={line.alreadyReturnedReason ?? ""}
            onChange={(e) => onChange({ alreadyReturnedReason: e.target.value })}
          />
        ) : null}

        {showExcessChoice && (
          <fieldset className="m-0 min-w-0 space-y-2 border-0 p-0">
            <legend className="sr-only">Goods past what was bought: {line.productName}</legend>
            <label className="flex items-center gap-2 text-sm text-navy max-lg:min-h-11">
              <input
                type="radio"
                name={`excess-${line.lineKey}`}
                checked={!onlyBoughtActive}
                disabled={locked}
                onChange={onCurrentPrice}
              />
              Credit at current price
            </label>
            <label
              className={`flex items-center gap-2 text-sm max-lg:min-h-11 ${onlyPossible ? "text-navy" : "text-navy/50"}`}
            >
              <input
                type="radio"
                name={`excess-${line.lineKey}`}
                checked={onlyBoughtActive}
                disabled={locked || !onlyPossible}
                aria-describedby={
                  onlyPossible ? undefined : `excess-nothing-bought-${line.lineKey}`
                }
                onChange={onOnlyBought}
              />
              Return only what was bought
            </label>
            {!onlyPossible && coveredPieces === 0 && (
              <p id={`excess-nothing-bought-${line.lineKey}`} className="text-xs text-navy/70">
                {hasAlreadyReturned
                  ? ALREADY_RETURNED_NOTHING_LEFT_MESSAGE
                  : NOTHING_BOUGHT_BEFORE_MESSAGE}
              </p>
            )}
          </fieldset>
        )}
      </div>
    </div>
  );
}

function CoveredChunkRow({ chunk, boxed }: { chunk: InlineReturnQuoteChunk; boxed: boolean }) {
  const { data: sourceOrder } = useOrder(chunk.sourceOrderId ?? "");
  return (
    <div className="rounded-lg border border-surface-border p-3 text-sm">
      <div className="flex justify-between gap-2">
        <p className="min-w-0 text-xs text-navy/70">
          {sourceOrder ? `From order #${sourceOrder.orderNumber}` : "From an earlier order"}
          {sourceOrder?.orderDate && ` · ${new Date(sourceOrder.orderDate).toLocaleDateString()}`}
        </p>
        <span className="shrink-0 text-navy/70">
          {chunk.pieces} {UW.baseShortFor(chunk.pieces)}
        </span>
      </div>
      <div className="mt-1 flex justify-between text-navy/70">
        <span>Net {money(chunk.subtotal)}</span>
        <span>Tax {money(chunk.taxAmount)}</span>
        {chunk.categoryTax > 0 && <span>Levy {money(chunk.categoryTax)}</span>}
      </div>
      <CreditOverrideNote chunk={chunk} boxed={boxed} />
    </div>
  );
}

/** #2695: a lowered credit, shown as the server priced it — the default it replaced, and why. */
function CreditOverrideNote({ chunk, boxed }: { chunk: InlineReturnQuoteChunk; boxed: boolean }) {
  const note = creditOverrideNote(chunk, money, boxed);
  return note ? <p className="mt-1 text-xs text-navy/70">{note}</p> : null;
}
