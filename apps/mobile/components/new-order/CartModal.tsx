// #2339: moved verbatim out of NewOrderScreen.tsx (a behaviour-preserving prefactor).
import { useMemo, useState, type ReactNode } from "react";
import { Modal, Pressable, ScrollView, Text, TextInput, View } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { ios } from "@routeflow/ui/tokens";
import { type UnitOption } from "../../lib/unit-options";
import { POS_COPY, posCartSaveLabel } from "../../lib/pos-mode";
import { type LineState, type Product } from "../../lib/cart-line-state";
import { CartRow } from "../CartRow";
import { CartStepperRow } from "../CartStepperRow";
import { type CustomerPriceHistory } from "../../lib/api/orders";
import { computeLineSubtotal } from "@routeflow/pricing";
import { type InvoiceSplitPreview } from "../../lib/invoice-split";
import { MoneyTextInput } from "../MoneyTextInput";
import { fmtCalendarDate } from "../../lib/format-date";
import { styles } from "./styles";
import type { UnlistedLine, OrderOptions, CreditPicker } from "./types";

/** Collapsed-by-default disclosure inside the cart sheet. */
function CartSection({
  icon,
  title,
  summary,
  children,
}: {
  icon: keyof typeof Ionicons.glyphMap;
  title: string;
  summary?: string;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  return (
    <View style={styles.cartSection}>
      <Pressable
        style={styles.optionsHeader}
        onPress={() => setOpen((o) => !o)}
        accessibilityRole="button"
        accessibilityState={{ expanded: open }}
      >
        <Ionicons name={icon} size={16} color={ios.brand} />
        <Text style={styles.optionsTitle}>{title}</Text>
        <Text style={styles.optionsSummary} numberOfLines={1}>
          {open ? "" : (summary ?? "")}
        </Text>
        <Ionicons name={open ? "chevron-up" : "chevron-down"} size={16} color={ios.label3} />
      </Pressable>
      {open ? <View style={styles.optionsBody}>{children}</View> : null}
    </View>
  );
}

function OrderOptionsSection({ options: o }: { options: OrderOptions }) {
  const summary = [
    o.posMode ? "POS mode" : null,
    !o.posMode && o.urgent ? "Urgent" : null,
    // ROUTE is the default majority — only call it out when it isn't.
    !o.posMode && o.fulfillPath === "SHIP" ? "Ship via carrier" : null,
    o.orderDate ? `Dated ${o.orderDate}` : null,
    !o.posMode && o.deliveryDate ? `Deliver ${o.deliveryDate}` : null,
    parseFloat(o.discountRaw) > 0 ? `-$${parseFloat(o.discountRaw).toFixed(2)}` : null,
    parseFloat(o.shippingFeeRaw) > 0
      ? `+$${parseFloat(o.shippingFeeRaw).toFixed(2)} shipping`
      : null,
    o.notes.trim() ? "Notes" : null,
  ]
    .filter(Boolean)
    .join(" · ");

  return (
    <CartSection icon="options-outline" title="Order options" summary={summary}>
      {o.posMode ? null : (
        <>
          <Pressable style={styles.optionRow} onPress={o.onToggleUrgent}>
            <Ionicons
              name={o.urgent ? "flame" : "flame-outline"}
              size={18}
              color={o.urgent ? ios.system.orange : ios.label2}
            />
            <Text style={styles.optionLabel}>Urgent</Text>
            <View style={[styles.toggle, o.urgent && styles.toggleOn]}>
              <View style={[styles.toggleDot, o.urgent && styles.toggleDotOn]} />
            </View>
          </Pressable>
          <View style={styles.optionField}>
            <Text style={styles.optionLabel}>Fulfillment</Text>
            <View style={styles.fulfillRow}>
              <Pressable
                style={[styles.fulfillBtn, o.fulfillPath === "ROUTE" && styles.fulfillBtnActive]}
                onPress={() => o.onChangeFulfillPath("ROUTE")}
                accessibilityRole="button"
                accessibilityLabel="Delivery route"
                accessibilityState={{ selected: o.fulfillPath === "ROUTE" }}
              >
                <Text
                  style={[
                    styles.fulfillBtnText,
                    o.fulfillPath === "ROUTE" && styles.fulfillBtnTextActive,
                  ]}
                >
                  Delivery route
                </Text>
              </Pressable>
              <Pressable
                style={[styles.fulfillBtn, o.fulfillPath === "SHIP" && styles.fulfillBtnActive]}
                onPress={() => o.onChangeFulfillPath("SHIP")}
                accessibilityRole="button"
                accessibilityLabel="Ship via carrier"
                accessibilityState={{ selected: o.fulfillPath === "SHIP" }}
              >
                <Text
                  style={[
                    styles.fulfillBtnText,
                    o.fulfillPath === "SHIP" && styles.fulfillBtnTextActive,
                  ]}
                >
                  Ship via carrier
                </Text>
              </Pressable>
            </View>
            {o.fulfillPath === "SHIP" ? (
              <Text style={styles.optionHelp}>
                Ships via carrier — won't appear on delivery routes.
              </Text>
            ) : null}
          </View>
        </>
      )}
      {o.canBackdate ? (
        <View style={styles.optionField}>
          <Text style={styles.optionLabel}>Order date (backdate)</Text>
          <TextInput
            value={o.orderDate}
            onChangeText={o.onChangeOrderDate}
            placeholder="YYYY-MM-DD"
            placeholderTextColor={ios.label3}
            keyboardType="numbers-and-punctuation"
            style={styles.optionInput}
          />
          <Text style={styles.optionHelp}>
            The day the order actually happened. Leave blank for today.
          </Text>
        </View>
      ) : null}
      {o.posMode ? null : (
        <View style={styles.optionField}>
          <Text style={styles.optionLabel}>Delivery date</Text>
          <TextInput
            value={o.deliveryDate}
            onChangeText={o.onChangeDeliveryDate}
            placeholder="YYYY-MM-DD"
            placeholderTextColor={ios.label3}
            keyboardType="numbers-and-punctuation"
            style={styles.optionInput}
          />
        </View>
      )}
      <View style={styles.optionField}>
        <Text style={styles.optionLabel}>Order discount ($)</Text>
        <TextInput
          value={o.discountRaw}
          onChangeText={o.onChangeDiscount}
          placeholder="0.00"
          placeholderTextColor={ios.label3}
          keyboardType="decimal-pad"
          style={styles.optionInput}
        />
      </View>
      <View style={styles.optionField}>
        <Text style={styles.optionLabel}>Shipping fee ($)</Text>
        <TextInput
          value={o.shippingFeeRaw}
          onChangeText={o.onChangeShippingFee}
          placeholder="0.00 (optional)"
          placeholderTextColor={ios.label3}
          keyboardType="decimal-pad"
          style={styles.optionInput}
        />
      </View>
      <View style={styles.optionField}>
        <Text style={styles.optionLabel}>Notes</Text>
        <TextInput
          value={o.notes}
          onChangeText={o.onChangeNotes}
          placeholder="Delivery / handling notes…"
          placeholderTextColor={ios.label3}
          multiline
          style={[styles.optionInput, { minHeight: 60, textAlignVertical: "top" }]}
        />
      </View>
    </CartSection>
  );
}

/**
 * Open credit notes for this customer. Toggle only (no amount input on mobile);
 * a null amount means "up to the credit's remaining balance", resolved server-side.
 */
function ApplyCreditSection({ credits: c }: { credits: CreditPicker }) {
  const summary = c.selectedIds.length
    ? `${c.selectedIds.length} selected`
    : c.rows.length
      ? `${c.rows.length} available`
      : "None open";

  return (
    <CartSection icon="pricetag-outline" title="Apply credit" summary={summary}>
      {c.rows.length === 0 ? (
        <Text style={styles.optionsSummary}>No open credits for this customer.</Text>
      ) : (
        c.rows.map((cn) => {
          const remaining = Math.max(0, cn.amount - (cn.amountUsed ?? 0));
          const checked = c.selectedIds.includes(cn.id);
          return (
            <Pressable key={cn.id} style={styles.optionRow} onPress={() => c.onToggle(cn.id)}>
              <Ionicons
                name={checked ? "checkbox" : "square-outline"}
                size={20}
                color={checked ? ios.brand : ios.label2}
              />
              <View style={{ flex: 1 }}>
                <Text style={styles.optionLabel} numberOfLines={1}>
                  {cn.creditNoteNumber}
                  {cn.reason ? ` · ${cn.reason}` : ""}
                </Text>
                {cn.expiresAt ? (
                  <Text style={styles.optionsSummary}>Expires {fmtCalendarDate(cn.expiresAt)}</Text>
                ) : null}
              </View>
              <Text style={styles.optionLabel}>${remaining.toFixed(2)}</Text>
            </Pressable>
          );
        })
      )}
      <Pressable onPress={c.onCreateNew} hitSlop={6} style={styles.newCreditBtn}>
        <Ionicons name="add-circle-outline" size={14} color={ios.brand} />
        <Text style={styles.newCreditText}>New credit note</Text>
      </Pressable>
    </CartSection>
  );
}

/**
 * Slide-up sheet that lets the operator inspect every added line, tweak
 * box/piece counts (or qty for non-boxed), remove rows, and finally save.
 * The footer total/Confirm action stays in sync with this list because both
 * read from the same `items` + `productById` state in the parent.
 */
export function CartModal({
  open,
  items,
  productById,
  priceHistory,
  tierPriceFor,
  isSpecialFor,
  tierForProductId,
  marginFloorFor,
  unlisted,
  total,
  totalItems,
  invoiceSplit,
  saving,
  onClose,
  onChangeBoxes,
  onChangePieces,
  onChangeUnits,
  onChangeSellBy,
  onChangeUnit,
  onChangeQty,
  onChangePrice,
  onChangeNote,
  onToggleNote,
  showCostEye,
  floorAcked,
  onSellAnyway,
  onIncrement,
  onDecrement,
  onRemove,
  onChangeUnlistedQty,
  onChangeUnlistedPrice,
  onChangeUnlistedNote,
  onToggleUnlistedNote,
  onRemoveUnlisted,
  onAddUnlisted,
  onScanMore,
  options,
  credits,
  onSave,
}: {
  open: boolean;
  items: Record<string, LineState>;
  productById: Map<string, Product>;
  priceHistory?: CustomerPriceHistory;
  tierPriceFor: (p: Product) => number;
  /** SPECIAL (tier≠1) lines lock the price input — it's the customer's permanent price. */
  isSpecialFor: (p: Product) => boolean;
  /** units_v1: the EFFECTIVE numeric tier (1-5) for a product — `UnitPickerRow` resolves the
   *  ladder price at this tier, same source as `isSpecialFor`/`tierPriceFor`. */
  tierForProductId: (productId: string) => number;
  /** The customer's effective margin floor (fraction) for a product's category. */
  marginFloorFor: (p: Product) => number;
  unlisted: UnlistedLine[];
  total: number;
  totalItems: number;
  invoiceSplit: InvoiceSplitPreview;
  saving: boolean;
  onClose: () => void;
  onChangeBoxes: (id: string, n: number) => void;
  onChangePieces: (id: string, n: number) => void;
  /** Unit mode: total unit count, routed through setLineUnits. */
  onChangeUnits: (id: string, n: number) => void;
  onChangeSellBy: (id: string, sellBy: "case" | "unit") => void;
  /** units_v1: a `UnitPickerRow` choice, routed through setUnitLabel. */
  onChangeUnit: (id: string, option: UnitOption) => void;
  onChangeQty: (id: string, n: number) => void;
  onChangePrice: (id: string, value: number | null) => void;
  onChangeNote: (id: string, text: string) => void;
  onToggleNote: (id: string) => void;
  /** Whether this role may reveal cost/margin (seller roles only). */
  showCostEye: boolean;
  /** Product ids acked as "sell anyway" below the margin floor. */
  floorAcked: Set<string>;
  onSellAnyway: (id: string) => void;
  onIncrement: (id: string) => void;
  onDecrement: (id: string) => void;
  onRemove: (id: string) => void;
  onChangeUnlistedQty: (id: string, n: number) => void;
  onChangeUnlistedPrice: (id: string, value: number | null) => void;
  onChangeUnlistedNote: (id: string, text: string) => void;
  onToggleUnlistedNote: (id: string) => void;
  onRemoveUnlisted: (id: string) => void;
  onAddUnlisted: () => void;
  /** Leave the cart for scan mode. Symmetric with ScanOrderSheet's onReview. */
  onScanMore: () => void;
  /** Order-level fields; state stays in the parent so the payload is unchanged. */
  options: OrderOptions;
  credits: CreditPicker;
  onSave: (finish?: "invoice" | "confirm") => void;
}) {
  // R2: preserve SCAN order. `items` is a UUID-keyed Record whose insertion order
  // is first-scan order (a repeat scan updates the existing key in place, a new
  // scan appends), so iterate Object.entries as-is — no alphabetical re-sort, which
  // previously made scanned lines hard to verify against the (scan-ordered) invoice.
  const rows = useMemo(() => {
    const list: { id: string; product: Product; line: LineState }[] = [];
    for (const [id, line] of Object.entries(items)) {
      const product = productById.get(id);
      if (!product) continue;
      list.push({ id, product, line });
    }
    return list;
  }, [items, productById]);

  return (
    <Modal visible={open} animationType="slide" transparent onRequestClose={onClose}>
      <View style={styles.cartBackdrop}>
        <View style={styles.cartSheet}>
          {/* Header with close + title */}
          <View style={styles.cartHeader}>
            <Pressable onPress={onClose} hitSlop={8} style={styles.cartHeaderBtn}>
              <Ionicons name="chevron-down" size={22} color={ios.label2} />
            </Pressable>
            <Text style={styles.cartTitle}>Review order</Text>
            <Text style={styles.cartHeaderCount}>
              {totalItems} item{totalItems === 1 ? "" : "s"}
            </Text>
          </View>

          <ScrollView
            style={{ flex: 1 }}
            contentContainerStyle={{ paddingHorizontal: 16, paddingBottom: 16, gap: 10 }}
            showsVerticalScrollIndicator={false}
          >
            {rows.length === 0 && unlisted.length === 0 ? (
              <View style={[styles.center, { paddingVertical: 40 }]}>
                <Text style={styles.emptyText}>Cart is empty.</Text>
              </View>
            ) : (
              <>
                {rows.map(({ id, product, line }) => (
                  <CartRow
                    key={id}
                    product={product}
                    line={line}
                    catalogPrice={tierPriceFor(product)}
                    isSpecial={isSpecialFor(product)}
                    tier={tierForProductId(product.id)}
                    marginFloor={marginFloorFor(product)}
                    historyPrice={priceHistory?.[id]?.lastPrice}
                    onChangeBoxes={(n) => onChangeBoxes(id, n)}
                    onChangePieces={(n) => onChangePieces(id, n)}
                    onChangeUnits={(n) => onChangeUnits(id, n)}
                    onChangeSellBy={(v) => onChangeSellBy(id, v)}
                    onChangeUnit={(opt) => onChangeUnit(id, opt)}
                    onChangeQty={(n) => onChangeQty(id, n)}
                    onChangePrice={(raw) => onChangePrice(id, raw)}
                    onChangeNote={(t) => onChangeNote(id, t)}
                    onToggleNote={() => onToggleNote(id)}
                    showCostEye={showCostEye}
                    acked={floorAcked.has(id)}
                    onSellAnyway={() => onSellAnyway(id)}
                    onIncrement={() => onIncrement(id)}
                    onDecrement={() => onDecrement(id)}
                    onRemove={() => onRemove(id)}
                  />
                ))}
                {unlisted.map((u) => (
                  <UnlistedCartRow
                    key={u.id}
                    line={u}
                    onChangeQty={(n) => onChangeUnlistedQty(u.id, n)}
                    onChangePrice={(raw) => onChangeUnlistedPrice(u.id, raw)}
                    onChangeNote={(t) => onChangeUnlistedNote(u.id, t)}
                    onToggleNote={() => onToggleUnlistedNote(u.id)}
                    onRemove={() => onRemoveUnlisted(u.id)}
                  />
                ))}
              </>
            )}
            {invoiceSplit.willSplit ? (
              <View style={styles.splitBanner}>
                <Text style={styles.splitBannerHeader}>
                  SPLITS INTO {invoiceSplit.groups.length} INVOICES
                </Text>
                {invoiceSplit.groups.map((g, i) => (
                  <View key={g.label} style={styles.splitGroupRow}>
                    <Text style={styles.splitGroupLabel} numberOfLines={1}>
                      Invoice {i + 1} — {g.label} ({g.count} {g.count === 1 ? "item" : "items"})
                    </Text>
                    <Text style={styles.splitGroupAmount}>${g.subtotal.toFixed(2)}</Text>
                  </View>
                ))}
                <Text style={styles.splitFootnote}>
                  Regulated categories are billed on their own invoice. Amounts shown are pre-tax
                  subtotals.
                </Text>
              </View>
            ) : null}
            {/* Two ways back to adding items. "Scan more" is the exact inverse
                of ScanOrderSheet's "Review" — no nested modals, no new state. */}
            <View style={styles.cartAddRow}>
              <Pressable style={styles.cartAddUnlisted} onPress={onAddUnlisted} hitSlop={4}>
                <Ionicons name="add-circle-outline" size={16} color={ios.brand} />
                <Text style={styles.cartAddUnlistedText} numberOfLines={1}>
                  Add unlisted item
                </Text>
              </Pressable>
              <Pressable
                style={styles.cartAddUnlisted}
                onPress={onScanMore}
                hitSlop={4}
                accessibilityRole="button"
                accessibilityLabel="Scan more items"
              >
                <Ionicons name="barcode-outline" size={16} color={ios.brand} />
                <Text style={styles.cartAddUnlistedText} numberOfLines={1}>
                  Scan more
                </Text>
              </Pressable>
            </View>

            <OrderOptionsSection options={options} />
            <ApplyCreditSection credits={credits} />
          </ScrollView>

          {/* Sticky footer: total + actions */}
          <View style={styles.cartFooter}>
            <View style={styles.cartFooterRow}>
              <View>
                <Text style={styles.footerEyebrow}>ORDER TOTAL</Text>
                <Text style={styles.footerTotal}>${total.toFixed(2)}</Text>
              </View>
              <View style={{ flexDirection: "row", gap: 8 }}>
                <Pressable style={styles.cartContinueBtn} onPress={onClose} hitSlop={6}>
                  <Text style={styles.cartContinueText}>Keep adding</Text>
                </Pressable>
                {options.posMode ? (
                  <Pressable
                    style={styles.cartContinueBtn}
                    disabled={totalItems === 0 || saving}
                    onPress={() => onSave("confirm")}
                    hitSlop={6}
                    accessibilityRole="button"
                  >
                    <Text style={styles.cartContinueText}>{POS_COPY.confirmOnly}</Text>
                  </Pressable>
                ) : null}
                <Pressable
                  style={[
                    styles.confirmBtn,
                    (totalItems === 0 || saving) && styles.confirmBtnDisabled,
                  ]}
                  disabled={totalItems === 0 || saving}
                  onPress={() => onSave("invoice")}
                  accessibilityState={{ disabled: totalItems === 0 || saving }}
                >
                  <Text style={styles.confirmBtnText}>
                    {posCartSaveLabel(!!options.posMode, saving)}
                  </Text>
                  <Ionicons name="checkmark" size={14} color="#fff" />
                </Pressable>
              </View>
            </View>
          </View>
        </View>
      </View>
    </Modal>
  );
}

/** Cart row for an ad-hoc (unlisted) line: editable price + qty, "Custom" tag, no image. */
function UnlistedCartRow({
  line,
  onChangeQty,
  onChangePrice,
  onChangeNote,
  onToggleNote,
  onRemove,
}: {
  line: UnlistedLine;
  onChangeQty: (n: number) => void;
  onChangePrice: (value: number | null) => void;
  onChangeNote: (text: string) => void;
  onToggleNote: () => void;
  onRemove: () => void;
}) {
  const lineTotal = computeLineSubtotal({ unitPrice: line.unitPrice, qty: line.qty });
  return (
    <View style={styles.cartRow}>
      <View style={styles.cartRowHeader}>
        <View style={{ flex: 1, minWidth: 0 }}>
          <View style={styles.unlistedTagRow}>
            <Text style={styles.cartRowName} numberOfLines={2}>
              {line.name || "Unlisted item"}
            </Text>
            <View style={styles.customTag}>
              <Text style={styles.customTagText}>Custom</Text>
            </View>
          </View>
        </View>
        <Pressable onPress={onRemove} hitSlop={8} style={styles.cartRowRemove}>
          <Ionicons name="trash-outline" size={18} color={ios.system.redInk} />
        </Pressable>
      </View>

      <View style={styles.cartPriceRow}>
        <Text style={styles.cartPriceLabel}>Price</Text>
        <View style={styles.cartPriceInputWrap}>
          <Text style={styles.cartPriceCurrency}>$</Text>
          <MoneyTextInput
            style={[styles.cartPriceInput, styles.cartPriceInputActive]}
            value={line.unitPrice || null}
            onChangeValue={onChangePrice}
            placeholder="0.00"
            returnKeyType="done"
          />
        </View>
      </View>

      <CartStepperRow
        label="Qty"
        value={line.qty}
        onChange={onChangeQty}
        onIncrement={() => onChangeQty(line.qty + 1)}
        onDecrement={() => onChangeQty(Math.max(0, line.qty - 1))}
      />

      {/* Per-line note — carried onto the invoice line (buyer-visible). */}
      {line.noteOpen || line.note?.trim() ? (
        <TextInput
          value={line.note ?? ""}
          onChangeText={onChangeNote}
          placeholder="Flavor or note for this item (prints on invoice)"
          placeholderTextColor={ios.label3}
          maxLength={2000}
          multiline
          style={styles.cartNoteInput}
        />
      ) : (
        <Pressable onPress={onToggleNote} hitSlop={6} style={styles.cartNoteAdd}>
          <Ionicons name="create-outline" size={14} color={ios.brand} />
          <Text style={styles.cartNoteAddText}>Add flavor / note</Text>
        </Pressable>
      )}

      <View style={styles.cartRowFooter}>
        <Text style={styles.cartRowFooterLabel}>Line total</Text>
        <Text style={styles.cartRowFooterValue}>${lineTotal.toFixed(2)}</Text>
      </View>
    </View>
  );
}
