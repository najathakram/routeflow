"use client";

// ─── Inline return capture — the shared "lines" + "quote" UI (#2406) ───────────────────────
//
// Extracted from RecordInlineReturnDialog (SA-484): the product-picker/qty-entry list and the
// resulting quote breakdown, with NO opinion on what happens after a quote is in hand — that
// varies per host. RecordInlineReturnDialog still owns its own order-picker, "success"/"refused"
// screens and the immediate capture call; CreateOrderModal and the order-edit page instead read
// the latest draft via `onStateChange` and fold it into their own order create/update payload at
// SAVE time (see OrderInlineReturnsSection, the thin wrapper both of those hosts mount). No
// client-side money math beyond what the dialog already did with these same
// @routeflow/returns helpers — every dollar figure rendered here comes verbatim from the quote.
import * as React from "react";
import { Button, Input, Select, useToast } from "@routeflow/ui/web";
import { BarcodeScannerButton } from "@/components/BarcodeScannerButton";
import { useScanCodeHandler } from "../../orders/_components/scan/useScanCodeHandler";
import { DidYouMeanPicker } from "@/components/scan/DidYouMeanPicker";
import { useOrder } from "@/lib/api/orders";
import { returnReasonOptions } from "@/lib/reason-copy";
import { LINE_UNDO_MS } from "@/app/(dashboard)/orders/_components/useCounterLineUndo";
import { useProducts } from "@/lib/api/products";
import { useInlineReturnQuote } from "@/lib/api/inline-returns";
import { useOptionalAuth } from "@/lib/auth-context";
import type {
  InlineReturnQuoteChunk,
  InlineReturnQuoteResponse,
  ReturnReason,
} from "@routeflow/types";
import {
  applyCoveredPiecesToLines,
  applyReturnScan,
  boxedProductIds,
  buildQuoteRequest,
  canOverrideReturnCredit,
  canReturnOnlyPurchased,
  CREDIT_OVERRIDE_REASON_MAX,
  creditOverrideNote,
  creditOverrideProblem,
  DEFAULT_EXCESS_OPTION,
  dropExcessAndRequote,
  extractRefusalMessage,
  groupQuoteChunks,
  hasAnyQtyEntered,
  isBoxedProduct,
  NOTHING_BOUGHT_BEFORE_MESSAGE,
  notBoughtBeforeNames,
  sumChunkTotals,
  type ExcessOption,
  type InlineReturnLineDraft,
  ALREADY_RETURNED_DRIVER_NOTE,
  ALREADY_RETURNED_LABEL,
  ALREADY_RETURNED_NOTE,
  alreadyReturnedProductIds,
} from "@routeflow/returns";
import { unitWords } from "@routeflow/pricing";

// U-3a: returns carry no per-product label yet, so this prints the default words.
const UW = unitWords();

// See RecordInlineReturnDialog's original SA-108 comment: `lineKey` is a section-local
// synthetic row identity (never sent on the wire) so two rows of the same product — a Case
// line and a pack line from a source order, say — can be edited/removed independently.
type SectionLine = InlineReturnLineDraft & { lineKey: string };

function money(n: number): string {
  return n.toLocaleString("en-US", { style: "currency", currency: "USD" });
}

export type InlineReturnSectionStep = "lines" | "quote";

export interface InlineReturnSectionState {
  step: InlineReturnSectionStep;
  lines: InlineReturnLineDraft[];
  quote: InlineReturnQuoteResponse | null;
  excessOption: ExcessOption;
  captureReason: ReturnReason | "";
}

export interface InlineReturnSectionProps {
  customerId: string;
  /** Prefills lines from this order's own line items (mirrors the original dialog's
   *  "opened from an order" hydration) — used by the dialog and the order-edit host. Omit for
   *  a customer with no carrying order yet (CreateOrderModal — the order doesn't exist yet). */
  entryOrderId?: string;
  /** SA-740: the sale this return is from, sent on the quote and the excess re-quote (REQUIRED for a walk-in; the host
   *  also sends it on the capture). Omit for a named customer, whose return may spill across orders. */
  sourceOrderId?: string;
  /** Bumping this value resets every field and re-seeds from `entryOrderId` — mirrors the
   *  original dialog's "fresh attempt every time it opens" effect. */
  resetToken?: string | number;
  /** Extra gate on "Get quote" beyond "has any qty entered" (default true) — the dialog uses
   *  this for its own "an order must be picked first" requirement. */
  getQuoteEnabled?: boolean;
  onStateChange?: (state: InlineReturnSectionState) => void;
  /** Rendered next to "Get quote" on the lines step (e.g. the dialog's own Cancel button). */
  renderLinesActions?: () => React.ReactNode;
  /** POS-4b: hide "Back" once a capture is saved (its lines can no longer change). */
  hideBack?: boolean;
  /** Rendered next to "Back" on the quote step (e.g. the dialog's confirm/capture button). */
  renderQuoteActions?: (quote: InlineReturnQuoteResponse) => React.ReactNode;
  /** POS-4b: rendered above the quote step's action row (the dialog's refund-vs-credit choice). */
  renderQuoteFooter?: (quote: InlineReturnQuoteResponse) => React.ReactNode;
  /** POS-4b: a re-fetched quote (REFUND_AMOUNT_CHANGED) that replaces the one on screen. */
  quoteOverride?: InlineReturnQuoteResponse | null;
  /** Show only the Total: the host replaced the total with the server's own figure, so the old breakdown would no longer add up. */
  totalOnly?: boolean;
  /** W21b: replaces the default "issued as credit note" line under the totals (the dialog sets it when Refund is chosen). */
  quoteNote?: string;
  /** Called (in addition to the section's own inline error) when the Step-1 quote or the
   *  excess re-quote is refused — the dialog uses this to switch to its full "refused" screen. */
  onQuoteRefused?: (message: string) => void;
  /** Renders nothing while true, but keeps every hook (and internal lines/quote/reason state)
   *  running — a host that overlays its own screen on top (RecordInlineReturnDialog's
   *  "success"/"refused") sets this instead of unmounting, so a "Back" resumes with the SAME
   *  draft the operator already typed/fetched, and so its own same-named actions (e.g. "Back")
   *  never collide with this section's DOM while it is hidden. */
  hidden?: boolean;
  /** Id of the host's "Choose a reason to continue" hint: the quote step's Reason select points at it while no reason is chosen. */
  reasonHintId?: string;
}

export function InlineReturnSection({
  customerId,
  entryOrderId,
  sourceOrderId,
  resetToken,
  getQuoteEnabled = true,
  onStateChange,
  renderLinesActions,
  renderQuoteActions,
  renderQuoteFooter,
  hideBack,
  quoteOverride,
  totalOnly = false,
  quoteNote,
  onQuoteRefused,
  hidden = false,
  reasonHintId,
}: InlineReturnSectionProps) {
  const { data: entryOrder } = useOrder(entryOrderId ?? "");
  // R7b 3.1: a counter sale's reasons read in register words (same enum values)
  const REASON_OPTIONS = React.useMemo(
    () => returnReasonOptions(entryOrder?.counterSale ? "counter" : "delivery"),
    [entryOrder?.counterSale],
  );

  const [step, setStep] = React.useState<InlineReturnSectionStep>("lines");
  const [lines, setLines] = React.useState<SectionLine[]>([]);
  const [captureReason, setCaptureReason] = React.useState<ReturnReason | "">("");
  const [quote, setQuote] = React.useState<InlineReturnQuoteResponse | null>(null);
  const [excessOption, setExcessOption] = React.useState<ExcessOption>(DEFAULT_EXCESS_OPTION);
  const [quoteError, setQuoteError] = React.useState("");
  const [productSearch, setProductSearch] = React.useState("");

  const quoteMutation = useInlineReturnQuote();
  React.useEffect(() => {
    if (quoteOverride) setQuote(quoteOverride);
  }, [quoteOverride]);
  // #2695 (SA-557): staff only — the server refuses the fields from anyone else with a 400.
  const canOverrideCredit = canOverrideReturnCredit(useOptionalAuth()?.user?.role);

  const { data: productResults } = useProducts(
    { search: productSearch, limit: 10 },
    { enabled: productSearch.trim().length > 1 },
  );

  // Fresh attempt whenever resetToken (or the entry order) changes.
  React.useEffect(() => {
    setStep("lines");
    setCaptureReason("");
    setQuote(null);
    setExcessOption(DEFAULT_EXCESS_OPTION);
    setQuoteError("");
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
    onStateChange?.({ step, lines, quote, excessOption, captureReason });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [step, lines, quote, excessOption, captureReason]);

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
    const index = lines.findIndex((l) => l.lineKey === lineKey);
    if (index < 0) return;
    const line = lines[index];
    setLines((prev) => prev.filter((l) => l.lineKey !== lineKey));
    if (removedTimer.current !== null) window.clearTimeout(removedTimer.current);
    setRemoved({ line, index });
    removedTimer.current = window.setTimeout(clearRemoved, LINE_UNDO_MS);
  }

  function undoRemove() {
    if (!removed) return;
    const { line, index } = removed;
    setLines((prev) => {
      const at = Math.min(index, prev.length);
      return [...prev.slice(0, at), line, ...prev.slice(at)];
    });
    clearRemoved();
  }

  function addProduct(product: {
    id: string;
    name: string;
    unit?: string;
    unitsPerBox?: number | null;
  }) {
    if (lines.some((l) => l.productId === product.id)) return;
    setLines((prev) => [
      ...prev,
      {
        lineKey: crypto.randomUUID(),
        productId: product.id,
        productName: product.name,
        unit: product.unit,
        unitsPerBox: product.unitsPerBox ?? null,
        boxes: "",
        pieces: "",
        reason: "",
        note: "",
      },
    ]);
    setProductSearch("");
  }

  // #2694: scan into "What came back" with the order picker's scanner — the shared
  // BarcodeScannerButton (camera + USB wedge) and the order modal's resolve ladder. A scan adds the
  // product with 1 piece; a repeat scan adds a piece (applyReturnScan). Returns never create a
  // product, so an unknown code is a message.
  const { toast } = useToast();
  const productSearchRef = React.useRef<HTMLInputElement>(null);
  const linesRef = React.useRef(lines);
  linesRef.current = lines;
  // B1219: a single fuzzy match is offered here ("Did you mean ...?"), never added unasked.
  const [scanMatches, setScanMatches] = React.useState<any[]>([]);
  const addScanned = (product: any) => {
    const created = !linesRef.current.some((l) => l.productId === product.id);
    setLines(
      (prev) =>
        applyReturnScan<SectionLine>(prev, product, (base) => ({
          ...base,
          lineKey: crypto.randomUUID(),
        })).lines,
    );
    setProductSearch("");
    return { created };
  };
  const scanHandlerRef = useScanCodeHandler({
    addLineItem: (product) => addScanned(product),
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

  function handleGetQuote() {
    setQuoteError("");
    quoteMutation.mutate(buildQuoteRequest(customerId, lines, undefined, sourceOrderId), {
      onSuccess: (data) => {
        setQuote(data);
        // A new quote from the lines step credits its excess at current price by default —
        // only THIS path resets it; the re-quote a "return only what was purchased" pick
        // itself triggers (handleExcessOptionChange) must keep the pick (#2097).
        setExcessOption(DEFAULT_EXCESS_OPTION);
        setStep("quote");
      },
      onError: (err) => {
        // A failed lines-step quote must not leave the OLD quote behind.
        setQuote(null);
        const message = extractRefusalMessage(err);
        setQuoteError(message);
        onQuoteRefused?.(message);
      },
    });
  }

  function handleExcessOptionChange(option: ExcessOption) {
    // #2693: with nothing matched to an invoice, option 3's re-quote would be EMPTY (the API's
    // raw ArrayMinSize refusal); the option is disabled and never sent.
    if (option === "RETURN_ONLY_PURCHASED" && quote && !canReturnOnlyPurchased(quote)) return;
    const previousOption = excessOption;
    setExcessOption(option);
    if (option !== "RETURN_ONLY_PURCHASED" || !quote) return;
    quoteMutation.mutate(dropExcessAndRequote(customerId, quote, undefined, lines, sourceOrderId), {
      onSuccess: (data) => {
        setQuote(data);
        // Cast is safe: applyCoveredPiecesToLines spreads each input line into its output, so a
        // SectionLine's lineKey survives at runtime even though the shared package's own return
        // type only promises InlineReturnLineDraft.
        setLines((prev) => applyCoveredPiecesToLines(prev, data) as SectionLine[]);
      },
      onError: (err) => {
        // The pick is set BEFORE its re-quote; a failed re-quote must put it back — the quote
        // on screen is still the OLD one with the excess in it.
        setExcessOption(previousOption);
        const message = extractRefusalMessage(err);
        setQuoteError(message);
        onQuoteRefused?.(message);
      },
    });
  }

  const { covered, excess } = quote
    ? groupQuoteChunks(quote)
    : { covered: [] as InlineReturnQuoteChunk[], excess: [] as InlineReturnQuoteChunk[] };
  const excessTotals = sumChunkTotals(excess);
  // B961 / SA-071c: an over-return chunk of goods the customer already returned or was credited for is labelled as such (not
  // "Not on any invoice"); staff must type a reason per product, a driver's capture is held for the office.
  const flaggedIds = quote ? alreadyReturnedProductIds(quote) : new Set<string>();
  const anyAlreadyReturned = flaggedIds.size > 0;
  const allExcessAlreadyReturned = excess.length > 0 && excess.every((c) => c.alreadyReturned);
  const onlyBoughtPossible = quote ? canReturnOnlyPurchased(quote) : false;
  const notBoughtBefore = quote && onlyBoughtPossible ? notBoughtBeforeNames(quote, lines) : [];
  const boxedIds = boxedProductIds(lines);
  const overrideProblem = creditOverrideProblem(lines);
  const canGetQuote = hasAnyQtyEntered(lines) && getQuoteEnabled && overrideProblem === null;

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
        className="min-h-11 shrink-0 px-2 text-sm font-medium text-brand-600 hover:underline"
        onClick={undoRemove}
      >
        Undo
      </button>
    </div>
  ) : null;

  return (
    <div className="space-y-4">
      {step === "lines" && (
        <div className="space-y-4">
          <div>
            <h4 className="mb-2 text-sm font-semibold text-navy">What came back</h4>
            <div className="space-y-3">
              {lines.length === 0 && (
                <p className="text-sm text-navy/70">No products yet — search below to add one.</p>
              )}
              {lines.map((line, lineIndex) => {
                const boxed = isBoxedProduct(line);
                return (
                  <React.Fragment key={line.lineKey}>
                    {removed && removed.index === lineIndex ? undoRow : null}
                    <div className="rounded-lg border border-surface-border p-3">
                      <div className="flex items-center justify-between gap-2">
                        <div>
                          <p className="text-sm font-medium text-navy">{line.productName}</p>
                          {typeof line.qtySold === "number" && (
                            <p className="text-xs text-navy/70">
                              Sold {line.qtySold} {line.unit ?? "unit"}
                              {line.qtyAlreadyReturned
                                ? ` · Returned ${line.qtyAlreadyReturned}`
                                : ""}
                            </p>
                          )}
                        </div>
                        <button
                          type="button"
                          className="text-xs text-navy/50 hover:text-danger"
                          onClick={() => removeLine(line.lineKey)}
                        >
                          Remove
                        </button>
                      </div>
                      <div className="mt-2 grid grid-cols-2 gap-2 sm:grid-cols-4">
                        {boxed ? (
                          <>
                            <Input
                              label={UW.pack.other}
                              type="number"
                              min={0}
                              inputMode="numeric"
                              value={line.boxes}
                              onChange={(e) => updateLine(line.lineKey, { boxes: e.target.value })}
                            />
                            <Input
                              label={UW.base.other}
                              type="number"
                              min={0}
                              inputMode="numeric"
                              value={line.pieces}
                              onChange={(e) => updateLine(line.lineKey, { pieces: e.target.value })}
                            />
                          </>
                        ) : (
                          <Input
                            label={UW.base.other}
                            type="number"
                            min={0}
                            inputMode="numeric"
                            value={line.pieces}
                            onChange={(e) => updateLine(line.lineKey, { pieces: e.target.value })}
                          />
                        )}
                        <Select
                          label="Reason (optional)"
                          value={line.reason}
                          onChange={(e) =>
                            updateLine(line.lineKey, {
                              reason: e.target.value as ReturnReason | "",
                            })
                          }
                          options={[{ value: "", label: "Use default" }, ...REASON_OPTIONS]}
                        />
                        <Input
                          label="Note (optional)"
                          value={line.note}
                          onChange={(e) => updateLine(line.lineKey, { note: e.target.value })}
                        />
                      </div>
                      {canOverrideCredit && (
                        <div className="mt-2 grid grid-cols-1 gap-2 sm:grid-cols-[10rem_1fr]">
                          <Input
                            label={
                              boxed
                                ? `Credit price per ${UW.pack.lower} (optional)`
                                : "Credit price (optional)"
                            }
                            type="text"
                            inputMode="decimal"
                            placeholder="Quoted price"
                            value={line.creditUnitPrice ?? ""}
                            onChange={(e) =>
                              updateLine(line.lineKey, { creditUnitPrice: e.target.value })
                            }
                          />
                          <Input
                            label="Why the lower price"
                            maxLength={CREDIT_OVERRIDE_REASON_MAX}
                            value={line.overrideReason ?? ""}
                            onChange={(e) =>
                              updateLine(line.lineKey, { overrideReason: e.target.value })
                            }
                          />
                        </div>
                      )}
                    </div>
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
                  ref={productSearchRef}
                  label="Add another product"
                  placeholder="Search or scan products…"
                  value={productSearch}
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
              />
            </div>
            {scanMatches.length > 0 && (
              <div className="mt-2">
                <DidYouMeanPicker
                  matches={scanMatches}
                  onConfirm={(product) => {
                    setScanMatches([]);
                    addScanned(product);
                  }}
                  onCancel={() => setScanMatches([])}
                />
              </div>
            )}
            {productSearch.trim().length > 1 && (productResults?.data?.length ?? 0) > 0 && (
              <div className="absolute z-10 mt-1 w-full rounded-lg border border-surface-border bg-white shadow-card">
                {productResults!.data
                  .filter((p: { id: string }) => !lines.some((l) => l.productId === p.id))
                  .map(
                    (p: {
                      id: string;
                      name: string;
                      unit?: string;
                      unitsPerBox?: number | null;
                    }) => (
                      <button
                        type="button"
                        key={p.id}
                        className="flex w-full items-center justify-between px-3 py-2 text-left text-sm hover:bg-surface-raised"
                        onClick={() =>
                          addProduct({
                            id: p.id,
                            name: p.name,
                            unit: p.unit,
                            unitsPerBox: p.unitsPerBox,
                          })
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
            label="Reason"
            value={captureReason}
            onChange={(e) => setCaptureReason(e.target.value as ReturnReason | "")}
            options={[{ value: "", label: "Select a reason…" }, ...REASON_OPTIONS]}
          />

          {overrideProblem && <p className="text-sm text-danger">{overrideProblem}</p>}
          {quoteError && <p className="text-sm text-danger">{quoteError}</p>}

          <div className="flex justify-end gap-2">
            {renderLinesActions?.()}
            <Button
              disabled={!canGetQuote}
              loading={quoteMutation.isPending}
              onClick={handleGetQuote}
            >
              Get quote
            </Button>
          </div>
        </div>
      )}

      {step === "quote" && quote && (
        <div className="space-y-4">
          <div>
            <h4 className="mb-2 text-sm font-semibold text-navy">Quote</h4>
            <p className="mb-2 text-xs text-navy/70">
              Goods can come from more than one earlier order — each line below shows exactly where
              it was matched.
            </p>
            <div className="space-y-2">
              {covered.map((chunk, i) => (
                <CoveredChunkRow
                  key={`${chunk.sourceOrderId}-${chunk.sourceInvoiceItemId}-${i}`}
                  chunk={chunk}
                  boxed={boxedIds.has(chunk.productId)}
                />
              ))}
            </div>
          </div>

          {excess.length > 0 && (
            <div className="rounded-lg border border-amber-300 bg-amber-50 p-3">
              <p className="text-sm font-medium text-navy">
                {allExcessAlreadyReturned
                  ? ALREADY_RETURNED_LABEL
                  : anyAlreadyReturned
                    ? `Not on any invoice, or ${ALREADY_RETURNED_LABEL.toLowerCase()}`
                    : "Not on any invoice"}
              </p>
              {anyAlreadyReturned && (
                <p className="text-xs text-amber-900">
                  {canOverrideCredit ? ALREADY_RETURNED_NOTE : ALREADY_RETURNED_DRIVER_NOTE}
                </p>
              )}
              {canOverrideCredit &&
                [...flaggedIds].map((productId) => {
                  const line = lines.find((l) => l.productId === productId);
                  if (!line) return null;
                  return (
                    <Input
                      key={`already-returned-reason-${productId}`}
                      label={`Why credit ${line.productName} again (required)`}
                      maxLength={CREDIT_OVERRIDE_REASON_MAX}
                      value={line.alreadyReturnedReason ?? ""}
                      onChange={(e) =>
                        updateLine(line.lineKey, { alreadyReturnedReason: e.target.value })
                      }
                    />
                  );
                })}
              <p className="text-xs text-navy/70">
                {excess.reduce((s, c) => s + c.pieces, 0)} {UW.base.lower}(s) priced at the
                customer&apos;s current price.
              </p>
              {excess.map((c, i) => (
                <CreditOverrideNote
                  key={`excess-override-${i}`}
                  chunk={c}
                  boxed={boxedIds.has(c.productId)}
                />
              ))}
              <div className="mt-2 space-y-1 text-sm text-navy">
                <div className="flex justify-between">
                  <span>Net</span>
                  <span>{money(excessTotals.subtotal)}</span>
                </div>
                <div className="flex justify-between">
                  <span>Tax</span>
                  <span>{money(excessTotals.taxAmount)}</span>
                </div>
                {excessTotals.categoryTax > 0 && (
                  <div className="flex justify-between">
                    <span>Category levy</span>
                    <span>{money(excessTotals.categoryTax)}</span>
                  </div>
                )}
              </div>

              <div className="mt-3 space-y-2">
                <label className="flex items-center gap-2 text-sm text-navy">
                  <input
                    type="radio"
                    name="excess-option"
                    checked={excessOption === "CREDIT_AT_CURRENT_PRICE"}
                    onChange={() => handleExcessOptionChange("CREDIT_AT_CURRENT_PRICE")}
                  />
                  Credit at current price
                </label>
                <label
                  className={`flex items-center gap-2 text-sm ${onlyBoughtPossible ? "text-navy" : "text-navy/50"}`}
                >
                  <input
                    type="radio"
                    name="excess-option"
                    checked={excessOption === "RETURN_ONLY_PURCHASED"}
                    disabled={!onlyBoughtPossible}
                    aria-describedby={onlyBoughtPossible ? undefined : "excess-nothing-bought"}
                    onChange={() => handleExcessOptionChange("RETURN_ONLY_PURCHASED")}
                  />
                  Return only what was bought
                </label>
                {!onlyBoughtPossible && (
                  <p id="excess-nothing-bought" className="text-xs text-navy/70">
                    {NOTHING_BOUGHT_BEFORE_MESSAGE}
                  </p>
                )}
                {notBoughtBefore.length > 0 && (
                  <p className="text-xs text-navy/70">
                    Not bought before: {notBoughtBefore.join(", ")}
                  </p>
                )}
              </div>
            </div>
          )}

          <div className="rounded-lg bg-surface-raised p-3">
            {!totalOnly && (
              <div className="flex justify-between text-sm text-navy">
                <span>Subtotal</span>
                <span>{money(quote.subtotal)}</span>
              </div>
            )}
            {!totalOnly && (
              <div className="flex justify-between text-sm text-navy">
                <span>Tax</span>
                <span>{money(quote.taxAmount)}</span>
              </div>
            )}
            {!totalOnly && quote.categoryTax > 0 && (
              <div className="flex justify-between text-sm text-navy">
                <span>Category levy</span>
                <span>{money(quote.categoryTax)}</span>
              </div>
            )}
            <div className="mt-1 flex justify-between border-t border-surface-border pt-1 text-sm font-semibold text-navy">
              <span>Total</span>
              <span>{money(quote.total)}</span>
            </div>
            <p className="mt-2 text-xs text-navy/70">
              {quoteNote ?? <>This will be issued as credit note on the customer&apos;s balance.</>}
            </p>
          </div>

          <Select
            label="Reason"
            value={captureReason}
            onChange={(e) => setCaptureReason(e.target.value as ReturnReason | "")}
            options={[{ value: "", label: "Select a reason…" }, ...REASON_OPTIONS]}
            aria-describedby={!captureReason && reasonHintId ? reasonHintId : undefined}
          />

          {renderQuoteFooter?.(quote)}
          <div className="flex flex-wrap justify-end gap-2">
            {!hideBack && (
              <Button variant="ghost" onClick={() => setStep("lines")}>
                Back
              </Button>
            )}
            {renderQuoteActions?.(quote)}
          </div>
        </div>
      )}
    </div>
  );
}

function CoveredChunkRow({ chunk, boxed }: { chunk: InlineReturnQuoteChunk; boxed: boolean }) {
  const { data: sourceOrder } = useOrder(chunk.sourceOrderId ?? "");
  return (
    <div className="rounded-lg border border-surface-border p-3 text-sm">
      <div className="flex justify-between">
        <span className="font-medium text-navy">
          {sourceOrder ? `From order #${sourceOrder.orderNumber}` : "From an earlier order"}
          {sourceOrder?.orderDate && ` · ${new Date(sourceOrder.orderDate).toLocaleDateString()}`}
        </span>
        <span className="text-navy/70">
          {chunk.pieces} {UW.base.short.one}
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
