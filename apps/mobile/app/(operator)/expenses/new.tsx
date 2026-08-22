import { useState } from "react";
import { Modal, Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import { useRouter } from "expo-router";
import { Ionicons } from "@expo/vector-icons";
import { ios } from "@routeflow/ui/tokens";
import { FormField, FormSection, FormSheet, FormTextInput } from "../../../components/FormSheet";
import { OptionPickerSheet } from "../../../components/OptionPickerSheet";
import { useCreateExpense, useExpenseCategories } from "../../../lib/api/expenses";
import { useSuppliers } from "../../../lib/api/purchase-orders";
import { showToast } from "../../../lib/toast";
import {
  PAYMENT_METHOD_LABELS,
  SELECTABLE_METHOD_OPTIONS,
  type AnyPaymentMethod,
} from "../../../lib/payment-methods";

/** Shared labels, with a title-case fallback for legacy values (CARD, BANK_TRANSFER). */
const methodLabel = (m: string): string =>
  PAYMENT_METHOD_LABELS[m as AnyPaymentMethod] ??
  m.charAt(0) + m.slice(1).toLowerCase().replace("_", " ");

const CATEGORY_ICON: Record<string, keyof typeof Ionicons.glyphMap> = {
  fuel: "speedometer-outline",
  gas: "speedometer-outline",
  maintenance: "construct-outline",
  repair: "construct-outline",
  vehicle: "car-outline",
  insurance: "shield-checkmark-outline",
  supplies: "cube-outline",
  food: "restaurant-outline",
  meal: "restaurant-outline",
  utilities: "flash-outline",
  rent: "home-outline",
  salary: "people-outline",
  payroll: "people-outline",
  marketing: "megaphone-outline",
  office: "briefcase-outline",
  tax: "receipt-outline",
  other: "ellipsis-horizontal-outline",
};

function iconForCategory(name: string): keyof typeof Ionicons.glyphMap {
  const lower = name.toLowerCase();
  for (const key of Object.keys(CATEGORY_ICON)) {
    if (lower.includes(key)) return CATEGORY_ICON[key];
  }
  return "pricetag-outline";
}

export default function NewExpenseScreen() {
  const router = useRouter();
  const createMut = useCreateExpense();
  const { data: categories } = useExpenseCategories();
  const { data: suppliers } = useSuppliers();

  const [date, setDate] = useState("");
  const [amount, setAmount] = useState("");
  const [description, setDescription] = useState("");
  const [categoryId, setCategoryId] = useState("");
  const [categoryName, setCategoryName] = useState("");
  const [supplierId, setSupplierId] = useState("");
  const [supplierName, setSupplierName] = useState("");
  const [paymentMethod, setPaymentMethod] = useState("");
  const [notes, setNotes] = useState("");
  const [referenceNumber, setReferenceNumber] = useState("");
  const [categoryPickerOpen, setCategoryPickerOpen] = useState(false);
  const [paymentPickerOpen, setPaymentPickerOpen] = useState(false);
  const [supplierPickerOpen, setSupplierPickerOpen] = useState(false);

  const submit = () => {
    const parsedAmount = Number(amount);
    if (!amount || !Number.isFinite(parsedAmount) || parsedAmount <= 0) {
      showToast("Enter a valid expense amount.");
      return;
    }

    const dto: any = { amount: parsedAmount };
    if (date.trim()) dto.date = date.trim();
    else dto.date = new Date().toISOString().slice(0, 10);
    if (description.trim()) dto.description = description.trim();
    if (categoryId) dto.categoryId = categoryId;
    if (supplierId) dto.supplierId = supplierId;
    if (paymentMethod) dto.paymentMethod = paymentMethod;
    if (notes.trim()) dto.notes = notes.trim();
    if (referenceNumber.trim()) dto.referenceNumber = referenceNumber.trim();

    createMut.mutate(dto, {
      onSuccess: (expense) => router.replace(`/(operator)/expenses/${expense.id}`),
      onError: (e: any) => showToast(e?.response?.data?.message ?? e?.message ?? "Try again."),
    });
  };

  return (
    <FormSheet
      title="New Expense"
      submitLabel={createMut.isPending ? "Creating…" : "Create expense"}
      submitting={createMut.isPending}
      onSubmit={submit}
    >
      {/* Scan shortcut banner */}
      <Pressable
        style={styles.scanBanner}
        onPress={() => router.push("/(operator)/vendor-bills/scan" as any)}
      >
        <Ionicons name="scan-outline" size={18} color={ios.brand} />
        <View style={{ flex: 1 }}>
          <Text style={styles.scanTitle}>Have a paper receipt?</Text>
          <Text style={styles.scanSub}>Scan it to extract amount, vendor and date</Text>
        </View>
        <Ionicons name="chevron-forward" size={14} color={ios.brand} />
      </Pressable>

      <FormSection title="Amount">
        <FormField label="Amount ($)">
          <FormTextInput
            value={amount}
            onChangeText={setAmount}
            placeholder="0.00"
            keyboardType="decimal-pad"
          />
        </FormField>
        <FormField label="Date" hint="YYYY-MM-DD">
          <FormTextInput
            value={date}
            onChangeText={setDate}
            placeholder={new Date().toISOString().slice(0, 10)}
            keyboardType="numbers-and-punctuation"
          />
        </FormField>
      </FormSection>

      <FormSection title="Details">
        <FormField label="Description (optional)">
          <FormTextInput
            value={description}
            onChangeText={setDescription}
            placeholder="What was this expense for?"
          />
        </FormField>
        <FormField label="Category">
          <Pressable style={styles.picker} onPress={() => setCategoryPickerOpen(true)}>
            <Text style={[styles.pickerText, !categoryName && styles.placeholder]}>
              {categoryName || "Select category…"}
            </Text>
            <Ionicons name="chevron-down" size={16} color={ios.label3} />
          </Pressable>
        </FormField>
        <FormField label="Reference # (optional)">
          <FormTextInput
            value={referenceNumber}
            onChangeText={setReferenceNumber}
            placeholder="INV-001, receipt #…"
          />
        </FormField>
      </FormSection>

      <FormSection title="Payment">
        <FormField label="Payment method">
          <Pressable style={styles.picker} onPress={() => setPaymentPickerOpen(true)}>
            <Text style={[styles.pickerText, !paymentMethod && styles.placeholder]}>
              {paymentMethod ? methodLabel(paymentMethod) : "Select method…"}
            </Text>
            <Ionicons name="chevron-down" size={16} color={ios.label3} />
          </Pressable>
        </FormField>
        <FormField label="Supplier (optional)">
          <Pressable style={styles.picker} onPress={() => setSupplierPickerOpen(true)}>
            <Text style={[styles.pickerText, !supplierName && styles.placeholder]}>
              {supplierName || "Select supplier…"}
            </Text>
            <Ionicons name="chevron-down" size={16} color={ios.label3} />
          </Pressable>
        </FormField>
      </FormSection>

      <FormSection title="Notes">
        <FormField label="Notes (optional)">
          <FormTextInput
            value={notes}
            onChangeText={setNotes}
            placeholder="Additional details…"
            multiline
            numberOfLines={3}
            style={{ minHeight: 72, textAlignVertical: "top" }}
          />
        </FormField>
      </FormSection>

      <CategorySheet
        visible={categoryPickerOpen}
        categories={categories ?? []}
        selectedId={categoryId}
        onClose={() => setCategoryPickerOpen(false)}
        onSelect={(c) => {
          setCategoryId(c.id);
          setCategoryName(c.name);
          setCategoryPickerOpen(false);
        }}
      />

      <PaymentMethodSheet
        visible={paymentPickerOpen}
        selected={paymentMethod}
        onClose={() => setPaymentPickerOpen(false)}
        onSelect={(m) => {
          setPaymentMethod(m);
          setPaymentPickerOpen(false);
        }}
      />

      <OptionPickerSheet
        visible={supplierPickerOpen}
        title="Supplier"
        options={(suppliers ?? []).map((s: any) => ({ id: s.id, label: s.name }))}
        selectedId={supplierId}
        nullable
        nullLabel="None"
        onClose={() => setSupplierPickerOpen(false)}
        onSelect={(opt) => {
          setSupplierId(opt.id);
          setSupplierName(opt.label === "None" ? "" : opt.label);
          setSupplierPickerOpen(false);
        }}
      />
    </FormSheet>
  );
}

function CategorySheet({
  visible,
  categories,
  selectedId,
  onClose,
  onSelect,
}: {
  visible: boolean;
  categories: { id: string; name: string }[];
  selectedId: string;
  onClose: () => void;
  onSelect: (c: { id: string; name: string }) => void;
}) {
  return (
    <Modal visible={visible} transparent animationType="slide" onRequestClose={onClose}>
      <Pressable style={styles.sheetBackdrop} onPress={onClose} />
      <View style={styles.sheet}>
        <View style={styles.sheetHandle} />
        <Text style={styles.sheetTitle}>Select category</Text>
        <ScrollView showsVerticalScrollIndicator={false} style={{ maxHeight: 420 }}>
          {categories.length === 0 ? (
            <Text style={styles.sheetEmpty}>No categories yet.</Text>
          ) : (
            <View>
              {categories.map((c) => {
                const active = c.id === selectedId;
                return (
                  <Pressable
                    key={c.id}
                    style={[styles.catRow, active && styles.catRowActive]}
                    onPress={() => onSelect(c)}
                    accessibilityLabel={`Category ${c.name}`}
                  >
                    <View style={[styles.catIcon, active && styles.catIconActive]}>
                      <Ionicons
                        name={iconForCategory(c.name)}
                        size={16}
                        color={active ? ios.brand : ios.label2}
                      />
                    </View>
                    <Text
                      style={[styles.catText, active && styles.catTextActive]}
                      numberOfLines={1}
                    >
                      {c.name}
                    </Text>
                    {active ? <Ionicons name="checkmark" size={16} color={ios.brand} /> : null}
                  </Pressable>
                );
              })}
            </View>
          )}
        </ScrollView>
      </View>
    </Modal>
  );
}

function PaymentMethodSheet({
  visible,
  selected,
  onClose,
  onSelect,
}: {
  visible: boolean;
  selected: string;
  onClose: () => void;
  onSelect: (m: string) => void;
}) {
  const iconFor: Record<string, keyof typeof Ionicons.glyphMap> = {
    CASH: "cash-outline",
    CHECK: "document-text-outline",
    ZELLE: "phone-portrait-outline",
    ACH: "swap-horizontal-outline",
    CREDIT_CARD: "card-outline",
    OTHER: "ellipsis-horizontal-outline",
  };
  return (
    <Modal visible={visible} transparent animationType="slide" onRequestClose={onClose}>
      <Pressable style={styles.sheetBackdrop} onPress={onClose} />
      <View style={styles.sheet}>
        <View style={styles.sheetHandle} />
        <Text style={styles.sheetTitle}>Payment method</Text>
        <View style={styles.grid}>
          {SELECTABLE_METHOD_OPTIONS.map(({ id, label }) => {
            const active = id === selected;
            return (
              <Pressable
                key={id}
                style={[styles.tile, active && styles.tileActive]}
                onPress={() => onSelect(id)}
                accessibilityLabel={`Payment ${label}`}
              >
                <Ionicons
                  name={iconFor[id] ?? "ellipsis-horizontal-outline"}
                  size={22}
                  color={active ? ios.brand : ios.label}
                />
                <Text style={[styles.tileText, active && styles.tileTextActive]} numberOfLines={2}>
                  {label}
                </Text>
              </Pressable>
            );
          })}
        </View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  scanBanner: {
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
    backgroundColor: ios.brandWash,
    borderRadius: 12,
    padding: 14,
    marginBottom: 4,
  },
  scanTitle: { fontSize: 14, fontFamily: "Inter_600SemiBold", color: ios.brand },
  scanSub: {
    fontSize: 12,
    fontFamily: "Inter_400Regular",
    color: ios.brand,
    marginTop: 1,
    opacity: 0.8,
  },
  picker: {
    backgroundColor: ios.fill3,
    borderRadius: 10,
    paddingHorizontal: 12,
    paddingVertical: 11,
    minHeight: 44,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
  },
  pickerText: { fontSize: 15, fontFamily: "Inter_400Regular", color: ios.label, flex: 1 },
  placeholder: { color: ios.label3 },
  sheetBackdrop: { flex: 1, backgroundColor: "rgba(0,0,0,0.4)" },
  sheet: {
    backgroundColor: ios.bgElev,
    borderTopLeftRadius: 20,
    borderTopRightRadius: 20,
    padding: 20,
    paddingBottom: 36,
    gap: 10,
    maxWidth: 480,
    width: "100%",
    alignSelf: "center",
  },
  sheetHandle: {
    alignSelf: "center",
    width: 36,
    height: 4,
    borderRadius: 2,
    backgroundColor: ios.separator,
    marginBottom: 4,
  },
  sheetTitle: {
    fontSize: 18,
    fontFamily: "Inter_700Bold",
    color: ios.label,
    marginBottom: 6,
  },
  sheetEmpty: {
    fontSize: 14,
    fontFamily: "Inter_400Regular",
    color: ios.label2,
    textAlign: "center",
    paddingVertical: 24,
  },
  grid: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: 10,
  },
  catRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    paddingVertical: 11,
    paddingHorizontal: 4,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: ios.separator,
  },
  catRowActive: {
    backgroundColor: ios.brandWash,
    borderRadius: 10,
    borderBottomWidth: 0,
    marginBottom: StyleSheet.hairlineWidth,
  },
  catIcon: {
    width: 30,
    height: 30,
    borderRadius: 8,
    backgroundColor: ios.fill3,
    alignItems: "center",
    justifyContent: "center",
  },
  catIconActive: {
    backgroundColor: ios.brandWash,
  },
  catText: {
    flex: 1,
    fontSize: 14,
    fontFamily: "Inter_500Medium",
    color: ios.label,
  },
  catTextActive: {
    color: ios.brand,
    fontFamily: "Inter_600SemiBold",
  },
  tile: {
    width: "48%",
    aspectRatio: 1.6,
    backgroundColor: ios.fill3,
    borderRadius: 12,
    alignItems: "center",
    justifyContent: "center",
    gap: 6,
    paddingHorizontal: 8,
    borderWidth: 1.5,
    borderColor: "transparent",
  },
  tileActive: {
    backgroundColor: ios.brandWash,
    borderColor: ios.brand,
  },
  tileText: {
    fontSize: 13,
    fontFamily: "Inter_600SemiBold",
    color: ios.label,
    textAlign: "center",
  },
  tileTextActive: {
    color: ios.brand,
  },
});
