import { useEffect, useMemo, useRef, useState } from "react";
import { Pressable, StyleSheet, Text, TextInput, View } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { useLocalSearchParams, useRouter } from "expo-router";
import { useQueryClient } from "@tanstack/react-query";
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
import { BarcodeFab } from "../../../../../components/BarcodeFab";
import {
  useAdminCustomer,
  useAdminInvoice,
  useBusinessSettings,
  type AdminProduct,
} from "../../../../../lib/api/admin";
import { resolveScanSellLevel } from "@routeflow/scanning";
import { archivedMessage, resolveProductByCode } from "../../../../../lib/barcode-resolve";
import { decideScanResult, promptText, runScanDecision } from "../../../../../lib/scan-suggestion";
import { ScanMatchPickerSheet } from "../../../../../components/ScanMatchPickerSheet";
import { useScanMatchPicker } from "../../../../../lib/use-scan-match-picker";
import { levelsForScan } from "../../../../../lib/wedge-scan";
import type { ScanOutcome } from "../../../../../lib/scan-loop";
import { canRemoveLooseUnits, looseUnitsVisible } from "../../../../../lib/loose-units";
import { useUpdateInvoice } from "../../../../../lib/api/invoices";
import { alertInfo, confirm } from "../../../../../lib/confirm";
import {
  INVOICE_STALE_COPY,
  INVOICE_STALE_TITLE,
  isInvoiceStale,
} from "../../../../../lib/invoice-stale";
import { ISO_DATE } from "../../../../../lib/invoice-terms";
import {
  computeInvoiceTotals,
  editedLineFreeUnits,
  invoiceLineDto,
  type InvoiceTotalsLine,
} from "../../../../../lib/invoice-totals";
import { isPendingOrderMirror } from "../../../../../lib/invoices-logic";
import { hasUnitLine, unitLabelsOf } from "../../../../../lib/invoice-line-unit";
import {
  computeLineSubtotal,
  isNsfLine,
  packFromOwnSplit,
  type SellLevel,
} from "@routeflow/pricing";
import { scanHaptic } from "../../../../../lib/haptics";
import { showToast } from "../../../../../lib/toast";
import {
  hasUnsavedInvoiceLineEdits,
  type InvoiceEditSnapshot,
} from "../../../../../lib/discard-guard";
import { hydratedLineTax } from "../../../../../lib/invoice-edit-tax";
import { reasonField, showsReason } from "../../../../../lib/invoice-edit-reason";
import { safeTextErrorCopy } from "../../../../../lib/safe-text-error-copy";

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
  /** Stored row id (SA-186) — sent back so the server matches THIS row. Absent on new lines. */
  id?: string;
  /** SA-184/189: a stored box line whose pack can't be recovered — read-only until the
   *  operator sets the pack. `storedBoxes/Pieces` are re-sent verbatim (line stays untouched). */
  locked?: boolean;
  storedBoxes?: number;
  storedPieces?: number;
  /** Operator-attested pack (integer >= 2) from unlocking; the only `unitsPerBox` ever sent. */
  attestedPack?: number;
  productId: string | null;
  description: string;
  /** #2656: carried so the NSF fee line's Taxable toggle stays locked off (the API refuses > 0). */
  systemKind?: string | null;
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
  /** H3b: the price the line was offered at (the stored price on load). Absent on a line added here, whose
   *  price is the catalog list the server judges against the customer's tier price. */
  offeredPrice?: number;
  /** H3b: why the price moved off the customer's special price; sent with a moved or newly added price. */
  overrideReason?: string;
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
  const [scanPromptOpen, setScanPromptOpen] = useState(false);
  const matchPicker = useScanMatchPicker<AdminProduct>();

  // Hydrate once per invoice id — refetches must not clobber in-progress edits.
  const hydratedFor = useRef<string | null>(null);
  // H4: the updatedAt the form hydrated from — sent as expectedUpdatedAt; a refetch never moves it.
  const openedUpdatedAt = useRef<string | undefined>(undefined);
  const qc = useQueryClient();
  // Snapshot taken at hydration, compared against the live form by `dirty`
  // below (lib/discard-guard.ts#hasUnsavedInvoiceLineEdits). Null until the
  // effect below has run once for this invoice.
  const originalRef = useRef<InvoiceEditSnapshot | null>(null);
  useEffect(() => {
    if (!invoice || invoice.status !== "DRAFT" || hydratedFor.current === invoice.id) return;
    hydratedFor.current = invoice.id;
    openedUpdatedAt.current = invoice.updatedAt;
    // B294 (SA-141): a legacy invoice's 0-rate lines load at its verified inferred rate.
    const lineTax = hydratedLineTax(invoice);
    const hydratedLines = (invoice.items ?? []).map((it, i) => ({
      key: newKey(),
      id: it.id,
      ...(it.boxes != null &&
      !(
        Number(
          it.unitsPerBox ??
            packFromOwnSplit({ qty: Number(it.qty), boxes: it.boxes, pieces: it.pieces }) ??
            0,
        ) > 1
      )
        ? { locked: true, storedBoxes: Number(it.boxes), storedPieces: Number(it.pieces ?? 0) }
        : {}),
      productId: it.productId ?? null,
      description: it.description,
      systemKind: it.systemKind ?? null,
      qty: Number(it.qty),
      boxes: it.boxes ?? null,
      pieces: it.boxes != null ? (it.pieces ?? 0) : null,
      // B674/SA-144: a legacy line (boxes stored, unitsPerBox never snapshotted) recovers its
      // pack from its OWN split via packFromOwnSplit — web's exact fix. Without this, a legacy
      // line hydrated here with unitsPerBox null failed isSplit's upb > 1 check below, so the
      // case/piece stepper never rendered and a save re-priced the line as loose pieces.
      unitsPerBox:
        it.unitsPerBox ??
        packFromOwnSplit({ qty: Number(it.qty), boxes: it.boxes, pieces: it.pieces }) ??
        null,
      unitPrice: Number(it.unitPrice),
      offeredPrice: Number(it.unitPrice),
      discount: it.discount != null && Number(it.discount) > 0 ? Number(it.discount) : null,
      ...lineTax[i],
      note: it.notes ?? "",
      promoFreeUnits: it.promoFreeUnits ?? null,
      promoBaseUnits: it.promoFreeUnits
        ? Math.trunc(Number(it.boxes != null ? it.boxes : it.qty) || 0)
        : null,
    }));
    setLines(hydratedLines);
    const hydratedIssueDate = invoice.issueDate ? invoice.issueDate.slice(0, 10) : "";
    const hydratedDueDate = invoice.dueDate ? invoice.dueDate.slice(0, 10) : "";
    const hydratedInvDiscount = Number(invoice.discount) > 0 ? Number(invoice.discount) : null;
    const hydratedShippingFee =
      Number(invoice.shippingFee) > 0 ? Number(invoice.shippingFee) : null;
    const hydratedReferenceNumber = invoice.referenceNumber ?? "";
    const hydratedSubject = invoice.subject ?? "";
    const hydratedNotes = invoice.notes ?? "";
    const hydratedTerms = invoice.terms ?? "";
    setIssueDate(hydratedIssueDate);
    setDueDate(hydratedDueDate);
    setInvDiscount(hydratedInvDiscount);
    setShippingFee(hydratedShippingFee);
    setReferenceNumber(hydratedReferenceNumber);
    setSubject(hydratedSubject);
    setNotes(hydratedNotes);
    setTerms(hydratedTerms);
    originalRef.current = {
      lines: hydratedLines.map(
        ({ key, unitsPerBox, taxRate, promoFreeUnits, promoBaseUnits, ...rest }) => rest,
      ),
      issueDate: hydratedIssueDate,
      dueDate: hydratedDueDate,
      invDiscount: hydratedInvDiscount,
      shippingFee: hydratedShippingFee,
      referenceNumber: hydratedReferenceNumber,
      subject: hydratedSubject,
      notes: hydratedNotes,
      terms: hydratedTerms,
    };
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

  // `level` is what a SCAN carried (SA-580 R1/R2): UNIT on a boxed product is one loose piece
  // (0 boxes + 1 piece — both shown by the line's case/loose steppers), BOX one case. A tapped pick
  // passes none: a case, as before. upb <= 1 has no distinction (R4).
  const addCatalogLine = (p: AdminProduct, level: SellLevel = "BOX") => {
    setPickerOpen(false);
    const upb = Number(p.unitsPerBox ?? 0);
    const boxed = upb > 1;
    const loose = boxed && level === "UNIT";
    setLines((ls) => [
      ...ls,
      {
        key: newKey(),
        productId: p.id,
        description: p.name,
        qty: loose ? 1 : boxed ? upb : 1,
        boxes: boxed ? (loose ? 0 : 1) : null,
        pieces: boxed ? (loose ? 1 : 0) : null,
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

  // B265: this screen had no scan entry outside the product picker sheet —
  // mirrors ProductPickerSheet's own onScanned (same resolve -> archived/
  // not-found handling), feeding scanned lines through the SAME addCatalogLine
  // path a tapped pick uses.
  // F1 (independent review, PR-3): mounted with `continuous`, so the scanner
  // overlay stays up between scans and needs a ScanOutcome return every path
  // to show feedback (BarcodeScanner.tsx reads outcome.feedback) -- the
  // ProductPickerSheet handler this was copied from is a single-shot sheet
  // (its own setScanOpen(false) makes the fallback toast visible), so the
  // missing return went unnoticed there but leaves this FAB silent per scan.
  const onScanned = async (code: string): Promise<ScanOutcome> => {
    const trimmed = code.trim();
    if (!trimmed) return;
    try {
      const result = await resolveProductByCode<AdminProduct>(trimmed);
      if (result.archived) {
        return { feedback: { kind: "error", text: archivedMessage(result.product) } };
      }
      const decision = decideScanResult(result, "add");
      // B1220: a lone fuzzy match asks first, 2+ matches open a list; neither adds unprompted.
      if (
        runScanDecision(
          decision,
          (p) => addCatalogLine(p, resolveScanSellLevel(p, levelsForScan(trimmed, p))),
          confirm,
          { pick: matchPicker.open, onPromptChange: setScanPromptOpen },
        )
      ) {
        if (decision.kind === "add") {
          return { feedback: { kind: "added", text: `${decision.product.name} added` } };
        }
        // A confirm/picker prompt is not a failure: neutral haptic, not the error buzz.
        scanHaptic("info");
        return { feedback: { kind: "info", text: promptText(decision) } };
      }
    } catch {
      // network error → fall through to the toast
    }
    return { feedback: { kind: "error", text: `No product for "${trimmed}"` } };
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

  const dirty = useMemo(
    () =>
      hasUnsavedInvoiceLineEdits(
        {
          lines: lines.map(
            ({ key, unitsPerBox, taxRate, promoFreeUnits, promoBaseUnits, ...rest }) => rest,
          ),
          issueDate,
          dueDate,
          invDiscount,
          shippingFee,
          referenceNumber,
          subject,
          notes,
          terms,
        },
        originalRef.current,
      ),
    [lines, issueDate, dueDate, invDiscount, shippingFee, referenceNumber, subject, notes, terms],
  );

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
        expectedUpdatedAt: openedUpdatedAt.current,
        ...(issueDate.trim() ? { issueDate: issueDate.trim() } : {}),
        dueDate,
        discount: invDiscount ?? 0,
        shippingFee: shippingFee ?? 0,
        notes,
        terms,
        referenceNumber,
        subject,
        items: lines.map((l) => ({
          ...(l.id ? { id: l.id } : {}),
          ...(l.locked ? { boxes: l.storedBoxes ?? 0, pieces: l.storedPieces ?? 0 } : {}),
          // SA-189: only an operator-attested pack is ever sent.
          ...(l.attestedPack ? { unitsPerBox: l.attestedPack } : {}),
          // H3b: the reason a price moved off the customer's special price (the server decides if it needs one)
          ...reasonField(l),
          ...invoiceLineDto(
            {
              description: l.description.trim(),
              productId: l.productId,
              qty: l.qty,
              unitPrice: l.unitPrice ?? 0,
              boxes: l.boxes,
              pieces: l.pieces,
              unitsPerBox: l.unitsPerBox,
              discount: l.discount ?? undefined,
              taxable: l.taxable && !isNsfLine(l), // #2656: the NSF fee line is never taxed
              notes: l.note,
              promoFreeUnits: editedLineFreeUnits(l),
            },
            rateFor(l),
          ),
          ...(l.locked ? { boxes: l.storedBoxes ?? 0, pieces: l.storedPieces ?? 0 } : {}),
        })),
      },
      {
        onSuccess: () => {
          showToast("Invoice updated");
          router.back();
        },
        // Server messages here are actionable (mirror guard, number conflict…) —
        // surface them verbatim instead of a fixed string.
        onError: (e: any) => {
          if (isInvoiceStale(e)) {
            // H4: Reload refetches and re-hydrates the form (and its token) for the user to re-apply.
            confirm(
              INVOICE_STALE_TITLE,
              INVOICE_STALE_COPY,
              () => {
                hydratedFor.current = null;
                void qc.invalidateQueries({ queryKey: ["admin", "invoices", id] });
              },
              { confirmText: "Reload" },
            );
            return;
          }
          alertInfo(
            "Couldn't save",
            safeTextErrorCopy(e) ?? e?.response?.data?.message ?? e?.message ?? "Try again.",
          );
        },
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
      pendingMirror: invoice.pendingMirror,
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
  // units_v1, FAIL CLOSED (B784, mirrors web's B641): update() refuses a unit line (4c-2 is not
  // built yet) and this form holds no unit state, so saving would silently store the line as a
  // PACK line — 3 Cases (864 pieces) become 72 pieces while the money still reads $1,440. Refuse
  // visibly here instead of letting the operator discover it from the server's 409 on Save.
  if (hasUnitLine(invoice.items)) {
    return guard(
      `This invoice has a line sold by the ${unitLabelsOf(invoice.items).join(" / ")}`,
      "Saving from this screen would turn that line into a pack line and change its quantity. Open the invoice to review it, or delete this draft and create it again.",
    );
  }

  const showTax = !isTaxExempt && (tenantTaxRate > 0 || lines.some((l) => l.taxRate > 0));

  // BarcodeFab renders as a SIBLING of FormSheet, not a child: FormSheet's
  // `children` land inside its own internal ScrollView, and an absolutely-
  // positioned FAB in there would scroll away with the form instead of
  // floating fixed on screen (matches movements.tsx/adjust-picker.tsx, which
  // mount it as a sibling of their own ScrollView for the same reason).
  return (
    <>
      <FormSheet
        title="Edit invoice"
        subtitle={invoice.invoiceNumber}
        submitLabel={updateMut.isPending ? "Saving…" : "Save"}
        submitting={updateMut.isPending}
        confirmDiscardIfDirty={dirty && !updateMut.isPending}
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
          activeOnly
          onClose={() => setPickerOpen(false)}
          onSelect={addCatalogLine}
        />
      </FormSheet>
      <BarcodeFab onScanned={onScanned} continuous hidden={pickerOpen} paused={scanPromptOpen} />
      <ScanMatchPickerSheet {...matchPicker.props} />
    </>
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
  // #2698 (SA-564a): one unit sold — loose units are opt-in, the same rule as CartRow.
  const [looseUnitsOpen, setLooseUnitsOpen] = useState(false);
  const showLoose = looseUnitsVisible(looseUnitsOpen, line.pieces);
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

      {line.locked ? (
        <View testID="locked-line">
          <Text style={styles.fieldHint}>
            {line.storedBoxes} case · {line.storedPieces} loose · $
            {Number(line.unitPrice ?? 0).toFixed(2)}
            {" — set the box and piece count for this line to edit it."}
          </Text>
          <View style={styles.fieldRow}>
            <Text style={styles.fieldLabel}>Units per case</Text>
            <TextInput
              keyboardType="number-pad"
              placeholder="e.g. 12"
              placeholderTextColor={ios.label3}
              onChangeText={(t) => {
                const n = Number(t);
                if (Number.isInteger(n) && n >= 2) {
                  onPatch({
                    locked: false,
                    unitsPerBox: n,
                    attestedPack: n,
                    qty: (line.storedBoxes ?? 0) * n + (line.storedPieces ?? 0),
                  });
                }
              }}
              style={styles.fieldMoneyInput}
            />
          </View>
        </View>
      ) : (
        <>
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
          {showsReason(line) ? (
            <TextInput
              style={styles.reasonInput}
              value={line.overrideReason ?? ""}
              onChangeText={(t) => onPatch({ overrideReason: t })}
              maxLength={200}
              placeholder="Reason (needed off a special price)"
              placeholderTextColor={ios.label3}
              accessibilityLabel="Reason for the price change"
            />
          ) : null}

          {isSplit ? (
            <>
              <View style={styles.fieldRow}>
                <Text style={styles.fieldLabel}>Cases</Text>
                <QtyStepper value={line.boxes ?? 0} onChangeQty={onSetBoxes} />
              </View>
              {showLoose ? (
                <View style={styles.fieldRow}>
                  <View style={{ flex: 1 }}>
                    <Text style={styles.fieldLabel}>Extra loose units</Text>
                    <Text style={styles.fieldHint}>{upb} per case</Text>
                  </View>
                  <QtyStepper value={line.pieces ?? 0} onChangeQty={onSetPieces} max={upb - 1} />
                  {canRemoveLooseUnits(line.boxes) ? (
                    <Pressable
                      onPress={() => {
                        onSetPieces(0);
                        setLooseUnitsOpen(false);
                      }}
                      hitSlop={8}
                      style={styles.looseRemove}
                      accessibilityRole="button"
                      accessibilityLabel="Remove extra units"
                    >
                      <Ionicons name="close" size={16} color={ios.label2} />
                    </Pressable>
                  ) : null}
                </View>
              ) : (
                <Pressable
                  onPress={() => setLooseUnitsOpen(true)}
                  hitSlop={8}
                  style={styles.looseAdd}
                  accessibilityRole="button"
                  accessibilityLabel="Add extra loose units"
                >
                  <Text style={styles.looseAddText}>+ units</Text>
                </Pressable>
              )}
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
                style={[
                  styles.fieldMoneyInput,
                  (line.discount ?? 0) > 0 && styles.fieldMoneyActive,
                ]}
                value={line.discount}
                onChangeValue={(v) => onPatch({ discount: v != null && v > 0 ? v : null })}
                placeholder="0.00"
                returnKeyType="done"
              />
            </View>
          </View>
        </>
      )}

      {showTax && rate > 0 && isNsfLine(line) ? (
        // #2656 / SA-549: the NSF fee line is never taxed — the toggle is locked off (API refuses > 0).
        <Pressable
          style={[styles.taxRow, { opacity: 0.5 }]}
          disabled
          accessibilityRole="checkbox"
          accessibilityState={{ checked: false, disabled: true }}
          accessibilityLabel="Not taxed: the NSF fee is never taxed"
        >
          <View style={styles.checkbox} />
          <Text style={styles.taxLabel}>Not taxed (NSF fee)</Text>
        </Pressable>
      ) : showTax && rate > 0 ? (
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
  // #2698: the opt-in loose-units control (dashed, small) and its remove button — as CartRow.
  looseRemove: {
    width: 32,
    height: 32,
    borderRadius: 16,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: ios.fill,
    marginLeft: 6,
  },
  looseAdd: {
    alignSelf: "flex-start",
    paddingHorizontal: 12,
    minHeight: 32,
    justifyContent: "center",
    borderRadius: 8,
    borderWidth: 1,
    borderStyle: "dashed",
    borderColor: ios.separator,
  },
  looseAddText: { fontSize: 13, fontFamily: "Inter_600SemiBold", color: ios.brand },
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
  reasonInput: {
    backgroundColor: ios.fill3,
    borderRadius: 8,
    paddingHorizontal: 10,
    paddingVertical: 7,
    fontSize: 14,
    fontFamily: "Inter_400Regular",
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
