import { useState } from "react";
import { Pressable, ScrollView, StyleSheet, Text, TextInput, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { Ionicons } from "@expo/vector-icons";
import { useLocalSearchParams, useRouter } from "expo-router";
import { ActivityIndicator } from "react-native";
import { ios } from "@routeflow/ui/tokens";
import { NavBackButton, NavBar, Pill } from "@routeflow/ui/mobile/ios";
import {
  useExpense,
  useUpdateExpense,
  useDeleteExpense,
  useExpenseCategories,
  type ExpenseStatus,
} from "../../../lib/api/expenses";
import { useSuppliers } from "../../../lib/api/purchase-orders";
import { showToast } from "../../../lib/toast";
import { confirm } from "../../../lib/confirm";
import { OptionPickerSheet } from "../../../components/OptionPickerSheet";
import {
  PAYMENT_METHOD_LABELS,
  SELECTABLE_METHOD_OPTIONS,
  type AnyPaymentMethod,
} from "../../../lib/payment-methods";

function statusPill(status: ExpenseStatus) {
  switch (status) {
    case "PENDING":
      return { variant: "orange" as const, label: "Pending" };
    case "RECEIVED":
      return { variant: "orange" as const, label: "Received" };
    case "PAID":
      return { variant: "green" as const, label: "Paid" };
    case "VOID":
      return { variant: "gray" as const, label: "Void" };
  }
}

function formatCurrency(n: number | string | undefined): string {
  const v = typeof n === "string" ? Number(n) : (n ?? 0);
  return `$${(Number.isFinite(v) ? v : 0).toFixed(2)}`;
}

/** Shared labels, with a title-case fallback for legacy values (CARD, BANK_TRANSFER). */
const methodLabel = (m: string): string =>
  PAYMENT_METHOD_LABELS[m as AnyPaymentMethod] ??
  m.charAt(0) + m.slice(1).toLowerCase().replace("_", " ");

export default function ExpenseDetailScreen() {
  const router = useRouter();
  const { id } = useLocalSearchParams<{ id: string }>();
  const { data: expense, isLoading } = useExpense(id);
  const updateMut = useUpdateExpense();
  const deleteMut = useDeleteExpense();
  const { data: categories } = useExpenseCategories();
  const { data: suppliers } = useSuppliers();

  const [editing, setEditing] = useState(false);
  const [amount, setAmount] = useState("");
  const [date, setDate] = useState("");
  const [description, setDescription] = useState("");
  const [categoryId, setCategoryId] = useState("");
  const [categoryName, setCategoryName] = useState("");
  const [supplierId, setSupplierId] = useState("");
  const [supplierName, setSupplierName] = useState("");
  const [paymentMethod, setPaymentMethod] = useState("");
  const [notes, setNotes] = useState("");
  const [referenceNumber, setReferenceNumber] = useState("");
  const [catPickerOpen, setCatPickerOpen] = useState(false);
  const [supPickerOpen, setSupPickerOpen] = useState(false);
  const [pmPickerOpen, setPmPickerOpen] = useState(false);

  if (isLoading || !expense) {
    return (
      <SafeAreaView style={styles.safe} edges={["top", "left", "right"]}>
        <NavBar
          inlineTitle="Expense"
          leading={<NavBackButton label="Back" onPress={() => router.back()} />}
        />
        <View style={styles.center}>
          <ActivityIndicator color={ios.brand} />
        </View>
      </SafeAreaView>
    );
  }

  const p = statusPill(expense.status);

  const startEditing = () => {
    setAmount(String(expense.amount));
    setDate(expense.date.slice(0, 10));
    setDescription(expense.description ?? "");
    setCategoryId(expense.category?.id ?? "");
    setCategoryName(expense.category?.name ?? "");
    setSupplierId(expense.supplier?.id ?? "");
    setSupplierName(expense.supplier?.name ?? "");
    setPaymentMethod(expense.paymentMethod ?? "");
    setNotes(expense.notes ?? "");
    setReferenceNumber(expense.referenceNumber ?? "");
    setEditing(true);
  };

  const cancelEditing = () => setEditing(false);

  const saveEdit = () => {
    const parsedAmount = Number(amount);
    if (!Number.isFinite(parsedAmount) || parsedAmount <= 0) {
      showToast("Enter a valid amount.");
      return;
    }
    const dto: any = { id, amount: parsedAmount, date };
    if (description.trim()) dto.description = description.trim();
    if (categoryId) dto.categoryId = categoryId;
    else dto.categoryId = null;
    if (supplierId) dto.supplierId = supplierId;
    else dto.supplierId = null;
    if (paymentMethod) dto.paymentMethod = paymentMethod;
    if (notes.trim()) dto.notes = notes.trim();
    if (referenceNumber.trim()) dto.referenceNumber = referenceNumber.trim();

    updateMut.mutate(dto, {
      onSuccess: () => {
        showToast("Expense updated");
        setEditing(false);
      },
      onError: (e: any) => showToast(e?.response?.data?.message ?? e?.message ?? "Try again."),
    });
  };

  const onDelete = () =>
    confirm(
      "Delete expense?",
      "This cannot be undone.",
      () =>
        deleteMut.mutate(id, {
          onSuccess: () => {
            showToast("Expense deleted");
            router.back();
          },
          onError: (e: any) => showToast(e?.response?.data?.message ?? e?.message ?? "Try again."),
        }),
      { confirmText: "Delete", destructive: true },
    );

  const pickCategory = () => setCatPickerOpen(true);
  const pickSupplier = () => setSupPickerOpen(true);
  const pickPaymentMethod = () => setPmPickerOpen(true);

  const dateLabel = new Date(expense.date).toLocaleDateString(undefined, {
    month: "long",
    day: "numeric",
    year: "numeric",
  });

  return (
    <SafeAreaView style={styles.safe} edges={["top", "left", "right"]}>
      <NavBar
        inlineTitle="Expense"
        leading={<NavBackButton label="Back" onPress={() => router.back()} />}
        trailing={
          editing ? (
            <Pressable onPress={cancelEditing} hitSlop={8}>
              <Text style={styles.navCancel}>Cancel</Text>
            </Pressable>
          ) : expense.status !== "VOID" ? (
            <Pressable onPress={startEditing} hitSlop={8}>
              <Text style={styles.navEdit}>Edit</Text>
            </Pressable>
          ) : undefined
        }
      />

      <ScrollView showsVerticalScrollIndicator={false}>
        {/* Header card */}
        <View style={styles.headerCard}>
          <View style={styles.headerRow}>
            <View style={{ flex: 1 }}>
              <Text style={styles.amount}>{formatCurrency(expense.amount)}</Text>
              <Text style={styles.dateLine}>{dateLabel}</Text>
            </View>
            <Pill variant={p.variant} dot>
              {p.label}
            </Pill>
          </View>
          {expense.description ? (
            <Text style={styles.description}>{expense.description}</Text>
          ) : null}
        </View>

        {/* Details — only render when at least one detail field exists */}
        {expense.category ||
        expense.supplier ||
        expense.paymentMethod ||
        expense.referenceNumber ||
        expense.notes ? (
          <View style={styles.section}>
            <Text style={styles.sectionTitle}>Details</Text>
            <View style={styles.detailCard}>
              {expense.category ? (
                <DetailRow label="Category" value={expense.category.name} />
              ) : null}
              {expense.supplier ? (
                <DetailRow label="Supplier" value={expense.supplier.name} />
              ) : null}
              {expense.paymentMethod ? (
                <DetailRow label="Payment" value={methodLabel(expense.paymentMethod)} />
              ) : null}
              {expense.referenceNumber ? (
                <DetailRow label="Reference #" value={expense.referenceNumber} />
              ) : null}
              {expense.notes ? <DetailRow label="Notes" value={expense.notes} /> : null}
            </View>
          </View>
        ) : null}

        {/* Edit form */}
        {editing ? (
          <View style={styles.section}>
            <Text style={styles.sectionTitle}>Edit expense</Text>
            <View style={styles.editCard}>
              <EditRow label="Amount ($)">
                <EditInput
                  value={amount}
                  onChangeText={setAmount}
                  placeholder="0.00"
                  keyboardType="decimal-pad"
                />
              </EditRow>
              <EditRow label="Date (YYYY-MM-DD)">
                <EditInput
                  value={date}
                  onChangeText={setDate}
                  placeholder="2025-06-01"
                  keyboardType="numbers-and-punctuation"
                />
              </EditRow>
              <EditRow label="Description">
                <EditInput
                  value={description}
                  onChangeText={setDescription}
                  placeholder="What was this for?"
                />
              </EditRow>
              <EditRow label="Category">
                <Pressable style={styles.editPicker} onPress={pickCategory}>
                  <Text style={[styles.editPickerText, !categoryName && styles.placeholder]}>
                    {categoryName || "Select…"}
                  </Text>
                </Pressable>
              </EditRow>
              <EditRow label="Supplier">
                <Pressable style={styles.editPicker} onPress={pickSupplier}>
                  <Text style={[styles.editPickerText, !supplierName && styles.placeholder]}>
                    {supplierName || "Select…"}
                  </Text>
                </Pressable>
              </EditRow>
              <EditRow label="Payment method">
                <Pressable style={styles.editPicker} onPress={pickPaymentMethod}>
                  <Text style={[styles.editPickerText, !paymentMethod && styles.placeholder]}>
                    {paymentMethod ? methodLabel(paymentMethod) : "Select…"}
                  </Text>
                </Pressable>
              </EditRow>
              <EditRow label="Reference #">
                <EditInput
                  value={referenceNumber}
                  onChangeText={setReferenceNumber}
                  placeholder="INV-001…"
                />
              </EditRow>
              <EditRow label="Notes" last>
                <EditInput
                  value={notes}
                  onChangeText={setNotes}
                  placeholder="Additional details…"
                  multiline
                  numberOfLines={2}
                  style={{ minHeight: 56, textAlignVertical: "top" }}
                />
              </EditRow>
            </View>
            <Pressable
              style={[styles.saveBtn, updateMut.isPending && { opacity: 0.6 }]}
              onPress={saveEdit}
              disabled={updateMut.isPending}
            >
              <Ionicons name="checkmark" size={16} color="#fff" />
              <Text style={styles.saveBtnText}>
                {updateMut.isPending ? "Saving…" : "Save changes"}
              </Text>
            </Pressable>
          </View>
        ) : null}

        {/* Delete */}
        {expense.status !== "VOID" && !editing ? (
          <View style={styles.dangerSection}>
            <Pressable style={styles.deleteBtn} onPress={onDelete} disabled={deleteMut.isPending}>
              <Text style={styles.deleteBtnText}>
                {deleteMut.isPending ? "Deleting…" : "Delete expense"}
              </Text>
            </Pressable>
          </View>
        ) : null}

        <View style={{ height: 40 }} />
      </ScrollView>

      <OptionPickerSheet
        visible={catPickerOpen}
        title="Category"
        options={(categories ?? []).map((c) => ({ id: c.id, label: c.name }))}
        selectedId={categoryId}
        nullable
        nullLabel="None"
        onClose={() => setCatPickerOpen(false)}
        onSelect={(opt) => {
          setCategoryId(opt.id);
          setCategoryName(opt.id ? opt.label : "");
          setCatPickerOpen(false);
        }}
      />
      <OptionPickerSheet
        visible={supPickerOpen}
        title="Supplier"
        options={(suppliers ?? []).map((s: any) => ({ id: s.id, label: s.name }))}
        selectedId={supplierId}
        nullable
        nullLabel="None"
        onClose={() => setSupPickerOpen(false)}
        onSelect={(opt) => {
          setSupplierId(opt.id);
          setSupplierName(opt.id ? opt.label : "");
          setSupPickerOpen(false);
        }}
      />
      <OptionPickerSheet
        visible={pmPickerOpen}
        title="Payment method"
        options={SELECTABLE_METHOD_OPTIONS}
        selectedId={paymentMethod}
        onClose={() => setPmPickerOpen(false)}
        onSelect={(opt) => {
          setPaymentMethod(opt.id);
          setPmPickerOpen(false);
        }}
      />
    </SafeAreaView>
  );
}

function DetailRow({ label, value }: { label: string; value: string }) {
  return (
    <View style={styles.detailRow}>
      <Text style={styles.detailLabel}>{label}</Text>
      <Text style={styles.detailValue} numberOfLines={2}>
        {value}
      </Text>
    </View>
  );
}

function EditRow({
  label,
  children,
  last,
}: {
  label: string;
  children: React.ReactNode;
  last?: boolean;
}) {
  return (
    <View style={[styles.editRow, !last && styles.editRowBorder]}>
      <Text style={styles.editLabel}>{label}</Text>
      <View style={styles.editControl}>{children}</View>
    </View>
  );
}

function EditInput({
  value,
  onChangeText,
  placeholder,
  keyboardType,
  multiline,
  numberOfLines,
  style,
}: {
  value: string;
  onChangeText: (v: string) => void;
  placeholder?: string;
  keyboardType?: any;
  multiline?: boolean;
  numberOfLines?: number;
  style?: any;
}) {
  return (
    <TextInput
      value={value}
      onChangeText={onChangeText}
      placeholder={placeholder}
      placeholderTextColor={ios.label3}
      keyboardType={keyboardType ?? "default"}
      multiline={multiline}
      numberOfLines={numberOfLines}
      style={[styles.editInputText, style]}
    />
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: ios.bg },
  center: { flex: 1, alignItems: "center", justifyContent: "center" },
  navEdit: { fontSize: 15, fontFamily: "Inter_500Medium", color: ios.brand },
  navCancel: { fontSize: 15, fontFamily: "Inter_500Medium", color: ios.system.redInk },
  headerCard: {
    margin: 16,
    backgroundColor: ios.bgElev,
    borderRadius: 16,
    padding: 18,
    gap: 6,
  },
  headerRow: { flexDirection: "row", alignItems: "flex-start", gap: 10 },
  amount: { fontSize: 28, fontFamily: "Inter_700Bold", color: ios.label, letterSpacing: -0.6 },
  dateLine: { fontSize: 13, fontFamily: "Inter_400Regular", color: ios.label2, marginTop: 2 },
  description: { fontSize: 15, fontFamily: "Inter_400Regular", color: ios.label2 },
  section: { paddingHorizontal: 16, paddingBottom: 16 },
  sectionTitle: {
    fontSize: 13,
    fontFamily: "Inter_600SemiBold",
    color: ios.label2,
    letterSpacing: 0.4,
    textTransform: "uppercase",
    marginBottom: 8,
  },
  detailCard: { backgroundColor: ios.bgElev, borderRadius: 12, overflow: "hidden" },
  detailRow: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "flex-start",
    paddingHorizontal: 16,
    paddingVertical: 12,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: ios.separator,
    gap: 12,
  },
  detailLabel: { fontSize: 14, fontFamily: "Inter_500Medium", color: ios.label2, flexShrink: 0 },
  detailValue: {
    fontSize: 14,
    fontFamily: "Inter_400Regular",
    color: ios.label,
    flex: 1,
    textAlign: "right",
  },
  editCard: { backgroundColor: ios.bgElev, borderRadius: 12, overflow: "hidden", marginBottom: 12 },
  editRow: { paddingHorizontal: 16, paddingVertical: 12, gap: 6 },
  editRowBorder: { borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: ios.separator },
  editLabel: {
    fontSize: 12,
    fontFamily: "Inter_600SemiBold",
    color: ios.label2,
    letterSpacing: 0.3,
    textTransform: "uppercase",
  },
  editControl: {},
  editInputText: {
    fontSize: 15,
    fontFamily: "Inter_400Regular",
    color: ios.label,
    paddingVertical: 4,
  },
  editPicker: { paddingVertical: 4 },
  editPickerText: { fontSize: 15, fontFamily: "Inter_400Regular", color: ios.label },
  placeholder: { color: ios.label3 },
  saveBtn: {
    backgroundColor: ios.brand,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 8,
    paddingVertical: 14,
    borderRadius: 14,
  },
  saveBtnText: { color: "#fff", fontSize: 15, fontFamily: "Inter_600SemiBold" },
  dangerSection: { paddingHorizontal: 16, paddingTop: 8 },
  deleteBtn: {
    backgroundColor: ios.fill3,
    paddingVertical: 14,
    borderRadius: 14,
    alignItems: "center",
  },
  deleteBtnText: { color: ios.system.redInk, fontSize: 15, fontFamily: "Inter_500Medium" },
});
