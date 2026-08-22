"use client";

import * as React from "react";
import Link from "next/link";
import {
  ArrowLeft,
  CreditCard,
  Ban,
  CheckCircle2,
  Loader2,
  PackageCheck,
  RotateCcw,
  Pencil,
  X,
  Plus,
  Trash2,
  Save,
  AlertTriangle,
} from "lucide-react";
import { Button, Card, Modal, cn, useToast, Badge } from "@routeflow/ui/web";
import { usePageTitle } from "@/lib/page-title-context";
import {
  useVendorBill,
  useReceiveVendorBill,
  useVoidVendorBill,
  useRecordVendorBillPayment,
  useRevertVendorBillToDraft,
  useUpdateVendorBill,
  useSaveProductMapping,
  getUnlinkedItemsError,
  type UnlinkedItemsError,
  type VendorBill,
  type VendorBillItem,
  type VendorBillStatus,
  type VendorBillPayment,
  type CreateVendorBillItem,
  type ReceiveVendorBillLine,
} from "@/lib/api/vendor-bills";
import { useSuppliers } from "@/lib/api/inventory";
import { SupplierSelect } from "@/components/SupplierSelect";
import { InlineCreateProductModal } from "@/components/InlineCreateProductModal";
import { SearchableProductPicker } from "@/components/SearchableProductPicker";
import { VariantSplitModal } from "@/components/VariantSplitModal";
import { useProduct } from "@/lib/api/products";
import { roundMoney } from "@/lib/pricing";
import { fmt, fmtDate } from "@/lib/formatting";
import { usePreferences, useSavePreferences } from "@/lib/api/users";
import {
  SELECTABLE_PAYMENT_METHODS,
  PAYMENT_METHOD_LABELS,
  paymentMethodLabel,
  type SelectablePaymentMethod,
} from "@/lib/payment-methods";

/**
 * Extra fields the API additively includes on a bill's `findOne` mapped-
 * product select (PR-D WP2: `parentProductId` + `_count.variants`) so the
 * line-item table can show a "split into variants" hint. The shared
 * `VendorBillItem["product"]` type isn't widened for this (out of scope for
 * this change) — narrowed locally instead.
 */
type MappedProductVariantHint = {
  parentProductId?: string | null;
  _count?: { variants: number };
};

// ─── Record Payment Modal ─────────────────────────────────────────────────────

interface PaymentFormState {
  method: SelectablePaymentMethod;
  amount: string;
  reference: string;
  notes: string;
}

function RecordPaymentModal({
  isOpen,
  onClose,
  onRecord,
  balance,
  isPending,
  defaultMethod,
}: {
  isOpen: boolean;
  onClose: () => void;
  onRecord: (data: PaymentFormState) => void;
  balance: number;
  isPending: boolean;
  defaultMethod?: PaymentFormState["method"];
}) {
  const [form, setForm] = React.useState<PaymentFormState>({
    method: defaultMethod ?? "ACH",
    amount: "",
    reference: "",
    notes: "",
  });
  const [amountError, setAmountError] = React.useState("");

  React.useEffect(() => {
    if (isOpen) {
      setForm({
        method: defaultMethod ?? "ACH",
        amount: balance > 0 ? balance.toFixed(2) : "",
        reference: "",
        notes: "",
      });
      setAmountError("");
    }
  }, [isOpen, balance, defaultMethod]);

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    const amt = parseFloat(form.amount);
    if (!form.amount || isNaN(amt) || amt <= 0) {
      setAmountError("Enter an amount greater than 0.");
      return;
    }
    setAmountError("");
    onRecord(form);
  }

  return (
    <Modal
      open={isOpen}
      onClose={onClose}
      title="Record Payment"
      description="Log a payment made against this vendor bill."
      footer={
        <>
          <Button variant="secondary" onClick={onClose} disabled={isPending}>
            Cancel
          </Button>
          <Button type="submit" form="bill-payment-form" loading={isPending}>
            Record Payment
          </Button>
        </>
      }
    >
      <form id="bill-payment-form" onSubmit={handleSubmit} noValidate className="space-y-4">
        <div>
          <label className="mb-1.5 block text-sm font-medium text-navy/80">Payment Method</label>
          <select
            value={form.method}
            onChange={(e) =>
              setForm((f) => ({ ...f, method: e.target.value as PaymentFormState["method"] }))
            }
            className="h-10 w-full rounded-lg border border-surface-border bg-white px-3 text-sm text-navy focus:border-transparent focus:outline-none focus:ring-2 focus:ring-brand-500"
          >
            {SELECTABLE_PAYMENT_METHODS.map((m) => (
              <option key={m} value={m}>
                {PAYMENT_METHOD_LABELS[m]}
              </option>
            ))}
          </select>
        </div>

        <div>
          <label className="mb-1.5 block text-sm font-medium text-navy/80">Amount ($)</label>
          <input
            type="number"
            step="0.01"
            min="0.01"
            placeholder="0.00"
            value={form.amount}
            onChange={(e) => setForm((f) => ({ ...f, amount: e.target.value }))}
            className={cn(
              "h-10 w-full rounded-lg border bg-white px-3 text-sm text-navy placeholder:text-navy/30 focus:border-transparent focus:outline-none focus:ring-2 focus:ring-brand-500",
              amountError ? "border-danger" : "border-surface-border",
            )}
          />
          {amountError && <p className="mt-1 text-xs text-danger">{amountError}</p>}
        </div>

        <div>
          <label className="mb-1.5 block text-sm font-medium text-navy/80">
            Reference # <span className="text-navy/70 font-normal">(optional)</span>
          </label>
          <input
            type="text"
            placeholder="Check number, ACH ID…"
            value={form.reference}
            onChange={(e) => setForm((f) => ({ ...f, reference: e.target.value }))}
            className="h-10 w-full rounded-lg border border-surface-border bg-white px-3 text-sm text-navy placeholder:text-navy/30 focus:border-transparent focus:outline-none focus:ring-2 focus:ring-brand-500"
          />
        </div>

        <div>
          <label className="mb-1.5 block text-sm font-medium text-navy/80">
            Notes <span className="text-navy/70 font-normal">(optional)</span>
          </label>
          <textarea
            rows={2}
            placeholder="Additional payment notes…"
            value={form.notes}
            onChange={(e) => setForm((f) => ({ ...f, notes: e.target.value }))}
            className="w-full resize-none rounded-lg border border-surface-border bg-white px-3 py-2 text-sm text-navy placeholder:text-navy/30 focus:border-transparent focus:outline-none focus:ring-2 focus:ring-brand-500"
          />
        </div>
      </form>
    </Modal>
  );
}

// ─── Void Confirm Modal ───────────────────────────────────────────────────────

function VoidConfirmModal({
  isOpen,
  onClose,
  onConfirm,
  billNumber,
  isPending,
}: {
  isOpen: boolean;
  onClose: () => void;
  onConfirm: () => void;
  billNumber: string;
  isPending: boolean;
}) {
  return (
    <Modal
      open={isOpen}
      onClose={onClose}
      title="Void Bill?"
      description={`Bill ${billNumber} will be marked as void. This action cannot be undone.`}
      footer={
        <>
          <Button variant="secondary" onClick={onClose} disabled={isPending}>
            Cancel
          </Button>
          <Button variant="danger" onClick={onConfirm} loading={isPending}>
            Void Bill
          </Button>
        </>
      }
    >
      <p className="text-sm text-navy/70">
        Voiding this bill will mark it as cancelled. No further payments can be recorded on it.
      </p>
    </Modal>
  );
}

// ─── Unlinked Items Confirm Modal ─────────────────────────────────────────────

function UnlinkedItemsModal({
  payload,
  onClose,
  onConfirm,
  isPending,
}: {
  payload: UnlinkedItemsError | null;
  onClose: () => void;
  onConfirm: () => void;
  isPending: boolean;
}) {
  return (
    <Modal
      open={!!payload}
      onClose={onClose}
      title="Some lines won't update costs"
      description={payload?.message ?? ""}
      footer={
        <>
          <Button variant="secondary" onClick={onClose} disabled={isPending}>
            Go back and map items
          </Button>
          <Button onClick={onConfirm} loading={isPending}>
            Receive anyway
          </Button>
        </>
      }
    >
      {payload && payload.unlinkedItems.length > 0 ? (
        <div className="space-y-2">
          <p className="text-sm text-navy/70">
            These lines are not linked to a product, so they will NOT update inventory quantities or
            average costs:
          </p>
          <ul className="max-h-48 space-y-1 overflow-y-auto rounded-md bg-amber-50 p-3 text-sm text-navy">
            {payload.unlinkedItems.map((item) => (
              <li key={item.id} className="flex justify-between gap-3">
                <span className="truncate">{item.description || "(no description)"}</span>
                <span className="shrink-0 tabular-nums text-navy/70">
                  {item.qty} × {fmt(item.unitCost)}
                </span>
              </li>
            ))}
          </ul>
        </div>
      ) : (
        <p className="text-sm text-navy/70">
          This bill has no line items at all — receiving it records the expense but changes no
          inventory quantities or costs. Add items (or scan the invoice) to keep costs accurate.
        </p>
      )}
    </Modal>
  );
}

// ─── Receive Modal (per-line quantities — partial receiving) ──────────────────

/**
 * How much of a line is still outstanding. Bills received before per-line
 * tracking (receivedDate set, every qtyReceived null) were fully received.
 */
function lineRemaining(bill: VendorBill, item: VendorBillItem): number {
  const tracked = (bill.items ?? []).some((i) => i.qtyReceived != null);
  const received =
    item.qtyReceived != null
      ? Number(item.qtyReceived)
      : bill.receivedDate && !tracked
        ? Number(item.qty)
        : 0;
  return Math.max(0, Number(item.qty) - received);
}

/**
 * How much of a line has been received so far, converted from the bill's own
 * denomination (cases, when `packSize > 1`) into `Product.currentStock`'s
 * PIECE denomination — mirrors the API's `lineInventoryDelta` (PR-D WP4).
 * Used as the default pool for a generic→variant split started from this
 * line: assigning cases as though they were loose pieces would move the
 * wrong quantity entirely.
 */
function lineReceivedBaseUnits(bill: VendorBill, item: VendorBillItem): number {
  const receivedInBillDenom = Number(item.qty) - lineRemaining(bill, item);
  const pack = item.packSize ?? 0;
  return pack > 1 ? receivedInBillDenom * pack : receivedInBillDenom;
}

function ReceiveBillModal({
  bill,
  isOpen,
  onClose,
  onConfirm,
  isPending,
}: {
  bill: VendorBill;
  isOpen: boolean;
  onClose: () => void;
  /** undefined = no linked lines to quantify (expense-only bill). */
  onConfirm: (items: ReceiveVendorBillLine[] | undefined) => void;
  isPending: boolean;
}) {
  const linked = (bill.items ?? []).filter((i) => i.productId);
  const unlinkedCount = (bill.items ?? []).length - linked.length;
  const [qtys, setQtys] = React.useState<Record<string, string>>({});

  // Re-prime the inputs to "everything outstanding" each time the modal opens.
  React.useEffect(() => {
    if (!isOpen) return;
    setQtys(Object.fromEntries(linked.map((i) => [i.id, String(lineRemaining(bill, i))])));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isOpen, bill]);

  const parsed = linked.map((item) => {
    const remaining = lineRemaining(bill, item);
    const raw = qtys[item.id] ?? "";
    const qty = raw.trim() === "" ? 0 : Number(raw);
    const invalid = !Number.isFinite(qty) || qty < 0 || qty > remaining;
    return { item, remaining, qty, invalid };
  });
  const anyInvalid = parsed.some((p) => p.invalid);
  const totalEntered = parsed.reduce((s, p) => s + (p.invalid ? 0 : p.qty), 0);
  const isTopUp = bill.receivedDate != null;

  return (
    <Modal
      open={isOpen}
      onClose={onClose}
      title={isTopUp ? "Receive remaining stock" : "Receive stock"}
      description="Adjust quantities if only part of the delivery arrived — the rest stays outstanding to receive later."
      footer={
        <>
          <Button variant="secondary" onClick={onClose} disabled={isPending}>
            Cancel
          </Button>
          <Button
            onClick={() =>
              onConfirm(
                linked.length === 0
                  ? undefined
                  : parsed.filter((p) => p.qty > 0).map((p) => ({ itemId: p.item.id, qty: p.qty })),
              )
            }
            loading={isPending}
            disabled={anyInvalid || (linked.length > 0 && totalEntered <= 0)}
            data-testid="receive-confirm"
          >
            {isTopUp ? "Receive" : "Mark Received"}
          </Button>
        </>
      }
    >
      <div className="space-y-3">
        {linked.length === 0 ? (
          <p className="text-sm text-navy/70">
            No lines on this bill are linked to a product — receiving it records the bill but
            changes no stock or costs.
          </p>
        ) : (
          <ul className="max-h-64 space-y-2 overflow-y-auto">
            {parsed.map(({ item, remaining, invalid }) => {
              const received = Number(item.qty) - remaining;
              const casePacked = (item.packSize ?? 0) > 1;
              return (
                <li key={item.id} className="flex items-center justify-between gap-3">
                  <div className="min-w-0">
                    <p className="truncate text-sm text-navy">
                      {item.product?.name ?? item.description}
                    </p>
                    <p className="text-xs text-navy/60">
                      {received > 0 && `${received} of ${item.qty} already received · `}
                      {casePacked && `case of ${item.packSize} pcs · `}
                      {remaining} outstanding
                    </p>
                  </div>
                  <input
                    type="number"
                    min="0"
                    max={remaining}
                    step="0.001"
                    value={qtys[item.id] ?? ""}
                    onChange={(e) => setQtys((q) => ({ ...q, [item.id]: e.target.value }))}
                    className={cn(
                      "h-9 w-24 shrink-0 rounded border bg-white px-2 text-sm text-right text-navy focus:outline-none focus:ring-1 focus:ring-brand-500",
                      invalid ? "border-red-400" : "border-surface-border",
                    )}
                    aria-label={`Quantity to receive for ${item.product?.name ?? item.description}`}
                  />
                </li>
              );
            })}
          </ul>
        )}
        {unlinkedCount > 0 && (
          <p className="rounded-md bg-amber-50 p-2.5 text-xs text-amber-800">
            {unlinkedCount} unlinked {unlinkedCount === 1 ? "line" : "lines"} (freight, deposits, …)
            won&apos;t update stock or costs.
          </p>
        )}
      </div>
    </Modal>
  );
}

// ─── Revert to Draft Confirm Modal ────────────────────────────────────────────

function RevertToDraftModal({
  isOpen,
  onClose,
  onConfirm,
  billNumber,
  isPending,
}: {
  isOpen: boolean;
  onClose: () => void;
  onConfirm: () => void;
  billNumber: string;
  isPending: boolean;
}) {
  return (
    <Modal
      open={isOpen}
      onClose={onClose}
      title="Revert to Draft?"
      description={`Bill ${billNumber} will be reverted to Draft status.`}
      footer={
        <>
          <Button variant="secondary" onClick={onClose} disabled={isPending}>
            Cancel
          </Button>
          <Button variant="primary" onClick={onConfirm} loading={isPending}>
            Revert to Draft
          </Button>
        </>
      }
    >
      <div className="space-y-2 text-sm text-navy/70">
        <p>
          This will reverse the inventory update that was applied when the bill was received. You
          can then edit the bill and mark it as received again.
        </p>
        <p className="rounded-lg border border-yellow-200 bg-yellow-50 p-3 text-yellow-700">
          <strong>Note:</strong> Stock quantities are decremented and product average costs are
          reversed to their pre-receipt values, exactly undoing the original receive.
        </p>
      </div>
    </Modal>
  );
}

// ─── Edit Line Item Row ───────────────────────────────────────────────────────

interface EditLineItemRow {
  productId: string;
  description: string;
  qty: string;
  unitCost: string;
  /** Units per box/case — when set (>1), unitCost is the CASE cost and the
   *  receive converts to pieces + per-piece cost. */
  packSize: string;
  /** Scan-captured fields carried through the edit so saving doesn't drop them. */
  sku?: string | null;
  lineTotal?: number | null;
}

const emptyRow = (): EditLineItemRow => ({
  productId: "",
  description: "",
  qty: "1",
  unitCost: "",
  packSize: "",
});

/** What a picked catalog product contributes to the line's cost fields. */
interface PickableCostProduct {
  id: string;
  name: string;
  averageCost?: string | number | null;
  standardCost?: string | number | null;
  unitsPerBox?: number | null;
}

/**
 * Prefill for a linked line — COST-side truth, never the selling price.
 * `averageCost`/`standardCost` are per PIECE; a boxed product's invoice line
 * is priced per CASE, so a boxed product prefills the CASE cost
 * (avg × unitsPerBox) and the case size together — receive() converts back
 * to pieces at unitCost ÷ packSize (`lineInventoryDelta` in
 * vendor-bills.service.ts). Mirrors mobile's `linePrefillFor`
 * (apps/mobile/app/(operator)/vendor-bills/new.tsx). The old prefill here put
 * a PIECE cost straight into the CASE cost field for any boxed product —
 * over-costing every linked case line by a factor of `unitsPerBox`.
 *
 * Unlike mobile (a NEW bill, rows start blank), this is the EDIT screen: rows
 * are seeded from the saved bill, so a product that declares no `unitsPerBox`
 * must leave the row's own `packSize`/case cost alone — clearing them would
 * silently re-denominate an already-boxed line into pieces.
 */
function linePrefillFor(p: PickableCostProduct, row: EditLineItemRow): Partial<EditLineItemRow> {
  const perPiece = Number(p.averageCost ?? p.standardCost ?? 0);
  const upb = Number(p.unitsPerBox ?? 0);
  const patch: Partial<EditLineItemRow> = { productId: p.id, description: p.name };
  if (upb > 1) {
    patch.packSize = String(upb);
    if (perPiece > 0) patch.unitCost = (perPiece * upb).toFixed(4);
  } else if (perPiece > 0 && !(parseInt(row.packSize, 10) > 1)) {
    // No catalog case size: only prefill when the row itself is priced per
    // piece — never overwrite a case cost with a per-piece one.
    patch.unitCost = perPiece.toFixed(4);
  }
  return patch;
}

function EditLineItems({
  items,
  onChange,
  supplierName,
}: {
  items: EditLineItemRow[];
  onChange: (items: EditLineItemRow[]) => void;
  /** Bill supplier — used to teach the scan matcher when a product is created/linked here. */
  supplierName?: string;
}) {
  const saveMapping = useSaveProductMapping();
  const [createFromRow, setCreateFromRow] = React.useState<number | null>(null);

  const update = (i: number, patch: Partial<EditLineItemRow>) => {
    onChange(items.map((row, idx) => (idx === i ? { ...row, ...patch } : row)));
  };

  const remove = (i: number) => onChange(items.filter((_, idx) => idx !== i));
  const add = () => onChange([...items, emptyRow()]);

  return (
    <div className="space-y-2">
      {items.map((row, i) => (
        <div key={i} className="grid grid-cols-[1fr_72px_72px_100px_32px] gap-2 items-start">
          <div>
            <SearchableProductPicker
              async
              value={row.productId}
              selectedLabel={row.description}
              placeholder="Search products… (or leave as custom item)"
              onChange={(id, product) =>
                product ? update(i, linePrefillFor(product, row)) : update(i, { productId: "" })
              }
            />
            {!row.productId && (
              <>
                <input
                  type="text"
                  value={row.description}
                  onChange={(e) => update(i, { description: e.target.value })}
                  placeholder="Description"
                  className="h-9 w-full rounded border border-surface-border bg-white px-2 text-sm text-navy placeholder:text-navy/30 focus:outline-none focus:ring-1 focus:ring-brand-500"
                />
                <button
                  type="button"
                  onClick={() => setCreateFromRow(i)}
                  className="mt-1 flex items-center gap-1 text-xs font-medium text-brand-600 hover:text-brand-700 hover:underline"
                >
                  <Plus className="h-3 w-3" />
                  Create product from this line
                </button>
              </>
            )}
          </div>
          <div>
            <label className="mb-0.5 block text-[10px] text-navy/70">Qty</label>
            <input
              type="number"
              min="0.001"
              step="0.001"
              value={row.qty}
              onChange={(e) => update(i, { qty: e.target.value })}
              className="h-9 w-full rounded border border-surface-border bg-white px-2 text-sm text-right text-navy focus:outline-none focus:ring-1 focus:ring-brand-500"
            />
          </div>
          <div>
            <label className="mb-0.5 block text-[10px] text-navy/70">Pcs/case</label>
            <input
              type="number"
              min="0"
              step="1"
              value={row.packSize}
              onChange={(e) => update(i, { packSize: e.target.value })}
              placeholder="—"
              title="Units per case. Leave blank when the line is priced per unit."
              className="h-9 w-full rounded border border-surface-border bg-white px-2 text-sm text-right text-navy placeholder:text-navy/30 focus:outline-none focus:ring-1 focus:ring-brand-500"
            />
          </div>
          <div>
            <label className="mb-0.5 block text-[10px] text-navy/70">
              {parseInt(row.packSize, 10) > 1 ? "Case Cost ($)" : "Unit Cost ($)"}
            </label>
            <input
              type="number"
              min="0"
              step="0.0001"
              value={row.unitCost}
              onChange={(e) => update(i, { unitCost: e.target.value })}
              className="h-9 w-full rounded border border-surface-border bg-white px-2 text-sm text-right text-navy focus:outline-none focus:ring-1 focus:ring-brand-500"
            />
          </div>
          <button
            type="button"
            onClick={() => remove(i)}
            disabled={items.length === 1}
            className="mt-6 h-9 rounded p-1 text-navy/30 hover:text-danger transition-colors disabled:opacity-20"
          >
            <Trash2 className="h-4 w-4" />
          </button>
        </div>
      ))}
      <button
        type="button"
        onClick={add}
        className="flex items-center gap-1 text-xs font-medium text-brand-500 hover:text-brand-600 transition-colors"
      >
        <Plus className="h-3.5 w-3.5" /> Add item
      </button>

      {/* Quick-create a product from an unlinked line (finish setup later). */}
      {createFromRow != null && items[createFromRow] && (
        <InlineCreateProductModal
          isOpen
          onClose={() => setCreateFromRow(null)}
          initialName={items[createFromRow].description}
          // Case-priced lines seed the product with PER-PIECE numbers — the
          // product contract is per piece (costPerSellingUnit multiplies back).
          initialPrice={
            parseFloat(items[createFromRow].unitCost) > 0
              ? roundMoney(
                  (parseFloat(items[createFromRow].unitCost) /
                    Math.max(1, parseInt(items[createFromRow].packSize, 10) || 1)) *
                    1.3,
                )
              : undefined
          }
          initialCost={
            parseFloat(items[createFromRow].unitCost) > 0
              ? parseFloat(items[createFromRow].unitCost) /
                Math.max(1, parseInt(items[createFromRow].packSize, 10) || 1)
              : undefined
          }
          onCreated={(product) => {
            const i = createFromRow;
            const rawDescription = items[i].description;
            update(i, { productId: product.id, description: product.name });
            if (supplierName && rawDescription) {
              saveMapping.mutate({ supplierName, rawDescription, productId: product.id });
            }
            setCreateFromRow(null);
          }}
        />
      )}
    </div>
  );
}

// ─── Page ─────────────────────────────────────────────────────────────────────

export default function VendorBillDetailPage({ params }: { params: { id: string } }) {
  const { setTitle } = usePageTitle();
  const { toast } = useToast();

  const { data: bill, isLoading, isError } = useVendorBill(params.id);
  const receiveBill = useReceiveVendorBill();
  const voidBill = useVoidVendorBill();
  const recordPayment = useRecordVendorBillPayment();
  const revertToDraft = useRevertVendorBillToDraft();
  const updateBill = useUpdateVendorBill();

  const { data: suppliersData } = useSuppliers();
  const suppliers: Array<{ id: string; name: string }> = suppliersData ?? [];

  const { data: prefs } = usePreferences();
  const savePrefs = useSavePreferences();

  const [isPaymentOpen, setIsPaymentOpen] = React.useState(false);
  const [isVoidOpen, setIsVoidOpen] = React.useState(false);
  const [isRevertOpen, setIsRevertOpen] = React.useState(false);
  const [isReceiveOpen, setIsReceiveOpen] = React.useState(false);
  // Variant-split modal (PR-D) — set from a line's "Generic — split into
  // variants?" badge. The badge only carries the product id + this line's
  // received qty; the full product (currentStock/averageCost/unitsPerBox/
  // costingMethod) is fetched on demand once a target is picked, same as the
  // product detail page does for itself.
  const [variantSplitProductId, setVariantSplitProductId] = React.useState<string | null>(null);
  const [variantSplitPool, setVariantSplitPool] = React.useState(0);
  const { data: variantSplitProduct } = useProduct(variantSplitProductId ?? "");
  const [unlinkedConfirm, setUnlinkedConfirm] = React.useState<UnlinkedItemsError | null>(null);
  // The per-line quantities chosen in the receive modal — kept so the
  // UNLINKED_ITEMS confirm retry re-sends the same partial plan.
  const [pendingReceiveItems, setPendingReceiveItems] = React.useState<
    ReceiveVendorBillLine[] | undefined
  >(undefined);

  // Edit mode state
  const [isEditing, setIsEditing] = React.useState(false);
  const [editSupplierId, setEditSupplierId] = React.useState("");
  const [editBillDate, setEditBillDate] = React.useState("");
  const [editDueDate, setEditDueDate] = React.useState("");
  const [editNotes, setEditNotes] = React.useState("");
  const [editItems, setEditItems] = React.useState<EditLineItemRow[]>([]);

  React.useEffect(() => {
    if (bill) setTitle(bill.billNumber);
  }, [bill, setTitle]);

  // Initialise edit form from bill data
  const startEditing = React.useCallback(() => {
    if (!bill) return;
    setEditSupplierId(bill.supplierId);
    setEditBillDate(bill.billDate ? bill.billDate.slice(0, 10) : "");
    setEditDueDate(bill.dueDate ? bill.dueDate.slice(0, 10) : "");
    setEditNotes(bill.notes ?? "");
    setEditItems(
      (bill.items ?? []).map((item) => ({
        productId: item.productId ?? "",
        description: item.description,
        qty: String(item.qty),
        unitCost: String(item.unitCost),
        packSize: item.packSize != null && item.packSize > 1 ? String(item.packSize) : "",
        sku: item.sku ?? null,
        lineTotal: item.lineTotal != null ? Number(item.lineTotal) : null,
      })),
    );
    setIsEditing(true);
  }, [bill]);

  if (isLoading) {
    return (
      <div className="flex items-center justify-center p-12">
        <Loader2 className="h-8 w-8 animate-spin text-navy/70" />
      </div>
    );
  }

  if (isError || !bill) {
    return (
      <div className="flex flex-col items-center gap-4 p-12 text-center">
        <p className="text-base font-medium text-navy">Vendor bill not found.</p>
        <Button variant="secondary" href="/purchases">
          Back to Vendor Bills
        </Button>
      </div>
    );
  }

  const total = Number(bill.totalOwed ?? 0);
  const amountPaid = Number(bill.totalPaid ?? 0);
  const balance = Math.max(0, total - amountPaid);
  const payments: VendorBillPayment[] = bill.payments ?? [];
  const status = bill.status;

  const isOverdue =
    !!bill.dueDate &&
    status !== "PAID" &&
    status !== "VOID" &&
    new Date(bill.dueDate) < new Date(new Date().toDateString());

  // Lines not linked to a product don't update stock or average costs when received.
  const billItems = bill.items ?? [];
  const unlinkedCount = billItems.filter((i) => !i.productId).length;

  // Receive affordance: DRAFT bills, paid-first bills that were never received
  // (recordPayment overwrites status — receipt truth is receivedDate), and
  // partially received bills with quantity still outstanding. Legacy received
  // bills (no per-line tracking) count as fully received.
  const outstandingQty = billItems
    .filter((i) => i.productId)
    .reduce((sum, i) => sum + lineRemaining(bill, i), 0);
  const canReceive =
    status !== "VOID" && (bill.receivedDate == null ? status !== "RECEIVED" : outstandingQty > 0);
  const receiveLabel = bill.receivedDate ? "Receive remaining" : "Mark Received";

  // ── Action handlers ──────────────────────────────────────────────────────────

  const handleReceive = (acknowledgeUnlinked = false, items?: ReceiveVendorBillLine[]) => {
    receiveBill.mutate(
      { id: bill.id, acknowledgeUnlinked, items },
      {
        onSuccess: (updated) => {
          setUnlinkedConfirm(null);
          setIsReceiveOpen(false);
          setPendingReceiveItems(undefined);
          const partial = updated?.status === "PARTIAL";
          toast({
            title: partial ? "Partial delivery received" : "Bill marked as received",
            description: partial
              ? `Stock updated for what arrived — the rest of bill ${bill.billNumber} stays outstanding.`
              : `Bill ${bill.billNumber} is now in Received status.`,
            variant: "success",
          });
        },
        onError: (err: any) => {
          // Unmapped lines → show the confirm dialog listing what gets skipped
          const unlinked = getUnlinkedItemsError(err);
          if (unlinked) {
            setUnlinkedConfirm(unlinked);
            return;
          }
          toast({
            title: "Failed to mark received",
            description: err?.response?.data?.message ?? "Please try again.",
            variant: "error",
          });
        },
      },
    );
  };

  const handleVoid = () => {
    voidBill.mutate(bill.id, {
      onSuccess: () => {
        setIsVoidOpen(false);
        toast({
          title: "Bill voided",
          description: `Bill ${bill.billNumber} has been voided.`,
          variant: "info",
        });
      },
      onError: () => {
        toast({ title: "Failed to void bill", description: "Please try again.", variant: "error" });
      },
    });
  };

  const handleRevertToDraft = () => {
    revertToDraft.mutate(bill.id, {
      onSuccess: () => {
        setIsRevertOpen(false);
        toast({
          title: "Bill reverted to draft",
          description: `Bill ${bill.billNumber} is now in Draft status. Inventory has been reversed.`,
          variant: "success",
        });
      },
      onError: (err: any) => {
        setIsRevertOpen(false);
        toast({
          title: "Failed to revert bill",
          description: err?.response?.data?.message ?? "Please try again.",
          variant: "error",
        });
      },
    });
  };

  const handleSaveEdit = () => {
    const items: CreateVendorBillItem[] = editItems
      .filter((row) => row.description.trim() && parseFloat(row.qty) > 0)
      .map((row) => {
        const pack = parseInt(row.packSize, 10);
        return {
          productId: row.productId || undefined,
          description: row.description.trim(),
          qty: parseFloat(row.qty),
          unitCost: parseFloat(row.unitCost) || 0,
          // Preserve the scan-captured fields — the server recreates lines on
          // every edit, so anything not resent is lost.
          ...(pack > 1 ? { packSize: pack } : {}),
          ...(row.sku ? { sku: row.sku } : {}),
          ...(row.lineTotal != null ? { lineTotal: row.lineTotal } : {}),
        };
      });

    updateBill.mutate(
      {
        id: bill.id,
        supplierId: editSupplierId,
        billDate: editBillDate || undefined,
        dueDate: editDueDate || undefined,
        notes: editNotes.trim() || undefined,
        items,
      },
      {
        onSuccess: () => {
          setIsEditing(false);
          toast({ title: "Bill updated", variant: "success" });
        },
        onError: (err: any) => {
          toast({
            title: "Failed to update bill",
            description: err?.response?.data?.message ?? "Please try again.",
            variant: "error",
          });
        },
      },
    );
  };

  const handleRecordPayment = (data: PaymentFormState) => {
    recordPayment.mutate(
      {
        id: bill.id,
        method: data.method,
        amount: parseFloat(data.amount),
        reference: data.reference.trim() || undefined,
        notes: data.notes.trim() || undefined,
      },
      {
        onSuccess: () => {
          setIsPaymentOpen(false);
          savePrefs.mutate({ "payment.lastMethod": data.method });
          toast({
            title: "Payment recorded",
            description: `Payment of ${fmt(parseFloat(data.amount))} recorded.`,
            variant: "success",
          });
        },
        onError: () => {
          toast({
            title: "Failed to record payment",
            description: "Please try again.",
            variant: "error",
          });
        },
      },
    );
  };

  // ── Computed edit total ───────────────────────────────────────────────────────
  const editTotal = editItems.reduce(
    (s, row) => s + (parseFloat(row.qty) || 0) * (parseFloat(row.unitCost) || 0),
    0,
  );

  return (
    <div className="space-y-5 p-6">
      {/* Back */}
      <Link
        href="/purchases"
        className="flex items-center gap-1.5 text-sm text-navy/70 hover:text-navy transition-colors"
      >
        <ArrowLeft className="h-4 w-4" />
        Vendor Bills
      </Link>

      {/* Header */}
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <div className="flex flex-wrap items-center gap-2.5">
            <h1 className="mono text-2xl font-bold text-navy">{bill.billNumber}</h1>
            {status === "DRAFT" && unlinkedCount > 0 && (
              <span className="inline-flex items-center rounded-full bg-amber-100 px-2.5 py-0.5 text-xs font-semibold text-amber-800">
                {unlinkedCount} unlinked {unlinkedCount === 1 ? "item" : "items"}
              </span>
            )}
            <Badge status={status} />
            {isOverdue && (
              <span className="inline-flex items-center rounded-full bg-red-100 px-2.5 py-0.5 text-xs font-semibold text-red-700">
                Overdue
              </span>
            )}
          </div>
          <p className="mt-1.5 text-sm text-navy/70">
            {bill.supplier?.name ?? "—"} · billed {fmtDate(bill.billDate ?? bill.createdAt)}
            {bill.dueDate && ` · due ${fmtDate(bill.dueDate)}`}
          </p>
        </div>

        {/* Action buttons based on status */}
        <div className="flex flex-wrap items-center gap-2">
          {status === "DRAFT" && !isEditing && (
            <>
              <Button
                size="sm"
                variant="secondary"
                leftIcon={<Pencil className="h-4 w-4" />}
                onClick={startEditing}
              >
                Edit
              </Button>
              <Button
                size="sm"
                leftIcon={<PackageCheck className="h-4 w-4" />}
                onClick={() => setIsReceiveOpen(true)}
                loading={receiveBill.isPending}
              >
                Mark Received
              </Button>
              <Button
                size="sm"
                variant="danger"
                leftIcon={<Ban className="h-4 w-4" />}
                onClick={() => setIsVoidOpen(true)}
              >
                Void
              </Button>
            </>
          )}

          {status === "DRAFT" && isEditing && (
            <>
              <Button
                size="sm"
                variant="secondary"
                leftIcon={<X className="h-4 w-4" />}
                onClick={() => setIsEditing(false)}
                disabled={updateBill.isPending}
              >
                Cancel
              </Button>
              <Button
                size="sm"
                leftIcon={<Save className="h-4 w-4" />}
                onClick={handleSaveEdit}
                loading={updateBill.isPending}
              >
                Save Changes
              </Button>
            </>
          )}

          {(status === "RECEIVED" || status === "PARTIAL") && (
            <>
              {canReceive && (
                <Button
                  size="sm"
                  leftIcon={<PackageCheck className="h-4 w-4" />}
                  onClick={() => setIsReceiveOpen(true)}
                  loading={receiveBill.isPending}
                >
                  {receiveLabel}
                </Button>
              )}
              <Button
                size="sm"
                variant="secondary"
                leftIcon={<RotateCcw className="h-4 w-4" />}
                onClick={() => setIsRevertOpen(true)}
                disabled={revertToDraft.isPending}
              >
                Revert to Draft
              </Button>
              <Button
                size="sm"
                leftIcon={<CreditCard className="h-4 w-4" />}
                onClick={() => setIsPaymentOpen(true)}
              >
                Record Payment
              </Button>
            </>
          )}

          {status === "PAID" &&
            (canReceive ? (
              <Button
                size="sm"
                leftIcon={<PackageCheck className="h-4 w-4" />}
                onClick={() => setIsReceiveOpen(true)}
                loading={receiveBill.isPending}
              >
                {receiveLabel}
              </Button>
            ) : (
              <span className="text-sm italic text-navy/70">This bill is fully paid.</span>
            ))}

          {status === "VOID" && (
            <span className="text-sm italic text-navy/70">This bill is void.</span>
          )}
        </div>
      </div>

      {/* Unmapped-items warning: costs only sync for product-linked lines */}
      {status === "DRAFT" &&
        ((bill.items ?? []).length === 0 || (bill.items ?? []).some((i) => !i.productId)) && (
          <div className="flex items-start gap-2.5 rounded-lg border border-amber-300 bg-amber-50 px-4 py-3 text-sm text-amber-900">
            <PackageCheck className="mt-0.5 h-4 w-4 shrink-0" />
            <p>
              {(bill.items ?? []).length === 0
                ? "This bill has no line items — receiving it will not update any inventory or product costs. "
                : "Some line items are not linked to a product and will not update inventory or costs when received. "}
              Use <span className="font-semibold">Edit</span> to map items to products so average
              costs stay accurate.
            </p>
          </div>
        )}

      <div className="grid grid-cols-1 gap-5 lg:grid-cols-3">
        {/* ── Bill detail (2/3) ── */}
        <div className="space-y-5 lg:col-span-2">
          <Card>
            {/* Supplier info & dates — view or edit mode */}
            {isEditing ? (
              <div className="mb-6 space-y-4">
                <div className="grid grid-cols-2 gap-4">
                  <div>
                    <label className="mb-1 block text-xs font-semibold uppercase tracking-wider text-navy/70">
                      Supplier
                    </label>
                    <SupplierSelect
                      value={editSupplierId}
                      onChange={setEditSupplierId}
                      suppliers={suppliers}
                      placeholder="Select supplier…"
                      className="h-10"
                    />
                  </div>
                  <div className="grid grid-cols-2 gap-2">
                    <div>
                      <label className="mb-1 block text-xs font-semibold uppercase tracking-wider text-navy/70">
                        Bill Date
                      </label>
                      <input
                        type="date"
                        value={editBillDate}
                        onChange={(e) => setEditBillDate(e.target.value)}
                        className="h-10 w-full rounded-lg border border-surface-border bg-white px-3 text-sm text-navy focus:outline-none focus:ring-2 focus:ring-brand-500"
                      />
                    </div>
                    <div>
                      <label className="mb-1 block text-xs font-semibold uppercase tracking-wider text-navy/70">
                        Due Date
                      </label>
                      <input
                        type="date"
                        value={editDueDate}
                        onChange={(e) => setEditDueDate(e.target.value)}
                        className="h-10 w-full rounded-lg border border-surface-border bg-white px-3 text-sm text-navy focus:outline-none focus:ring-2 focus:ring-brand-500"
                      />
                    </div>
                  </div>
                </div>
                <div>
                  <label className="mb-1 block text-xs font-semibold uppercase tracking-wider text-navy/70">
                    Notes
                  </label>
                  <textarea
                    rows={2}
                    value={editNotes}
                    onChange={(e) => setEditNotes(e.target.value)}
                    placeholder="Internal notes…"
                    className="w-full resize-none rounded-lg border border-surface-border bg-white px-3 py-2 text-sm text-navy placeholder:text-navy/30 focus:outline-none focus:ring-2 focus:ring-brand-500"
                  />
                </div>
              </div>
            ) : (
              <div className="mb-6 grid grid-cols-2 gap-6">
                <div>
                  <p className="mb-1 text-xs font-semibold uppercase tracking-wider text-navy/70">
                    Supplier
                  </p>
                  <p className="text-sm font-semibold text-navy">{bill.supplier?.name ?? "—"}</p>
                  {bill.supplier?.contactName && (
                    <p className="text-sm text-navy/70">{bill.supplier.contactName}</p>
                  )}
                  {bill.supplier?.address && (
                    <p className="mt-1 text-xs text-navy/70 whitespace-pre-line">
                      {bill.supplier.address}
                    </p>
                  )}
                </div>
                <div>
                  <p className="mb-1 text-xs font-semibold uppercase tracking-wider text-navy/70">
                    Bill Details
                  </p>
                  <p className="text-sm text-navy/70">
                    <span className="font-medium text-navy">Bill #:</span> {bill.billNumber}
                  </p>
                  {bill.purchaseOrder && (
                    <p className="text-sm text-navy/70">
                      <span className="font-medium text-navy">PO #:</span>{" "}
                      {bill.purchaseOrder.poNumber}
                    </p>
                  )}
                  <p className="text-sm text-navy/70">
                    <span className="font-medium text-navy">Bill Date:</span>{" "}
                    {fmtDate(bill.billDate ?? bill.createdAt)}
                  </p>
                  <p
                    className={cn(
                      "text-sm",
                      isOverdue ? "text-red-600 font-semibold" : "text-navy/70",
                    )}
                  >
                    <span className="font-medium text-navy">Due Date:</span> {fmtDate(bill.dueDate)}
                    {isOverdue && " (Overdue)"}
                  </p>
                </div>
              </div>
            )}

            {/* Line items — view or edit mode */}
            {isEditing ? (
              <div className="border-t border-surface-border pt-4">
                <p className="mb-3 text-xs font-semibold uppercase tracking-wider text-navy/70">
                  Line Items
                </p>
                <EditLineItems
                  items={editItems}
                  onChange={setEditItems}
                  supplierName={bill.supplier?.name}
                />
                <div className="mt-3 flex justify-end">
                  <span className="text-sm font-bold text-navy">Total: {fmt(editTotal)}</span>
                </div>
              </div>
            ) : (
              <div className="border-t border-surface-border pt-4">
                <div className="mb-3 flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
                  <p className="overline">Line Items</p>
                  <span className="text-xs text-navy/70">
                    unlinked lines don&apos;t update stock or costs until mapped
                  </span>
                </div>
                <div className="-mx-6 overflow-x-auto">
                  <table className="w-full min-w-[560px] border-t border-surface-border text-sm">
                    <thead className="border-b border-surface-border bg-surface-raised">
                      <tr>
                        <th className="px-6 py-2.5 text-left text-xs font-medium text-navy/70">
                          Bill Line (as scanned)
                        </th>
                        <th className="px-4 py-2.5 text-left text-xs font-medium text-navy/70">
                          Mapped Product
                        </th>
                        <th className="px-4 py-2.5 text-right text-xs font-medium text-navy/70">
                          Qty
                        </th>
                        <th className="px-4 py-2.5 text-right text-xs font-medium text-navy/70">
                          Unit Cost
                        </th>
                        <th className="px-6 py-2.5 text-right text-xs font-medium text-navy/70">
                          Amount
                        </th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-surface-border">
                      {billItems.map((item) => {
                        const unlinked = !item.productId;
                        // Undefined unless this line's mapped product is a
                        // splittable generic (has variants, isn't itself one).
                        const variantHint = item.product
                          ? (item.product as NonNullable<VendorBillItem["product"]> &
                              MappedProductVariantHint)
                          : undefined;
                        const showVariantHint =
                          !!variantHint &&
                          !variantHint.parentProductId &&
                          !!variantHint._count?.variants;
                        return (
                          <tr
                            key={item.id}
                            className={cn(
                              unlinked
                                ? "bg-amber-50 shadow-[inset_3px_0_0_theme(colors.amber.400)]"
                                : "hover:bg-surface-raised",
                            )}
                          >
                            <td className="px-6 py-3 text-navy">
                              <span className="inline-flex items-start gap-1.5">
                                {unlinked && (
                                  <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-amber-600" />
                                )}
                                <span>{item.description}</span>
                              </span>
                            </td>
                            <td className="px-4 py-3">
                              {item.product ? (
                                <div className="space-y-1">
                                  <span className="inline-flex items-center gap-1.5 text-navy">
                                    <CheckCircle2 className="h-3.5 w-3.5 shrink-0 text-success" />
                                    {item.product.name}
                                  </span>
                                  {showVariantHint && (
                                    <button
                                      type="button"
                                      onClick={() => {
                                        setVariantSplitProductId(variantHint!.id);
                                        setVariantSplitPool(lineReceivedBaseUnits(bill, item));
                                      }}
                                      title="This generic has variants — optionally split the stock received on this line into them. Never required; unsplit units simply stay on the generic."
                                      className="block rounded-full bg-amber-100 px-2 py-0.5 text-[11px] font-semibold text-amber-800 transition-colors hover:bg-amber-200"
                                    >
                                      Generic — split into variants?
                                    </button>
                                  )}
                                </div>
                              ) : (
                                <span className="text-xs font-medium text-amber-700">
                                  Not mapped
                                </span>
                              )}
                            </td>
                            <td className="px-4 py-3 text-right text-navy/70">
                              {item.qty}
                              {(item.packSize ?? 0) > 1 && (
                                <span className="block text-[11px] text-navy/50">
                                  × {item.packSize} pcs
                                </span>
                              )}
                              {item.qtyReceived != null &&
                                Number(item.qtyReceived) < Number(item.qty) && (
                                  <span className="block text-[11px] font-medium text-amber-700">
                                    {Number(item.qtyReceived)} received
                                  </span>
                                )}
                            </td>
                            <td className="px-4 py-3 text-right text-navy/70">
                              <span className="money">{fmt(Number(item.unitCost))}</span>
                              {(item.packSize ?? 0) > 1 && (
                                <span className="block text-[11px] text-navy/50">per case</span>
                              )}
                            </td>
                            <td className="px-6 py-3 text-right text-navy">
                              <span className="money">
                                {fmt(Number(item.qty) * Number(item.unitCost))}
                              </span>
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
                {unlinkedCount > 0 && (
                  <p className="mt-3 flex items-start gap-1.5 text-xs text-navy/70">
                    <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-amber-600" />
                    {unlinkedCount} {unlinkedCount === 1 ? "line is" : "lines are"} not mapped to a
                    product. Use <span className="font-semibold text-navy">Edit</span> to map them
                    so average costs stay accurate.
                  </p>
                )}
              </div>
            )}

            {/* Totals */}
            {!isEditing && (
              <div className="mt-4 border-t border-surface-border pt-4">
                <div className="ml-auto w-56 space-y-2 text-sm">
                  <div className="flex justify-between border-t border-surface-border pt-2 text-base font-bold text-navy">
                    <span>Total</span>
                    <span>{fmt(total)}</span>
                  </div>
                  {amountPaid > 0 && (
                    <div className="flex justify-between text-success">
                      <span className="font-medium">Amount Paid</span>
                      <span className="font-bold">-{fmt(amountPaid)}</span>
                    </div>
                  )}
                  <div
                    className={cn(
                      "flex justify-between border-t border-surface-border pt-2 text-base font-bold",
                      balance > 0 ? "text-danger" : "text-success",
                    )}
                  >
                    <span>Balance Due</span>
                    <span>{fmt(balance)}</span>
                  </div>
                </div>
              </div>
            )}

            {/* Notes */}
            {!isEditing && bill.notes && (
              <div className="mt-4 border-t border-surface-border pt-4">
                <p className="mb-1 text-xs font-semibold uppercase tracking-wider text-navy/70">
                  Notes
                </p>
                <p className="text-sm text-navy/70 whitespace-pre-line">{bill.notes}</p>
              </div>
            )}
          </Card>
        </div>

        {/* ── Sidebar (1/3) ── */}
        <div className="space-y-4">
          {/* Payment history */}
          <Card title="Payment History">
            {payments.length === 0 ? (
              <p className="text-sm text-navy/70">No payments recorded.</p>
            ) : (
              <ul className="-mx-6 -mb-6 divide-y divide-surface-border">
                {payments.map((pmt) => (
                  <li key={pmt.id} className="flex items-start gap-3 px-6 py-4">
                    <div className="mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-success-bg">
                      <CheckCircle2 className="h-4 w-4 text-success" />
                    </div>
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center justify-between gap-2">
                        <span className="text-sm font-semibold text-navy">
                          {fmt(Number(pmt.amount))}
                        </span>
                        <span className="text-xs text-navy/70">{fmtDate(pmt.createdAt)}</span>
                      </div>
                      <p className="mt-0.5 text-xs text-navy/70">
                        {paymentMethodLabel(pmt.method)}
                        {pmt.reference && ` · ${pmt.reference}`}
                      </p>
                      {pmt.notes && <p className="mt-0.5 text-xs text-navy/70">{pmt.notes}</p>}
                    </div>
                  </li>
                ))}
              </ul>
            )}
            {(status === "RECEIVED" || status === "PARTIAL") && !isEditing && (
              <div className="mt-4">
                <Button
                  variant="secondary"
                  size="sm"
                  className="w-full"
                  leftIcon={<CreditCard className="h-4 w-4" />}
                  onClick={() => setIsPaymentOpen(true)}
                >
                  Record Payment
                </Button>
              </div>
            )}
          </Card>

          {/* Bill summary (KV) */}
          <Card title="Bill">
            <dl className="text-sm">
              <div className="flex justify-between gap-3 border-b border-surface-border py-2">
                <dt className="text-navy/70">Supplier</dt>
                <dd className="text-right font-medium text-navy">{bill.supplier?.name ?? "—"}</dd>
              </div>
              <div className="flex justify-between gap-3 border-b border-surface-border py-2">
                <dt className="text-navy/70">Bill date</dt>
                <dd className="text-right font-medium text-navy">
                  {fmtDate(bill.billDate ?? bill.createdAt)}
                </dd>
              </div>
              <div className="flex justify-between gap-3 border-b border-surface-border py-2">
                <dt className="text-navy/70">Due date</dt>
                <dd
                  className={cn("text-right font-medium", isOverdue ? "text-danger" : "text-navy")}
                >
                  {fmtDate(bill.dueDate)}
                </dd>
              </div>
              <div className="flex justify-between gap-3 border-b border-surface-border py-2">
                <dt className="text-navy/70">Total</dt>
                <dd className="money text-right font-semibold text-navy">
                  {fmt(isEditing ? editTotal : total)}
                </dd>
              </div>
              {!isEditing && (
                <div className="flex justify-between gap-3 py-2">
                  <dt className="text-navy/70">Balance</dt>
                  <dd
                    className={cn(
                      "money text-right font-semibold",
                      balance > 0 ? "text-danger" : "text-success",
                    )}
                  >
                    {fmt(balance)}
                  </dd>
                </div>
              )}
            </dl>
          </Card>
        </div>
      </div>

      {/* Modals */}
      <RecordPaymentModal
        isOpen={isPaymentOpen}
        onClose={() => setIsPaymentOpen(false)}
        onRecord={handleRecordPayment}
        balance={balance}
        isPending={recordPayment.isPending}
        defaultMethod={(prefs?.["payment.lastMethod"] as PaymentFormState["method"]) ?? "ACH"}
      />

      <VoidConfirmModal
        isOpen={isVoidOpen}
        onClose={() => setIsVoidOpen(false)}
        onConfirm={handleVoid}
        billNumber={bill.billNumber}
        isPending={voidBill.isPending}
      />

      <RevertToDraftModal
        isOpen={isRevertOpen}
        onClose={() => setIsRevertOpen(false)}
        onConfirm={handleRevertToDraft}
        billNumber={bill.billNumber}
        isPending={revertToDraft.isPending}
      />

      <ReceiveBillModal
        bill={bill}
        isOpen={isReceiveOpen}
        onClose={() => setIsReceiveOpen(false)}
        onConfirm={(items) => {
          setPendingReceiveItems(items);
          handleReceive(false, items);
        }}
        isPending={receiveBill.isPending}
      />

      <UnlinkedItemsModal
        payload={unlinkedConfirm}
        onClose={() => setUnlinkedConfirm(null)}
        onConfirm={() => handleReceive(true, pendingReceiveItems)}
        isPending={receiveBill.isPending}
      />

      {/* Variant-split modal (PR-D) — same component as the product detail
          page and the Inventory Stock tab row action. Pool = this line's
          received qty (converted to pieces), not the parent's full stock, so
          splitting one bill doesn't offer up stock another line contributed.
          Always skippable — never blocks receiving. */}
      {variantSplitProductId && variantSplitProduct && (
        <VariantSplitModal
          parent={{
            id: variantSplitProduct.id,
            name: variantSplitProduct.name,
            currentStock: Number(variantSplitProduct.currentStock ?? 0),
            averageCost:
              variantSplitProduct.averageCost != null
                ? Number(variantSplitProduct.averageCost)
                : null,
            unitsPerBox: variantSplitProduct.unitsPerBox ?? null,
            costingMethod: variantSplitProduct.costingMethod,
          }}
          pool={variantSplitPool}
          onClose={() => setVariantSplitProductId(null)}
          onSuccess={() => setVariantSplitProductId(null)}
        />
      )}
    </div>
  );
}
