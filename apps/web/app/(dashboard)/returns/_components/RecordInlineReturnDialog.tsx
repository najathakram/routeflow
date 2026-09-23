"use client";

// ─── Record a return, inline — office web capture (PR 1) ───────────────────────
//
// quote → confirm → result. Customer-scoped quote (no orderId); a carrying order is
// required for capture — pre-set from the entry order when opened from order detail,
// otherwise picked from the customer's own orders. No held/approve/reject UI (PR 2), no
// "different price" excess option or placeholder for it (PR 2b), no mobile mirror (PR 3).
// See local-assets/handoff/2026-09-22/SPEC-inline-returns-capture-web-PR1.md.
import * as React from "react";
import { Button, Input, Modal, Select, useToast } from "@routeflow/ui/web";
import { useOrder, useOrders } from "@/lib/api/orders";
import { useProducts } from "@/lib/api/products";
import { useCaptureInlineReturn, useInlineReturnQuote } from "@/lib/api/inline-returns";
import type {
  InlineReturnQuoteChunk,
  InlineReturnQuoteResponse,
  InlineReturnRecord,
  ReturnReason,
} from "@routeflow/types";
import {
  applyCoveredPiecesToLines,
  buildCaptureRequest,
  buildQuoteRequest,
  DEFAULT_EXCESS_OPTION,
  dropExcessAndRequote,
  extractRefusalMessage,
  groupQuoteChunks,
  hasAnyQtyEntered,
  isBoxedProduct,
  mintReturnKey,
  sumChunkTotals,
  type ExcessOption,
  type InlineReturnLineDraft,
} from "@routeflow/returns";

/**
 * SA-108 (Opus review of #1293/B774): `InlineReturnLineDraft` itself has no per-ROW identity
 * — only `productId`. Keying this dialog's state (and its React list `key`) by `productId`
 * meant TWO rows of the same product (a source order with, say, a Case line and a pack line)
 * could never be edited independently: `updateLine`/`removeLine` matched EVERY row sharing
 * that productId, so typing into one row silently patched the other to match, and
 * `buildQuoteRequest`'s same-productId merge (B774) then summed what looked like two
 * genuine entries but was really one value counted twice — a silent 2x credit whenever the
 * two rows' packs happened to agree (a pack MISmatch is instead caught server-side by the
 * B774 conflict guard). `lineKey` is a dialog-local synthetic id, never sent on the wire —
 * `buildQuoteRequest`/`buildCaptureRequest` still take plain `InlineReturnLineDraft[]` and
 * still merge by `productId`, which is correct: TWO independently-typed rows for one
 * product are meant to sum into one request item once each carries its own real value.
 */
type DialogLine = InlineReturnLineDraft & { lineKey: string };

const REASON_OPTIONS: { value: ReturnReason; label: string }[] = [
  { value: "DAMAGED", label: "Damaged" },
  { value: "WRONG_ITEM", label: "Wrong Item" },
  { value: "CUSTOMER_REFUSED", label: "Customer Refused" },
  { value: "QUALITY_ISSUE", label: "Quality Issue" },
  { value: "EXCESS_ORDER", label: "Excess / Overdelivery" },
];

function money(n: number): string {
  return n.toLocaleString("en-US", { style: "currency", currency: "USD" });
}

export interface RecordInlineReturnDialogProps {
  open: boolean;
  onClose: () => void;
  customerId: string;
  customerName?: string;
  /** The order this dialog was opened FROM — pre-filters Step 1 to its line items and is
   *  used as the carrying order (capture's `orderId`) with no extra picker. Omit when
   *  opening from customer detail (the order picker below is then required). */
  orderId?: string;
}

type DialogStep = "lines" | "quote" | "success" | "refused";

export function RecordInlineReturnDialog({
  open,
  onClose,
  customerId,
  customerName,
  orderId,
}: RecordInlineReturnDialogProps) {
  const { toast } = useToast();
  const { data: entryOrder } = useOrder(orderId ?? "");
  const { data: customerOrders } = useOrders(
    { customerId, limit: 25 },
    { enabled: open && !orderId },
  );

  const [step, setStep] = React.useState<DialogStep>("lines");
  const [carryingOrderId, setCarryingOrderId] = React.useState(orderId ?? "");
  const [lines, setLines] = React.useState<DialogLine[]>([]);
  const [captureReason, setCaptureReason] = React.useState<ReturnReason | "">("");
  const [quote, setQuote] = React.useState<InlineReturnQuoteResponse | null>(null);
  const [excessOption, setExcessOption] = React.useState<ExcessOption>(DEFAULT_EXCESS_OPTION);
  const [refusalMessage, setRefusalMessage] = React.useState("");
  const [result, setResult] = React.useState<InlineReturnRecord | null>(null);
  const [productSearch, setProductSearch] = React.useState("");
  // One UUID per capture ATTEMPT — held in a ref (not state) so a re-render never regenerates
  // it, and reused unchanged across a retry of the SAME attempt (SA-071a #2, corrected
  // 2026-09-22: the capture response carries no `replayed` flag — any 200 is success).
  const returnKeyRef = React.useRef("");

  const quoteMutation = useInlineReturnQuote();
  const captureMutation = useCaptureInlineReturn();

  const { data: productResults } = useProducts(
    { search: productSearch, limit: 10 },
    { enabled: open && productSearch.trim().length > 1 },
  );

  // Fresh attempt every time the dialog opens: reset every field and re-populate Step 1 from
  // the entry order's own line items when opened from an order.
  React.useEffect(() => {
    if (!open) return;
    setStep("lines");
    setCarryingOrderId(orderId ?? "");
    setCaptureReason("");
    setQuote(null);
    setExcessOption(DEFAULT_EXCESS_OPTION);
    setRefusalMessage("");
    setResult(null);
    setProductSearch("");
    returnKeyRef.current = "";
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
    // Re-run only when the dialog (re)opens for a given order/entry — not on every entryOrder
    // object identity change (a fresh object from the same query still means "the same order").
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, orderId, entryOrder?.id]);

  function updateLine(lineKey: string, patch: Partial<InlineReturnLineDraft>) {
    setLines((prev) => prev.map((l) => (l.lineKey === lineKey ? { ...l, ...patch } : l)));
  }

  function removeLine(lineKey: string) {
    setLines((prev) => prev.filter((l) => l.lineKey !== lineKey));
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

  function handleGetQuote() {
    if (!carryingOrderId) {
      toast({ title: "Pick which order this credit applies to first", variant: "error" });
      return;
    }
    quoteMutation.mutate(buildQuoteRequest(customerId, lines), {
      onSuccess: (data) => {
        if (!returnKeyRef.current) returnKeyRef.current = mintReturnKey();
        setQuote(data);
        setStep("quote");
      },
      onError: (err) => {
        setRefusalMessage(extractRefusalMessage(err));
        setStep("refused");
      },
    });
  }

  function handleExcessOptionChange(option: ExcessOption) {
    setExcessOption(option);
    if (option !== "RETURN_ONLY_PURCHASED" || !quote) return;
    quoteMutation.mutate(dropExcessAndRequote(customerId, quote), {
      onSuccess: (data) => {
        setQuote(data);
        // Capture reads quantities from `lines`, not from the quote — without this, a later
        // confirm would still send the ORIGINAL (larger) request this option just dropped.
        // Cast is safe: applyCoveredPiecesToLines spreads each input line into its output
        // ({...l, boxes, pieces}), so a DialogLine's lineKey survives at runtime even though
        // the shared package's own return type only promises InlineReturnLineDraft.
        setLines((prev) => applyCoveredPiecesToLines(prev, data) as DialogLine[]);
      },
      onError: (err) => {
        setRefusalMessage(extractRefusalMessage(err));
        setStep("refused");
      },
    });
  }

  function handleConfirm() {
    if (!captureReason) {
      toast({ title: "Choose a reason before confirming", variant: "error" });
      return;
    }
    if (!returnKeyRef.current) returnKeyRef.current = mintReturnKey();
    captureMutation.mutate(
      buildCaptureRequest({
        customerId,
        orderId: carryingOrderId,
        lines,
        returnKey: returnKeyRef.current,
        reason: captureReason,
      }),
      {
        onSuccess: (data) => {
          setResult(data);
          setStep("success");
        },
        onError: (err) => {
          setRefusalMessage(extractRefusalMessage(err));
          setStep("refused");
        },
      },
    );
  }

  const { covered, excess } = quote
    ? groupQuoteChunks(quote)
    : { covered: [] as InlineReturnQuoteChunk[], excess: [] as InlineReturnQuoteChunk[] };
  const excessTotals = sumChunkTotals(excess);
  const canGetQuote = hasAnyQtyEntered(lines) && !!carryingOrderId;

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Record a return"
      description={customerName ? `For ${customerName}` : undefined}
      className="max-w-2xl"
      scroll
    >
      {step === "lines" && (
        <div className="space-y-4">
          {!orderId && (
            <Select
              label="Which order should this credit apply to?"
              value={carryingOrderId}
              onChange={(e) => setCarryingOrderId(e.target.value)}
              options={[
                { value: "", label: "Select an order…" },
                ...(customerOrders?.data ?? [])
                  .filter((o) => o.status !== "CANCELLED")
                  .map((o) => ({ value: o.id, label: `Order #${o.orderNumber}` })),
              ]}
            />
          )}

          <div>
            <h4 className="mb-2 text-sm font-semibold text-navy">What came back</h4>
            <div className="space-y-3">
              {lines.length === 0 && (
                <p className="text-sm text-navy/70">No products yet — search below to add one.</p>
              )}
              {lines.map((line) => {
                const boxed = isBoxedProduct(line);
                return (
                  <div key={line.lineKey} className="rounded-lg border border-surface-border p-3">
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
                            label="Boxes"
                            type="number"
                            min={0}
                            inputMode="numeric"
                            value={line.boxes}
                            onChange={(e) => updateLine(line.lineKey, { boxes: e.target.value })}
                          />
                          <Input
                            label="Pieces"
                            type="number"
                            min={0}
                            inputMode="numeric"
                            value={line.pieces}
                            onChange={(e) => updateLine(line.lineKey, { pieces: e.target.value })}
                          />
                        </>
                      ) : (
                        <Input
                          label="Qty (pieces)"
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
                  </div>
                );
              })}
            </div>
          </div>

          <div className="relative">
            <Input
              label="Add another product"
              placeholder="Search products…"
              value={productSearch}
              onChange={(e) => setProductSearch(e.target.value)}
            />
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

          <div className="flex justify-end gap-2">
            <Button variant="ghost" onClick={onClose}>
              Cancel
            </Button>
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
                />
              ))}
            </div>
          </div>

          {excess.length > 0 && (
            <div className="rounded-lg border border-amber-300 bg-amber-50 p-3">
              <p className="text-sm font-medium text-navy">Not on any invoice</p>
              <p className="text-xs text-navy/70">
                {excess.reduce((s, c) => s + c.pieces, 0)} piece(s) priced at the customer&apos;s
                current price.
              </p>
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
                <label className="flex items-center gap-2 text-sm text-navy">
                  <input
                    type="radio"
                    name="excess-option"
                    checked={excessOption === "RETURN_ONLY_PURCHASED"}
                    onChange={() => handleExcessOptionChange("RETURN_ONLY_PURCHASED")}
                  />
                  Return only what was bought
                </label>
              </div>
            </div>
          )}

          <div className="rounded-lg bg-surface-raised p-3">
            <div className="flex justify-between text-sm text-navy">
              <span>Subtotal</span>
              <span>{money(quote.subtotal)}</span>
            </div>
            <div className="flex justify-between text-sm text-navy">
              <span>Tax</span>
              <span>{money(quote.taxAmount)}</span>
            </div>
            {quote.categoryTax > 0 && (
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
              This will be issued as credit note on the customer&apos;s balance.
            </p>
          </div>

          <Select
            label="Reason"
            value={captureReason}
            onChange={(e) => setCaptureReason(e.target.value as ReturnReason | "")}
            options={[{ value: "", label: "Select a reason…" }, ...REASON_OPTIONS]}
          />

          <div className="flex justify-end gap-2">
            <Button variant="ghost" onClick={() => setStep("lines")}>
              Back
            </Button>
            <Button
              disabled={!captureReason}
              loading={captureMutation.isPending}
              onClick={handleConfirm}
            >
              Issue credit note and receive goods
            </Button>
          </div>
        </div>
      )}

      {step === "success" && result && (
        <div className="space-y-3">
          <p className="text-sm font-medium text-navy">Return recorded</p>
          <dl className="space-y-1 text-sm text-navy">
            {result.returnNumber && (
              <div className="flex justify-between">
                <dt className="text-navy/70">Return</dt>
                <dd>
                  <a className="text-brand-600 underline" href={`/returns/${result.id}`}>
                    #{result.returnNumber}
                  </a>
                </dd>
              </div>
            )}
            {result.creditNoteId && (
              <div className="flex justify-between">
                <dt className="text-navy/70">Credit note</dt>
                <dd>
                  <a
                    className="text-brand-600 underline"
                    href={`/credit-notes/${result.creditNoteId}`}
                  >
                    View credit note
                  </a>
                </dd>
              </div>
            )}
            {typeof result.refundAmount === "number" && (
              <div className="flex justify-between">
                <dt className="text-navy/70">Amount</dt>
                <dd>{money(result.refundAmount)}</dd>
              </div>
            )}
            <div className="flex justify-between">
              <dt className="text-navy/70">Order</dt>
              <dd>
                <a className="text-brand-600 underline" href={`/orders/${result.orderId}`}>
                  View order
                </a>
              </dd>
            </div>
          </dl>
          <div className="flex justify-end">
            <Button onClick={onClose}>Done</Button>
          </div>
        </div>
      )}

      {step === "refused" && (
        <div className="space-y-3">
          <p className="text-sm font-medium text-danger">{refusalMessage}</p>
          <div className="flex justify-end gap-2">
            <Button variant="ghost" onClick={onClose}>
              Close
            </Button>
            <Button variant="secondary" onClick={() => setStep(quote ? "quote" : "lines")}>
              Back
            </Button>
          </div>
        </div>
      )}
    </Modal>
  );
}

function CoveredChunkRow({ chunk }: { chunk: InlineReturnQuoteChunk }) {
  const { data: sourceOrder } = useOrder(chunk.sourceOrderId ?? "");
  return (
    <div className="rounded-lg border border-surface-border p-3 text-sm">
      <div className="flex justify-between">
        <span className="font-medium text-navy">
          {sourceOrder ? `From order #${sourceOrder.orderNumber}` : "From an earlier order"}
          {sourceOrder?.orderDate && ` · ${new Date(sourceOrder.orderDate).toLocaleDateString()}`}
        </span>
        <span className="text-navy/70">{chunk.pieces} pc</span>
      </div>
      <div className="mt-1 flex justify-between text-navy/70">
        <span>Net {money(chunk.subtotal)}</span>
        <span>Tax {money(chunk.taxAmount)}</span>
        {chunk.categoryTax > 0 && <span>Levy {money(chunk.categoryTax)}</span>}
      </div>
    </div>
  );
}
