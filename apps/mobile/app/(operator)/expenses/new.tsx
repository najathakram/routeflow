import { useState } from "react";
import { Alert, Pressable, StyleSheet, Text, View } from "react-native";
import { useRouter } from "expo-router";
import { ios } from "@routeflow/ui/tokens";
import { FormField, FormSection, FormSheet, FormTextInput } from "../../../components/FormSheet";
import { useCreateExpense, useExpenseCategories } from "../../../lib/api/expenses";
import { useSuppliers } from "../../../lib/api/purchase-orders";

const PAYMENT_METHODS = ["CASH", "CARD", "BANK_TRANSFER", "CHECK", "OTHER"];

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

  const pickCategory = () => {
    const list = categories ?? [];
    Alert.alert(
      "Select category",
      undefined,
      [
        ...list.map((c) => ({
          text: c.name,
          onPress: () => { setCategoryId(c.id); setCategoryName(c.name); },
        })),
        { text: "Cancel", style: "cancel" },
      ],
      { cancelable: true },
    );
  };

  const pickSupplier = () => {
    const list = suppliers ?? [];
    Alert.alert(
      "Select supplier",
      undefined,
      [
        { text: "None", onPress: () => { setSupplierId(""); setSupplierName(""); } },
        ...list.map((s: any) => ({
          text: s.name,
          onPress: () => { setSupplierId(s.id); setSupplierName(s.name); },
        })),
        { text: "Cancel", style: "cancel" },
      ],
      { cancelable: true },
    );
  };

  const pickPaymentMethod = () => {
    Alert.alert(
      "Payment method",
      undefined,
      [
        ...PAYMENT_METHODS.map((m) => ({
          text: m.charAt(0) + m.slice(1).toLowerCase().replace("_", " "),
          onPress: () => setPaymentMethod(m),
        })),
        { text: "Cancel", style: "cancel" },
      ],
      { cancelable: true },
    );
  };

  const submit = () => {
    const parsedAmount = Number(amount);
    if (!amount || !Number.isFinite(parsedAmount) || parsedAmount <= 0) {
      Alert.alert("Amount required", "Enter a valid expense amount.");
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
      onError: (e: any) =>
        Alert.alert("Couldn't create expense", e?.response?.data?.message ?? e?.message ?? "Try again."),
    });
  };

  return (
    <FormSheet
      title="New Expense"
      submitLabel={createMut.isPending ? "Creating…" : "Create expense"}
      submitting={createMut.isPending}
      onSubmit={submit}
    >
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
          <Pressable style={styles.picker} onPress={pickCategory}>
            <Text style={[styles.pickerText, !categoryName && styles.placeholder]}>
              {categoryName || "Select category…"}
            </Text>
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
          <Pressable style={styles.picker} onPress={pickPaymentMethod}>
            <Text style={[styles.pickerText, !paymentMethod && styles.placeholder]}>
              {paymentMethod
                ? paymentMethod.charAt(0) + paymentMethod.slice(1).toLowerCase().replace("_", " ")
                : "Select method…"}
            </Text>
          </Pressable>
        </FormField>
        <FormField label="Supplier (optional)">
          <Pressable style={styles.picker} onPress={pickSupplier}>
            <Text style={[styles.pickerText, !supplierName && styles.placeholder]}>
              {supplierName || "Select supplier…"}
            </Text>
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
    </FormSheet>
  );
}

const styles = StyleSheet.create({
  picker: {
    backgroundColor: ios.fill3,
    borderRadius: 10,
    paddingHorizontal: 12,
    paddingVertical: 11,
    minHeight: 44,
    justifyContent: "center",
  },
  pickerText: { fontSize: 15, fontFamily: "Inter_400Regular", color: ios.label },
  placeholder: { color: ios.label3 },
});
