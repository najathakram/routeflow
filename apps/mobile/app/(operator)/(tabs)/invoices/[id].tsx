import {
  ActivityIndicator,
  Modal,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import { useEffect, useState } from "react";
import { SafeAreaView } from "react-native-safe-area-context";
import { Ionicons } from "@expo/vector-icons";
import { useLocalSearchParams, useRouter } from "expo-router";
import { ios } from "@routeflow/ui/tokens";
import { NavBackButton, NavBar, Pill, SegmentedControl } from "@routeflow/ui/mobile/ios";
import { useAdminInvoice, useAdminInvoices } from "../../../../lib/api/admin";
import {
  useDeleteInvoice,
  useInvoicePdf,
  type InvoicePdfVariant,
  useSendInvoice,
  useUpdateInvoice,
  useUpdateInvoiceShipment,
  useVoidInvoice,
} from "../../../../lib/api/invoices";
import { deriveInvoiceVariant } from "../../../../lib/invoice-pdf-variant";
import { canWriteOff, isPaymentEditable } from "../../../../lib/invoices-logic";
import { siblingInvoicesOf } from "../../../../lib/invoice-siblings";
import { showToast } from "../../../../lib/toast";
import { confirm, chooseAction } from "../../../../lib/confirm";
import { formatQtySplit } from "../../../../lib/pricing";
import { sharePdf } from "../../../../lib/share-pdf";
import { ShipmentSection, ShipmentEditModal } from "../../../../components/ShipmentSection";

function fmtCurrency(n: number | string | undefined): string {
  const v = typeof n === "string" ? Number(n) : (n ?? 0);
  return `$${(Number.isFinite(v) ? v : 0).toFixed(2)}`;
}

function statusPill(status: string) {
  switch (status) {
    case "DRAFT":
      return { variant: "gray" as const, label: "Draft" };
    case "SENT":
      return { variant: "brand" as const, label: "Sent" };
    case "PARTIAL":
      return { variant: "orange" as const, label: "Partial" };
    case "PAID":
      return { variant: "green" as const, label: "Paid" };
    case "OVERDUE":
      return { variant: "red" as const, label: "Overdue" };
    case "VOID":
      return { variant: "gray" as const, label: "Voided" };
    default:
      return { variant: "gray" as const, label: status };
  }
}

export default function InvoiceDetailScreen() {
  const router = useRouter();
  const { id } = useLocalSearchParams<{ id: string }>();

  // RF-203: defensive guard — if somehow "create" reaches this screen (e.g. the
  // static create.tsx was not matched), redirect to the proper create form
  // instead of firing a doomed /invoices/create API call and spinning forever.
  const isCreateAlias = id === "create" || id === "new";
  useEffect(() => {
    if (isCreateAlias) router.replace("/(operator)/invoices/new");
  }, [isCreateAlias, router]);

  const { data: invoice, isLoading, refetch } = useAdminInvoice(isCreateAlias ? "" : (id ?? ""));
  // REG-5: sibling invoices from the same regulated sale-split. No dedicated
  // "list siblings" endpoint exists — GET /invoices already returns
  // invoiceGroupId as a raw scalar on every row (verified: findAll's `include`
  // doesn't restrict scalars), so a narrow customerId + same-issue-date lookup
  // via the EXISTING useAdminInvoices hook is enough; zero new endpoints. Called
  // unconditionally (mirrors the "call the hook unconditionally, gate only the
  // display" convention established by P10-REG-B) — customerId/dateFrom/dateTo
  // are undefined for one render until `invoice` loads, which just widens that
  // one query harmlessly; the queryKey changes once real params land.
  const issueDay = invoice?.issueDate ? invoice.issueDate.slice(0, 10) : undefined;
  const { data: siblingCandidates } = useAdminInvoices({
    customerId: invoice?.customer?.id,
    dateFrom: issueDay,
    dateTo: issueDay,
    limit: 25,
  });
  const siblingInvoices = siblingInvoicesOf(siblingCandidates?.data ?? [], invoice);
  const sendMut = useSendInvoice();
  const voidMut = useVoidInvoice();
  const deleteMut = useDeleteInvoice();
  const pdfMut = useInvoicePdf();
  const updateMut = useUpdateInvoice();
  const shipmentMut = useUpdateInvoiceShipment();
  const [dueDateModal, setDueDateModal] = useState(false);
  const [dueDateInput, setDueDateInput] = useState("");
  const [shipmentModal, setShipmentModal] = useState(false);
  // Draft/Final PDF stage — null means follow the smart default (deriveInvoiceVariant).
  const [pdfVariantOverride, setPdfVariantOverride] = useState<InvoicePdfVariant | null>(null);

  if (isLoading || !invoice) {
    return (
      <SafeAreaView style={styles.safe} edges={["top", "left", "right"]}>
        <NavBar inlineTitle="Invoice" leading={<NavBackButton onPress={() => router.back()} />} />
        <View style={styles.center}>
          <ActivityIndicator color={ios.brand} />
        </View>
      </SafeAreaView>
    );
  }

  const s = statusPill(invoice.status);
  const balance = invoice.balanceDue ?? invoice.total;
  const isPaid = invoice.status === "PAID";
  const isVoid = invoice.status === "VOID";
  const canSend = invoice.status === "DRAFT";
  const canRecord = !isPaid && !isVoid;
  // Draft/Final PDF stage (mirrors web): smart default per stage, operator-overridable
  // via the toggle. Governs BOTH Share and Send.
  const defaultPdfVariant = deriveInvoiceVariant(invoice);
  const pdfVariant: InvoicePdfVariant = pdfVariantOverride ?? defaultPdfVariant;

  const handleSend = () => {
    if (!id) return;
    const customerEmail = invoice.customer?.email;
    if (!customerEmail) {
      chooseAction(
        "No email on file",
        `${invoice.customer?.businessName ?? "This customer"} has no email address saved. View the PDF to send it manually, or mark it as sent to update the status.`,
        [
          {
            label: "Mark as Sent",
            style: "default",
            onPress: () =>
              sendMut.mutate(
                { id },
                {
                  onSuccess: () => {
                    showToast("Invoice marked as sent");
                    refetch();
                  },
                  onError: (e: any) =>
                    showToast(e?.response?.data?.message ?? e?.message ?? "Try again."),
                },
              ),
          },
          {
            label: `Share ${pdfVariant} PDF`,
            style: "default",
            onPress: () => handlePdf(pdfVariant),
          },
          { label: "Cancel", style: "cancel" },
        ],
      );
      return;
    }
    sendMut.mutate(
      { id, email: customerEmail, variant: pdfVariant },
      {
        onSuccess: () => {
          showToast(`${pdfVariant === "draft" ? "Draft" : "Final"} invoice sent`);
          refetch();
        },
        onError: (e: any) => showToast(e?.response?.data?.message ?? e?.message ?? "Try again."),
      },
    );
  };

  const handleVoid = () => {
    if (!id) return;
    confirm(
      "Void invoice?",
      `${invoice.invoiceNumber} will be marked void.`,
      () =>
        voidMut.mutate(id, {
          onSuccess: () => {
            showToast("Invoice voided");
            refetch();
          },
          onError: (e: any) => showToast(e?.response?.data?.message ?? e?.message ?? "Try again."),
        }),
      { confirmText: "Void", destructive: true },
    );
  };

  /**
   * Permanently delete the invoice (server enforces no-payments). Reachable
   * only from the VOID state per the user's policy: "after voiding an invoice,
   * it should be able to delete them from mobile too." Operator-only — there
   * is no customer-facing delete affordance.
   */
  const handleDelete = () => {
    if (!id) return;
    confirm(
      "Delete invoice?",
      `${invoice.invoiceNumber} will be permanently removed. This cannot be undone.`,
      () =>
        deleteMut.mutate(id, {
          onSuccess: () => {
            showToast("Invoice deleted");
            router.back();
          },
          onError: (e: any) => showToast(e?.response?.data?.message ?? e?.message ?? "Try again."),
        }),
      { confirmText: "Delete", destructive: true },
    );
  };

  const handleSaveShipment = (carrier: string, trackingNumber: string) => {
    if (!id) return;
    shipmentMut.mutate(
      { id, shippingCarrier: carrier, shippingTrackingNumber: trackingNumber },
      {
        onSuccess: () => {
          showToast(carrier || trackingNumber ? "Shipment saved" : "Shipment cleared");
          setShipmentModal(false);
          refetch();
        },
        onError: (e: any) => showToast(e?.response?.data?.message ?? e?.message ?? "Try again."),
      },
    );
  };

  const handlePdf = (variant: InvoicePdfVariant) => {
    if (!id) return;
    pdfMut.mutate(
      { id, variant },
      {
        onSuccess: async (data) => {
          if (!data?.url) {
            showToast("PDF is still generating, try again in a moment.");
            return;
          }
          // Share the PDF directly to the OS/browser share sheet — no download.
          try {
            await sharePdf({
              url: data.url,
              filename: `${invoice.invoiceNumber || "invoice"}-${variant}.pdf`,
              dialogTitle: `${variant === "draft" ? "Draft" : "Final"} invoice ${
                invoice.invoiceNumber ?? ""
              }`.trim(),
            });
          } catch (e: any) {
            showToast(e?.message ?? "Couldn't share the PDF.");
          }
        },
        onError: (e: any) => showToast(e?.response?.data?.message ?? e?.message ?? "Try again."),
      },
    );
  };

  return (
    <SafeAreaView style={styles.safe} edges={["top", "left", "right"]}>
      <NavBar
        inlineTitle={invoice.invoiceNumber}
        leading={<NavBackButton label="Invoices" onPress={() => router.back()} />}
      />

      <ScrollView showsVerticalScrollIndicator={false}>
        <View style={{ padding: 16, gap: 14 }}>
          <View style={styles.card}>
            <Pill variant={s.variant} dot>
              {s.label}
            </Pill>
            <Text style={styles.customer}>{invoice.customer?.businessName ?? "Customer"}</Text>
            <Text style={styles.balance}>{fmtCurrency(balance)}</Text>
            <Text style={styles.balanceSub}>
              of {fmtCurrency(invoice.total)} · paid {fmtCurrency(invoice.paidAmount ?? 0)}
            </Text>
            <Pressable
              style={styles.dueRow}
              onPress={() => {
                setDueDateInput(invoice.dueDate ? invoice.dueDate.slice(0, 10) : "");
                setDueDateModal(true);
              }}
              hitSlop={4}
            >
              <Text style={styles.due}>
                {invoice.dueDate
                  ? `Due ${new Date(invoice.dueDate).toLocaleDateString()}`
                  : "Set due date"}
              </Text>
              <Ionicons name="pencil-outline" size={12} color={ios.label3} />
            </Pressable>
          </View>

          {siblingInvoices.length > 0 ? (
            <View style={styles.card}>
              <Text style={styles.cardTitle}>Also billed on this order</Text>
              <Text style={styles.siblingHint}>
                This sale was split into {siblingInvoices.length + 1} invoices by regulated
                category.
              </Text>
              <View style={{ gap: 8, marginTop: 6 }}>
                {siblingInvoices.map((sib) => {
                  const sp = statusPill(sib.status);
                  return (
                    <Pressable
                      key={sib.id}
                      style={styles.siblingRow}
                      onPress={() => router.push(`/(operator)/invoices/${sib.id}`)}
                    >
                      <Text style={styles.siblingNumber} numberOfLines={1}>
                        {sib.invoiceNumber}
                      </Text>
                      <Pill variant={sp.variant} small>
                        {sp.label}
                      </Pill>
                      <Text style={styles.siblingTotal}>{fmtCurrency(sib.total)}</Text>
                      <Ionicons name="chevron-forward" size={14} color={ios.label3} />
                    </Pressable>
                  );
                })}
              </View>
            </View>
          ) : null}

          {/* Draft/Final PDF stage — one toggle governs both Share and Send
              (mirrors the web invoice-detail). Smart-defaults per stage. */}
          <View style={styles.variantRow}>
            <Text style={styles.variantLabel}>PDF STAGE</Text>
            <View style={{ flex: 1 }}>
              <SegmentedControl
                items={["Draft", "Final"]}
                value={pdfVariant === "draft" ? "Draft" : "Final"}
                onChange={(v) => setPdfVariantOverride(v === "Draft" ? "draft" : "final")}
              />
            </View>
          </View>

          {/* Action grid */}
          <View style={styles.actionsGrid}>
            {canRecord ? (
              <ActionTile
                icon="cash-outline"
                label="Record payment"
                onPress={() => router.push(`/(operator)/invoices/${id}/record-payment`)}
              />
            ) : null}
            {canSend ? (
              <ActionTile
                icon="paper-plane-outline"
                label={sendMut.isPending ? "Sending…" : "Send"}
                onPress={handleSend}
              />
            ) : null}
            <ActionTile
              icon="share-outline"
              label={
                pdfMut.isPending
                  ? "Loading…"
                  : `Share ${pdfVariant === "draft" ? "draft" : "final"}`
              }
              onPress={() => handlePdf(pdfVariant)}
            />
            {canWriteOff(invoice.status) ? (
              <ActionTile
                icon="remove-circle-outline"
                label="Write off"
                tone="danger"
                onPress={() => router.push(`/(operator)/invoices/${id}/write-off`)}
              />
            ) : null}
            {!isVoid ? (
              <ActionTile icon="ban-outline" label="Void" tone="danger" onPress={handleVoid} />
            ) : (
              // Voided invoices can be deleted entirely (server still rejects
              // if payments exist). Mirrors the web's delete affordance.
              <ActionTile
                icon="trash-outline"
                label={deleteMut.isPending ? "Deleting…" : "Delete invoice"}
                tone="danger"
                onPress={handleDelete}
              />
            )}
          </View>

          {/* Items */}
          {invoice.items && invoice.items.length > 0 ? (
            <View style={styles.card}>
              <Text style={styles.cardTitle}>Items</Text>
              {invoice.items.map((it, i) => (
                <View
                  key={it.id}
                  style={[
                    styles.itemRow,
                    i > 0 && {
                      borderTopWidth: StyleSheet.hairlineWidth,
                      borderTopColor: ios.separator,
                    },
                  ]}
                >
                  <View style={{ flex: 1, minWidth: 0 }}>
                    <Text style={styles.itemName} numberOfLines={1}>
                      {it.description}
                    </Text>
                    <Text style={styles.itemSub}>
                      {it.boxes != null || it.pieces != null
                        ? // Boxed line: unitPrice is the BOX price — "qty × price"
                          // would read as pieces × box-price (visually wrong).
                          `${formatQtySplit({ qty: it.qty, boxes: it.boxes, pieces: it.pieces })} @ ${fmtCurrency(it.unitPrice)}/box`
                        : `${it.qty} × ${fmtCurrency(it.unitPrice)}`}
                    </Text>
                    {it.notes?.trim() ? (
                      <Text style={[styles.itemSub, { fontStyle: "italic" }]} numberOfLines={2}>
                        {it.notes}
                      </Text>
                    ) : null}
                    {it.priceType === "MANUAL" &&
                    it.originalPrice != null &&
                    Number(it.unitPrice) > Number(it.originalPrice) ? (
                      <Text style={{ color: ios.system.greenInk, fontSize: 12, fontWeight: "600" }}>
                        Upsell
                      </Text>
                    ) : null}
                  </View>
                  <Text style={styles.itemTotal}>{fmtCurrency(it.subtotal)}</Text>
                </View>
              ))}
              <View style={styles.totalRow}>
                <Text style={styles.totalLabel}>Subtotal</Text>
                <Text style={styles.totalValue}>{fmtCurrency(invoice.subtotal)}</Text>
              </View>
              {invoice.taxAmount ? (
                <View style={styles.totalRow}>
                  <Text style={styles.totalLabel}>Tax</Text>
                  <Text style={styles.totalValue}>{fmtCurrency(invoice.taxAmount)}</Text>
                </View>
              ) : null}
              {invoice.discount ? (
                <View style={styles.totalRow}>
                  <Text style={styles.totalLabel}>Discount</Text>
                  <Text style={styles.totalValue}>{fmtCurrency(invoice.discount)}</Text>
                </View>
              ) : null}
              {Number(invoice.shippingFee ?? 0) > 0 ? (
                <View style={styles.totalRow}>
                  <Text style={styles.totalLabel}>Shipping</Text>
                  <Text style={styles.totalValue}>{fmtCurrency(invoice.shippingFee)}</Text>
                </View>
              ) : null}
              <View style={[styles.totalRow, { borderTopWidth: 0 }]}>
                <Text style={styles.totalLabelMain}>Total</Text>
                <Text style={styles.totalValueMain}>{fmtCurrency(invoice.total)}</Text>
              </View>
            </View>
          ) : null}

          {/* Carrier shipment — editable on any non-void invoice. */}
          {!isVoid ? (
            <ShipmentSection shipment={invoice} onEdit={() => setShipmentModal(true)} />
          ) : null}

          {/* Payments */}
          {invoice.payments && invoice.payments.length > 0 ? (
            <View style={styles.card}>
              <Text style={styles.cardTitle}>Payments</Text>
              {invoice.payments.map((p, i) => (
                <View
                  key={p.id}
                  style={[
                    styles.payRow,
                    i > 0 && {
                      borderTopWidth: StyleSheet.hairlineWidth,
                      borderTopColor: ios.separator,
                    },
                  ]}
                >
                  <View style={{ flex: 1 }}>
                    <Text style={styles.payMethod}>{p.method}</Text>
                    <Text style={styles.payMeta}>
                      {new Date(p.paidAt ?? p.createdAt).toLocaleDateString()}
                    </Text>
                    {p.reference ? <Text style={styles.payMeta}>Ref: {p.reference}</Text> : null}
                    {p.notes ? <Text style={styles.payMeta}>{p.notes}</Text> : null}
                    {/* Credit-note reason via relation (read-time, never copied) —
                        `creditNote` isn't in the admin.ts payment type yet, so
                        this arrives untyped at runtime; cast defensively. */}
                    {p.method === "CREDIT_NOTE" && (p as any).creditNote?.reason ? (
                      <Text style={styles.payMeta}>
                        Credit {(p as any).creditNote.creditNoteNumber} —{" "}
                        {(p as any).creditNote.reason}
                      </Text>
                    ) : null}
                  </View>
                  <Text style={styles.payAmount}>+{fmtCurrency(p.amount)}</Text>
                  {isPaymentEditable(p.method, p.status, invoice.status) ? (
                    <Pressable
                      hitSlop={8}
                      style={styles.payEditBtn}
                      onPress={() =>
                        router.push(`/(operator)/invoices/${id}/payments/${p.id}/edit`)
                      }
                      accessibilityLabel="Edit payment"
                    >
                      <Ionicons name="pencil-outline" size={16} color={ios.brand} />
                    </Pressable>
                  ) : null}
                </View>
              ))}
            </View>
          ) : null}
        </View>
        <View style={{ height: 24 }} />
      </ScrollView>

      {/* Due date editor modal */}
      <Modal
        visible={dueDateModal}
        transparent
        animationType="fade"
        onRequestClose={() => setDueDateModal(false)}
      >
        <Pressable style={styles.modalOverlay} onPress={() => setDueDateModal(false)}>
          <Pressable style={styles.modalCard} onPress={(e) => e.stopPropagation()}>
            <Text style={styles.modalTitle}>Edit due date</Text>
            <Text style={styles.modalLabel}>Format: YYYY-MM-DD</Text>
            <TextInput
              style={styles.modalInput}
              value={dueDateInput}
              onChangeText={setDueDateInput}
              placeholder={new Date().toISOString().slice(0, 10)}
              placeholderTextColor={ios.label3}
              keyboardType="numbers-and-punctuation"
              autoFocus
            />
            <View style={{ flexDirection: "row", gap: 10, marginTop: 8 }}>
              <Pressable
                style={[styles.modalBtn, { flex: 1, backgroundColor: ios.fill3 }]}
                onPress={() => setDueDateModal(false)}
              >
                <Text style={[styles.modalBtnText, { color: ios.label }]}>Cancel</Text>
              </Pressable>
              <Pressable
                style={[
                  styles.modalBtn,
                  { flex: 1, backgroundColor: ios.brand },
                  updateMut.isPending && { opacity: 0.6 },
                ]}
                onPress={() => {
                  if (!id) return;
                  updateMut.mutate(
                    { id, dueDate: dueDateInput.trim() || undefined },
                    {
                      onSuccess: () => {
                        showToast("Due date updated");
                        setDueDateModal(false);
                        refetch();
                      },
                      onError: (e: any) =>
                        showToast(e?.response?.data?.message ?? e?.message ?? "Try again."),
                    },
                  );
                }}
                disabled={updateMut.isPending}
              >
                {updateMut.isPending ? (
                  <ActivityIndicator color="#fff" size="small" />
                ) : (
                  <Text style={[styles.modalBtnText, { color: "#fff" }]}>Save</Text>
                )}
              </Pressable>
            </View>
          </Pressable>
        </Pressable>
      </Modal>

      <ShipmentEditModal
        open={shipmentModal}
        shipment={invoice}
        saving={shipmentMut.isPending}
        onClose={() => setShipmentModal(false)}
        onSave={handleSaveShipment}
      />
    </SafeAreaView>
  );
}

function ActionTile({
  icon,
  label,
  onPress,
  tone = "default",
}: {
  icon: keyof typeof Ionicons.glyphMap;
  label: string;
  onPress: () => void;
  tone?: "default" | "danger";
}) {
  const isDanger = tone === "danger";
  return (
    <Pressable style={[styles.tile, isDanger && styles.tileDanger]} onPress={onPress}>
      <Ionicons name={icon} size={22} color={isDanger ? ios.system.red : ios.brand} />
      <Text style={[styles.tileLabel, isDanger && { color: ios.system.red }]}>{label}</Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: ios.bg },
  center: { padding: 40, alignItems: "center" },
  card: { backgroundColor: ios.bgElev, borderRadius: 14, padding: 14 },
  cardTitle: { fontSize: 15, fontFamily: "Inter_600SemiBold", color: ios.label, marginBottom: 8 },
  siblingHint: { fontSize: 12, fontFamily: "Inter_400Regular", color: ios.label2 },
  siblingRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    backgroundColor: ios.fill3,
    borderRadius: 10,
    paddingHorizontal: 10,
    paddingVertical: 9,
  },
  siblingNumber: { flex: 1, fontSize: 13, fontFamily: "Inter_600SemiBold", color: ios.label },
  siblingTotal: {
    fontSize: 13,
    fontFamily: "Inter_600SemiBold",
    color: ios.label,
    fontVariant: ["tabular-nums"],
  },
  customer: { fontSize: 14, fontFamily: "Inter_500Medium", color: ios.label2, marginTop: 8 },
  balance: {
    fontSize: 32,
    fontFamily: "Inter_700Bold",
    color: ios.label,
    marginTop: 6,
    fontVariant: ["tabular-nums"],
    letterSpacing: -0.8,
  },
  balanceSub: { fontSize: 12, fontFamily: "Inter_400Regular", color: ios.label2, marginTop: 2 },
  due: { fontSize: 13, fontFamily: "Inter_500Medium", color: ios.label2 },
  dueRow: { flexDirection: "row", alignItems: "center", gap: 5, marginTop: 6 },
  modalOverlay: {
    flex: 1,
    backgroundColor: "rgba(0,0,0,0.45)",
    alignItems: "center",
    justifyContent: "center",
    padding: 24,
  },
  modalCard: {
    backgroundColor: ios.bgElev,
    borderRadius: 20,
    padding: 20,
    width: "100%",
    maxWidth: 340,
    gap: 6,
  },
  modalTitle: { fontSize: 17, fontFamily: "Inter_700Bold", color: ios.label },
  modalLabel: { fontSize: 13, fontFamily: "Inter_400Regular", color: ios.label2 },
  modalInput: {
    backgroundColor: ios.fill3,
    borderRadius: 10,
    paddingHorizontal: 12,
    paddingVertical: 10,
    fontSize: 16,
    fontFamily: "Inter_400Regular",
    color: ios.label,
    marginTop: 4,
  },
  modalBtn: {
    paddingVertical: 13,
    borderRadius: 12,
    alignItems: "center",
    justifyContent: "center",
  },
  modalBtnText: { fontSize: 15, fontFamily: "Inter_600SemiBold" },
  actionsGrid: { flexDirection: "row", flexWrap: "wrap", gap: 10 },
  variantRow: { flexDirection: "row", alignItems: "center", gap: 12, marginBottom: 12 },
  variantLabel: {
    fontSize: 11,
    fontFamily: "Inter_600SemiBold",
    color: ios.label2,
    letterSpacing: 0.8,
  },
  tile: {
    flexBasis: "47%",
    flexGrow: 1,
    backgroundColor: ios.bgElev,
    borderRadius: 14,
    padding: 18,
    alignItems: "center",
    gap: 8,
  },
  tileDanger: { backgroundColor: ios.system.redWash },
  tileLabel: {
    fontSize: 13,
    fontFamily: "Inter_600SemiBold",
    color: ios.label,
    textAlign: "center",
  },
  itemRow: { flexDirection: "row", alignItems: "center", paddingVertical: 8, gap: 10 },
  itemName: { fontSize: 14, fontFamily: "Inter_500Medium", color: ios.label },
  itemSub: { fontSize: 12, fontFamily: "Inter_400Regular", color: ios.label2, marginTop: 2 },
  itemTotal: {
    fontSize: 14,
    fontFamily: "Inter_600SemiBold",
    color: ios.label,
    fontVariant: ["tabular-nums"],
  },
  totalRow: {
    flexDirection: "row",
    justifyContent: "space-between",
    paddingTop: 8,
    marginTop: 8,
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
  payRow: { flexDirection: "row", alignItems: "center", paddingVertical: 10, gap: 10 },
  payMethod: { fontSize: 14, fontFamily: "Inter_500Medium", color: ios.label },
  payMeta: { fontSize: 12, fontFamily: "Inter_400Regular", color: ios.label2, marginTop: 2 },
  payAmount: {
    fontSize: 14,
    fontFamily: "Inter_700Bold",
    color: ios.system.greenInk,
    fontVariant: ["tabular-nums"],
  },
  payEditBtn: {
    width: 30,
    height: 30,
    borderRadius: 15,
    backgroundColor: ios.fill3,
    alignItems: "center",
    justifyContent: "center",
  },
});
