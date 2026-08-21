import { useEffect, useMemo, useRef, useState } from "react";
import { Pressable, StyleSheet, Text, TextInput, View } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { useLocalSearchParams, useRouter } from "expo-router";
import { ios } from "@routeflow/ui/tokens";
import {
  FormField,
  FormSection,
  FormSheet,
  FormTextInput,
} from "../../../../../components/FormSheet";
import { MoneyTextInput } from "../../../../../components/MoneyTextInput";
import { ProductPickerSheet } from "../../../../../components/ProductPickerSheet";
import { QtyStepper } from "../../../../../components/QtyStepper";
import {
  useAdminCustomer,
  useAdminInvoice,
  useBusinessSettings,
  type AdminProduct,
} from "../../../../../lib/api/admin";
import { useUpdateInvoice } from "../../../../../lib/api/invoices";
import { alertInfo } from "../../../../../lib/confirm";
import { ISO_DATE } from "../../../../../lib/invoice-terms";
import {
  computeInvoiceTotals,
  editedLineFreeUnits,
  invoiceLineDto,
  type InvoiceTotalsLine,
} from "../../../../../lib/invoice-totals";
import { isPendingOrderMirror } from "../../../../../lib/invoices-logic";
import { computeLineSubtotal } from "../../../../../lib/pricing";
import { showToast } from "../../../../../lib/toast";

/**
 * Invoice edit screen — DRAFT-only, mirroring web's invoices/[id]/edit page.
 *
 * The server's PATCH items path REPLACES every line (delete-and-recreate), so
 * this screen always sends the complete line array and must round-trip every
 * field it doesn't edit (per-line notes especially — dropping them from the
 * payload silently wipes them). Web's hydration rules, kept exactly:
 *  - a line is box-split ONLY when `boxes != null`, using the SALE-TIME
 *    `unitsPerBox` snapshot (never the live product — pack size may have changed);
 *  - qty stays in total pieces; the split is re-derived from cases + loose.
 */

type EditLine = {
  key: string;
  productId: string | null;
  description: string;
  /** Total pieces (boxes × unitsPerBox + pieces when split). */
  qty: number;
  boxes: number | null;
  pieces: number | null;
  unitsPerBox: number | null;
  /** Null while the operator has the field cleared — blocked at save. */
  unitPrice: number | null;
  discount: number | null;
  /** The STORED tax fraction — preserved so toggling taxable off/on round-trips
   *  a historic rate instead of stamping today's tenant rate over it. */
  taxRate: number;
  taxable: boolean;
  note: string;
  noteOpen?: boolean;
  /** BUY_N_GET_M snapshot carried from the order line — MONEY, not decoration:
   *  the PATCH replaces every line, so dropping it re-prices an agreed
   *  12-cases-2-free line from $350 to $420 on save. */
  promoFreeUnits: number | null;
  /** Whole selling units the snapshot was earned at, so a qty edit rescales it. */
  promoBaseUnits: number | null;
};

let lineSeq = 0;
function newKey(): string {
  lineSeq += 1;
  return `line-${lineSeq}`;
}

export default function EditInvoiceScreen() {
  const router = useRouter();
  const { id } = useLocalSearchParams<{ id: string }>();
  const { data: invoice, isLoading } = useAdminInvoice(id ?? "");
  const { data: settings } = useBusinessSettings();
  const { data: customer } = useAdminCustomer(invoice?.customer?.id ?? "");
  const updateMut = useUpdateInvoice();

  const isTaxExempt = !!customer?.isTaxExempt;
  const tenantTaxRate = (Number(settings?.taxRate) || 0) / 100;

  const [lines, setLines] = useState<EditLine[]>([]);
  const [issueDate, setIssueDate] = useState("");
  const [dueDate, setDueDate] = useState("");
  const [invDiscount, setInvDiscount] = useState<number | null>(null);
  const [shippingFee, setShippingFee] = useState<number | null>(null);
  const [referenceNumber, setReferenceNumber] = useState("");
  const [subject, setSubject] = useState("");
  const [notes, setNotes] = useState("");
  const [terms, setTerms] = useState("");
  const [pickerOpen, setPickerOpen] = useState(false);

  // Hydrate once per invoice id — refetches must not clobber in-progress edits.
  const hydratedFor = useRef<string | null>(null);
  useEffect(() => {
    if (!invoice || invoice.status !== "DRAFT" || hydratedFor.current === invoice.id) return;
    hydratedFor.current = invoice.id;
    setLines(
      (invoice.items ?? []).map((it) => ({
        key: newKey(),
        productId: it.productId ?? null,
        description: it.description,
        qty: Number(it.qty),
        boxes: it.boxes ?? null,
        pieces: it.boxes != null ? (it.pieces ?? 0) : null,
        unitsPerBox: it.unitsPerBox ?? null,
        unitPrice: Number(it.unitPrice),
        discount: it.discount != null && Number(it.discount) > 0 ? Number(it.discount) : null,
        taxRate: Number(it.taxRate ?? 0),
        taxable: Number(it.taxRate ?? 0) > 0,
        note: it.notes ?? "",
        promoFreeUnits: it.promoFreeUnits ?? null,
        promoBaseUnits: it.promoFreeUnits
          ? Math.trunc(Number(it.boxes != null ? it.boxes : it.qty) || 0)
          : null,
      })),
    );
    setIssueDate(invoice.issueDate ? invoice.issueDate.slice(0, 10) : "");
    setDueDate(invoice.dueDate ? invoice.dueDate.slice(0, 10) : "");
    setInvDiscount(Number(invoice.discount) > 0 ? Number(invoice.discount) : null);
    setShippingFee(Number(invoice.shippingFee) > 0 ? Number(invoice.shippingFee) : null);
    setReferenceNumber(invoice.referenceNumber ?? "");
    setSubject(invoice.subject ?? "");
    setNotes(invoice.notes ?? "");
    setTerms(invoice.terms ?? "");
  }, [invoice]);

  const patch = (key: string, up: Partial<EditLine>) =>
    setLines((ls) => ls.map((l) => (l.key === key ? { ...l, ...up } : l)));

  const setBoxes = (l: EditLine, boxes: number) => {
    const b = Math.max(0, Math.floor(boxes));
    const upb = Number(l.unitsPerBox ?? 0);
    patch(l.key, { boxes: b, qty: b * upb + (l.pieces ?? 0) });
  };
  const setPieces = (l: EditLine, pieces: number) => {
    const p = Math.max(0, Math.floor(pieces));
    const upb = Number(l.unitsPerBox ?? 0);
    patch(l.key, { pieces: p, qty: (l.boxes ?? 0) * upb + p });
  };

  const addCatalogLine = (p: AdminProduct) => {
    setPickerOpen(false);
    const upb = Number(p.unitsPerBox ?? 0);
    const boxed = upb > 1;
    setLines((ls) => [
      ...ls,
      {
        key: newKey(),
        productId: p.id,
        description: p.name,
        qty: boxed ? upb : 1,
        boxes: boxed ? 1 : null,
        pieces: boxed ? 0 : null,
        unitsPerBox: boxed ? upb : null,
        unitPrice: Number(p.pricePerUnit) || 0,
        discount: null,
        taxRate: 0,
        taxable: false,
        note: "",
        promoFreeUnits: null,
        promoBaseUnits: null,
      },
    ]);
  };

  // An unlisted line is just a blank fully-editable card — no modal needed here
  // (unlike the builder, every field on this screen is already editable in place).
  const addUnlistedLine = () =>
    setLines((ls) => [
      ...ls,
      {
        key: newKey(),
        productId: null,
        description: "",
        qty: 1,
        boxes: null,
        pieces: null,
        unitsPerBox: null,
        unitPrice: null,
        discount: null,
        taxRate: 0,
        taxable: false,
        note: "",
        promoFreeUnits: null,
        promoBaseUnits: null,
      },
    ]);

  /** The rate a line's Taxable toggle applies: its stored rate, else the tenant's. */
  const rateFor = (l: EditLine) => (l.taxRate > 0 ? l.taxRate : tenantTaxRate);

  const totals = useMemo(() => {
    const tLines: InvoiceTotalsLine[] = lines.map((l) => ({
      unitPrice: l.unitPrice ?? 0,
      qty: l.qty,
      boxes: l.boxes,
      pieces: l.pieces,
      unitsPerBox: l.unitsPerBox,
      discount: l.discount ?? 0,
      taxRate: l.taxable ? rateFor(l) : 0,
      freeUnits: editedLineFreeUnits(l),
    }));
    return computeInvoiceTotals({
      lines: tLines,
      discount: invDiscount ?? 0,
      shippingFee: shippingFee ?? 0,
      isTaxExempt,
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [lines, invDiscount, shippingFee, isTaxExempt, tenantTaxRate]);

  const submit = () => {
    if (!id || !invoice) return;
    if (lines.length === 0) {
      alertInfo("No items", "An invoice needs at least one line.");
      return;
    }
    for (const l of lines) {
      if (!l.description.trim()) {
        alertInfo("Missing description", "Every line needs a description.");
        return;
      }
      if (l.qty <= 0) {
        alertInfo(
          "Zero quantity",
          `"${l.description.trim()}" has no quantity — remove the line instead.`,
        );
        return;
      }
      if (l.unitPrice == null || l.unitPrice < 0) {
        alertInfo("Missing price", `"${l.description.trim()}" needs a price.`);
        return;
      }
    }
    if (!ISO_DATE.test(dueDate)) {
      alertInfo("Bad due date", "Use the format YYYY-MM-DD.");
      return;
    }
    if (issueDate.trim() && !ISO_DATE.test(issueDate.trim())) {
      alertInfo("Bad issue date", "Use the format YYYY-MM-DD, or leave it blank.");
      return;
    }
    if (totals.hasNegativeLine) {
      alertInfo("Check line discounts", "A line's discount is larger than the line itself.");
      return;
    }
    if (totals.discount > totals.subtotal) {
      alertInfo(
        "Discount too large",
        `The invoice discount ($${totals.discount.toFixed(2)}) can't exceed the subtotal ($${totals.subtotal.toFixed(2)}).`,
      );
      return;
    }
    updateMut.mutate(
      {
        id,
        ...(issueDate.trim() ? { issueDate: issueDate.trim() } : {}),
        dueDate,
        discount: invDiscount ?? 0,
        shippingFee: shippingFee ?? 0,
        notes,
        terms,
        referenceNumber,
        subject,
        items: lines.map((l) =>
          invoiceLineDto(
            {
              description: l.description.trim(),
              productId: l.productId,
              qty: l.qty,
              unitPrice: l.unitPrice ?? 0,
              boxes: l.boxes,
              pieces: l.pieces,
              unitsPerBox: l.unitsPerBox,
              discount: l.discount ?? undefined,
              taxable: l.taxable,
              notes: l.note,
              promoFreeUnits: editedLineFreeUnits(l),
            },
            rateFor(l),
          ),
        ),
      },
      {
        onSuccess: () => {
          showToast("Invoice updated");
          router.back();
        },
        // Server messages here are actionable (mirror guard, number conflict…) —
        // surface them verbatim instead of a fixed string.
        onError: (e: any) =>
          alertInfo("Couldn't save", e?.response?.data?.message ?? e?.message ?? "Try again."),
      },
    );
  };

  const guard = (title: string, body: string) => (
    <FormSheet
      title="Edit invoice"
      subtitle={invoice?.invoiceNumber}
      onSubmit={() => router.back()}
      submitLabel="Back"
    >
      <View style={styles.guardCard}>
        <Ionicons name="lock-closed-outline" size={22} color={ios.label2} />
        <Text style={styles.guardTitle}>{title}</Text>
        <Text style={styles.guardBody}>{body}</Text>
      </View>
    </FormSheet>
  );

  if (isLoading || !invoice) {
    return (
      <FormSheet title="Edit invoice" onSubmit={() => router.back()} submitLabel="Back">
        <View style={styles.guardCard}>
          <Text style={styles.guardBody}>Loading…</Text>
        </View>
      </FormSheet>
    );
  }
  if (invoice.status !== "DRAFT") {
    return guard(
      "Only draft invoices can be edited",
      "Use Revert to draft on a sent invoice first — invoices with payments must be voided instead.",
    );
  }
  if (
    isPendingOrderMirror({
      orderId: invoice.orderId,
      deliveryBatchId: invoice.deliveryBatchId,
      orderStatus: invoice.order?.status,
    })
  ) {
    return guard(
      "Edit the order instead",
      `This invoice mirrors order ${invoice.order?.orderNumber ?? ""} and updates automatically until the order is delivered.`,
    );
  }

  const showTax = !isTaxExempt && (tenantTaxRate > 0 || lines.some((l) => l.taxRate > 0));

  return (
    <FormSheet
      title="Edit invoice"
      subtitle={invoice.invoiceNumber}
      submitLabel={updateMut.isPending ? "Saving…" : "Save"}
      submitting={updateMut.isPending}
      warnIfDirty
      onSubmit={submit}
    >
      {isTaxExempt ? (
        <Text style={styles.exemptHint}>Tax-exempt customer — no tax will be charged.</Text>
      ) : null}

      {lines.map((l) => (
        <LineCard
          key={l.key}
          line={l}
          showTax={showTax}
          rate={rateFor(l)}
          removable={lines.length > 1}
          onPatch={(up) => patch(l.key, up)}
          onSetBoxes={(n) => setBoxes(l, n)}
          onSetPieces={(n) => setPieces(l, n)}
          onSetQty={(n) => patch(l.key, { qty: Math.max(0, Math.floor(n)) })}
          onRemove={() => setLines((ls) => ls.filter((x) => x.key !== l.key))}
        />
      ))}

      <View style={styles.addRow}>
        <Pressable style={styles.addBtn} onPress={() => setPickerOpen(true)} hitSlop={4}>
          <Ionicons name="add-circle-outline" size={16} color={ios.brand} />
          <Text style={styles.addBtnText}>Add item</Text>
        </Pressable>
        <Pressable style={styles.addBtn} onPress={addUnlistedLine} hitSlop={4}>
          <Ionicons name="create-outline" size={16} color={ios.brand} />
          <Text style={styles.addBtnText}>Add unlisted item</Text>
        </Pressable>
      </View>

      <FormSection title="Details">
        <FormField label="Issue date" hint="YYYY-MM-DD; blank keeps the original date.">
          <FormTextInput
            value={issueDate}
            onChangeText={setIssueDate}
            placeholder="YYYY-MM-DD"
            keyboardType="numbers-and-punctuation"
          />
        </FormField>
        <FormField label="Due date">
          <FormTextInput
            value={dueDate}
            onChangeText={setDueDate}
            placeholder="YYYY-MM-DD"
            keyboardType="numbers-and-punctuation"
          />
        </FormField>
        <FormField label="Reference number">
          <FormTextInput
            value={referenceNumber}
            onChangeText={setReferenceNumber}
            placeholder="PO / reference (optional)"
          />
        </FormField>
        <FormField label="Subject">
          <FormTextInput
            value={subject}
            onChangeText={setSubject}
            placeholder="Shown on the invoice header (optional)"
          />
        </FormField>
        <View style={styles.moneyRow}>
          <View style={styles.moneyCol}>
            <FormField label="Invoice discount ($)">
              <MoneyTextInput
                value={invDiscount}
                onChangeValue={setInvDiscount}
                placeholder="0.00"
                style={styles.moneyInput}
                returnKeyType="done"
              />
            </FormField>
          </View>
          <View style={styles.moneyCol}>
            <FormField label="Shipping fee ($)">
              <MoneyTextInput
                value={shippingFee}
                onChangeValue={setShippingFee}
                placeholder="0.00"
                style={styles.moneyInput}
                returnKeyType="done"
              />
            </FormField>
          </View>
        </View>
        <FormField label="Notes">
          <FormTextInput value={notes} onChangeText={setNotes} multiline placeholder="Notes…" />
        </FormField>
        <FormField label="Terms">
          <FormTextInput value={terms} onChangeText={setTerms} multiline placeholder="Terms…" />
        </FormField>
      </FormSection>

      <View style={styles.totalsCard}>
        <TotalRow label="Subtotal" value={totals.subtotal} />
        {totals.taxTotal > 0 ? <TotalRow label="Tax" value={totals.taxTotal} /> : null}
        {totals.discount > 0 ? <TotalRow label="Discount" value={-totals.discount} /> : null}
        {totals.shippingFee > 0 ? <TotalRow label="Shipping" value={totals.shippingFee} /> : null}
        <View style={[styles.totalRow, styles.totalRowMain]}>
          <Text style={styles.totalLabelMain}>Total</Text>
          <Text style={styles.totalValueMain}>${totals.total.toFixed(2)}</Text>
        </View>
      </View>

      <ProductPickerSheet
        visible={pickerOpen}
        title="Add item"
        onClose={() => setPickerOpen(false)}
        onSelect={addCatalogLine}
      />
    </FormSheet>
  );
}

function TotalRow({ label, value }: { label: string; value: number }) {
  const sign = value < 0 ? "−" : "";
  return (
    <View style={styles.totalRow}>
      <Text style={styles.totalLabel}>{label}</Text>
      <Text style={styles.totalValue}>
        {sign}${Math.abs(value).toFixed(2)}
      </Text>
    </View>
  );
}

function LineCard({
  line,
  showTax,
  rate,
  removable,
  onPatch,
  onSetBoxes,
  onSetPieces,
  onSetQty,
  onRemove,
}: {
  line: EditLine;
  showTax: boolean;
  rate: number;
  removable: boolean;
  onPatch: (up: Partial<EditLine>) => void;
  onSetBoxes: (n: number) => void;
  onSetPieces: (n: number) => void;
  onSetQty: (n: number) => void;
  onRemove: () => void;
}) {
  const upb = Number(line.unitsPerBox ?? 0);
  const isSplit = line.boxes != null && upb > 1;
  const freeUnits = editedLineFreeUnits(line);
  const lineTotal = Math.max(
    0,
    computeLineSubtotal({
      unitPrice: line.unitPrice ?? 0,
      qty: line.qty,
      boxes: line.boxes,
      pieces: line.pieces,
      unitsPerBox: line.unitsPerBox,
      freeUnits,
    }) - (line.discount ?? 0),
  );

  return (
    <View style={styles.lineCard}>
      <View style={styles.lineHeader}>
        {line.productId ? (
          <View style={{ flex: 1, minWidth: 0 }}>
            <Text style={styles.lineName} numberOfLines={2}>
              {line.description}
            </Text>
            {isSplit ? <Text style={styles.lineMeta}>case of {upb}</Text> : null}
          </View>
        ) : (
          <View style={{ flex: 1, minWidth: 0 }}>
            <TextInput
              value={line.description}
              onChangeText={(t) => onPatch({ description: t })}
              placeholder="Item description"
              placeholderTextColor={ios.label3}
              style={styles.lineNameInput}
            />
            <Text style={styles.lineMeta}>Custom line</Text>
          </View>
        )}
        {removable ? (
          <Pressable onPress={onRemove} hitSlop={8} style={styles.lineRemove}>
            <Ionicons name="trash-outline" size={18} color={ios.system.redInk} />
          </Pressable>
        ) : null}
      </View>

      <View style={styles.fieldRow}>
        <Text style={styles.fieldLabel}>Price{isSplit ? " / case" : ""}</Text>
        <View style={styles.fieldInputWrap}>
          <Text style={styles.fieldCurrency}>$</Text>
          <MoneyTextInput
            style={styles.fieldMoneyInput}
            value={line.unitPrice}
            onChangeValue={(v) => onPatch({ unitPrice: v })}
            placeholder="0.00"
            returnKeyType="done"
          />
        </View>
      </View>

      {isSplit ? (
        <>
          <View style={styles.fieldRow}>
            <Text style={styles.fieldLabel}>Cases</Text>
            <QtyStepper value={line.boxes ?? 0} onChangeQty={onSetBoxes} />
          </View>
          <View style={styles.fieldRow}>
            <View style={{ flex: 1 }}>
              <Text style={styles.fieldLabel}>Loose units</Text>
              <Text style={styles.fieldHint}>{upb} per case</Text>
            </View>
            <QtyStepper value={line.pieces ?? 0} onChangeQty={onSetPieces} max={upb - 1} />
          </View>
        </>
      ) : (
        <View style={styles.fieldRow}>
          <Text style={styles.fieldLabel}>Qty</Text>
          <QtyStepper value={line.qty} onChangeQty={onSetQty} />
        </View>
      )}

      <View style={styles.fieldRow}>
        <Text style={styles.fieldLabel}>Discount</Text>
        <View style={styles.fieldInputWrap}>
          <Text style={styles.fieldCurrency}>−$</Text>
          <MoneyTextInput
            style={[styles.fieldMoneyInput, (line.discount ?? 0) > 0 && styles.fieldMoneyActive]}
            value={line.discount}
            onChangeValue={(v) => onPatch({ discount: v != null && v > 0 ? v : null })}
            placeholder="0.00"
            returnKeyType="done"
          />
        </View>
      </View>

      {showTax && rate > 0 ? (
        <Pressable
          style={styles.taxRow}
          onPress={() => onPatch({ taxable: !line.taxable })}
          hitSlop={4}
          accessibilityRole="checkbox"
        >
          <View style={[styles.checkbox, line.taxable && styles.checkboxOn]}>
            {line.taxable ? <Text style={styles.checkboxTick}>✓</Text> : null}
          </View>
          <Text style={styles.taxLabel}>
            Taxable ({(rate * 100).toFixed(2).replace(/\.?0+$/, "")}%)
          </Text>
        </Pressable>
      ) : null}

      {line.noteOpen || line.note.trim() ? (
        <TextInput
          value={line.note}
          onChangeText={(t) => onPatch({ note: t })}
          placeholder="Note for this item (prints on invoice)"
          placeholderTextColor={ios.label3}
          maxLength={500}
          returnKeyType="done"
          style={styles.noteInput}
        />
      ) : (
        <Pressable onPress={() => onPatch({ noteOpen: true })} hitSlop={6} style={styles.noteAdd}>
          <Ionicons name="create-outline" size={14} color={ios.brand} />
          <Text style={styles.noteAddText}>Add note</Text>
        </Pressable>
      )}

      <View style={styles.lineFooter}>
        <Text style={styles.lineFooterLabel}>Line total</Text>
        <Text style={styles.lineFooterValue}>${lineTotal.toFixed(2)}</Text>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  guardCard: {
    backgroundColor: ios.bgElev,
    borderRadius: 14,
    padding: 24,
    alignItems: "center",
    gap: 8,
  },
  guardTitle: { fontSize: 15, fontFamily: "Inter_600SemiBold", color: ios.label },
  guardBody: {
    fontSize: 13,
    fontFamily: "Inter_400Regular",
    color: ios.label2,
    textAlign: "center",
  },
  exemptHint: { fontSize: 12, fontFamily: "Inter_500Medium", color: ios.label2 },

  lineCard: { backgroundColor: ios.bgElev, borderRadius: 14, padding: 12, gap: 10 },
  lineHeader: { flexDirection: "row", gap: 8, alignItems: "flex-start" },
  lineName: {
    fontSize: 15,
    fontFamily: "Inter_600SemiBold",
    color: ios.label,
    letterSpacing: -0.2,
  },
  lineNameInput: {
    backgroundColor: ios.fill3,
    borderRadius: 8,
    paddingHorizontal: 10,
    paddingVertical: 7,
    fontSize: 14,
    fontFamily: "Inter_600SemiBold",
    color: ios.label,
  },
  lineMeta: { fontSize: 12, fontFamily: "Inter_400Regular", color: ios.label2, marginTop: 2 },
  lineRemove: {
    width: 32,
    height: 32,
    borderRadius: 16,
    backgroundColor: ios.fill3,
    alignItems: "center",
    justifyContent: "center",
  },
  fieldRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: 12,
  },
  fieldLabel: { fontSize: 14, fontFamily: "Inter_500Medium", color: ios.label },
  fieldHint: { fontSize: 11, fontFamily: "Inter_400Regular", color: ios.label3, marginTop: 1 },
  fieldInputWrap: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    flexShrink: 1,
    minWidth: 0,
  },
  fieldCurrency: { fontSize: 14, fontFamily: "Inter_400Regular", color: ios.label2 },
  fieldMoneyInput: {
    minWidth: 70,
    // Caps the react-native-web intrinsic width; never binds on native.
    maxWidth: 96,
    flexShrink: 0,
    paddingHorizontal: 8,
    paddingVertical: 5,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: ios.separator,
    borderRadius: 8,
    textAlign: "right",
    fontSize: 15,
    fontFamily: "Inter_600SemiBold",
    color: ios.label,
    fontVariant: ["tabular-nums"],
  },
  fieldMoneyActive: { borderColor: ios.brand, color: ios.brand },
  taxRow: { flexDirection: "row", alignItems: "center", gap: 10 },
  taxLabel: { fontSize: 13, fontFamily: "Inter_500Medium", color: ios.label },
  checkbox: {
    width: 22,
    height: 22,
    borderRadius: 6,
    borderWidth: 1.5,
    borderColor: ios.separator,
    alignItems: "center",
    justifyContent: "center",
  },
  checkboxOn: { backgroundColor: ios.brand, borderColor: ios.brand },
  checkboxTick: { color: "#fff", fontFamily: "Inter_700Bold" },
  noteAdd: { flexDirection: "row", alignItems: "center", gap: 4, paddingVertical: 4 },
  noteAddText: { fontSize: 12, fontFamily: "Inter_500Medium", color: ios.brand },
  noteInput: {
    backgroundColor: ios.fill3,
    borderRadius: 8,
    paddingHorizontal: 10,
    paddingVertical: 7,
    fontSize: 13,
    fontFamily: "Inter_400Regular",
    color: ios.label,
  },
  lineFooter: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    paddingTop: 6,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: ios.separator,
  },
  lineFooterLabel: { fontSize: 12, fontFamily: "Inter_500Medium", color: ios.label2 },
  lineFooterValue: {
    fontSize: 15,
    fontFamily: "Inter_700Bold",
    color: ios.label,
    fontVariant: ["tabular-nums"],
  },

  addRow: { flexDirection: "row", gap: 10 },
  addBtn: {
    flex: 1,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 6,
    backgroundColor: ios.brandWash,
    borderRadius: 12,
    paddingVertical: 12,
  },
  addBtnText: { color: ios.brand, fontSize: 14, fontFamily: "Inter_600SemiBold" },

  moneyRow: { flexDirection: "row", gap: 10 },
  // flex-basis split, not flex:1 — RNW TextInputs carry an intrinsic width that
  // otherwise pushes the second column off a 320px screen.
  moneyCol: { flexBasis: 0, flexGrow: 1, minWidth: 0 },
  moneyInput: {
    backgroundColor: ios.fill3,
    borderRadius: 10,
    paddingHorizontal: 12,
    paddingVertical: 10,
    fontSize: 15,
    fontFamily: "Inter_400Regular",
    color: ios.label,
  },

  totalsCard: { backgroundColor: ios.bgElev, borderRadius: 14, padding: 14, gap: 6 },
  totalRow: { flexDirection: "row", justifyContent: "space-between" },
  totalRowMain: {
    paddingTop: 8,
    marginTop: 2,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: ios.separator,
  },
  totalLabel: { fontSize: 13, fontFamily: "Inter_400Regular", color: ios.label2 },
  totalValue: {
    fontSize: 13,
    fontFamily: "Inter_500Medium",
    color: ios.label,
    fontVariant: ["tabular-nums"],
  },
  totalLabelMain: { fontSize: 15, fontFamily: "Inter_700Bold", color: ios.label },
  totalValueMain: {
    fontSize: 17,
    fontFamily: "Inter_700Bold",
    color: ios.label,
    fontVariant: ["tabular-nums"],
  },
});
