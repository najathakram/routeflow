import { useState } from "react";
import { Alert, Pressable, StyleSheet, Text, View } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { useRouter } from "expo-router";
import { ios } from "@routeflow/ui/tokens";
import { FormField, FormSection, FormSheet, FormTextInput } from "../../../components/FormSheet";
import { useCreateVendorBill } from "../../../lib/api/vendor-bills";
import { useSuppliers } from "../../../lib/api/purchase-orders";

interface LineItem {
  description: string;
  qty: string;
  unitCost: string;
}

const EMPTY_ITEM: LineItem = { description: "", qty: "", unitCost: "" };

export default function NewVendorBillScreen() {
  const router = useRouter();
  const createMut = useCreateVendorBill();
  const { data: suppliers } = useSuppliers();

  const [supplierId, setSupplierId] = useState("");
  const [supplierName, setSupplierName] = useState("");
  const [billDate, setBillDate] = useState("");
  const [dueDate, setDueDate] = useState("");
  const [notes, setNotes] = useState("");
  const [items, setItems] = useState<LineItem[]>([{ ...EMPTY_ITEM }]);

  const pickSupplier = () => {
    const list = suppliers ?? [];
    Alert.alert(
      "Select supplier",
      undefined,
      [
        ...list.map((s: any) => ({
          text: s.name,
          onPress: () => { setSupplierId(s.id); setSupplierName(s.name); },
        })),
        { text: "Cancel", style: "cancel" },
      ],
      { cancelable: true },
    );
  };

  const updateItem = (index: number, field: keyof LineItem, value: string) =>
    setItems((prev) => prev.map((it, i) => (i === index ? { ...it, [field]: value } : it)));

  const addItem = () => setItems((prev) => [...prev, { ...EMPTY_ITEM }]);
  const removeItem = (index: number) => setItems((prev) => prev.filter((_, i) => i !== index));

  const submit = () => {
    const parsedItems = items
      .filter((it) => it.description)
      .map((it) => ({
        description: it.description,
        qty: Number(it.qty) || 1,
        unitCost: Number(it.unitCost) || 0,
      }));

    if (parsedItems.length === 0) {
      Alert.alert("Items required", "Add at least one line item.");
      return;
    }

    const dto: any = { items: parsedItems };
    if (supplierId) dto.supplierId = supplierId;
    if (billDate.trim()) dto.billDate = billDate.trim();
    if (dueDate.trim()) dto.dueDate = dueDate.trim();
    if (notes.trim()) dto.notes = notes.trim();

    createMut.mutate(dto, {
      onSuccess: (bill) => router.replace(`/(operator)/vendor-bills/${bill.id}`),
      onError: (e: any) =>
        Alert.alert("Couldn't create bill", e?.response?.data?.message ?? e?.message ?? "Try again."),
    });
  };

  return (
    <FormSheet
      title="New Vendor Bill"
      submitLabel={createMut.isPending ? "Creating…" : "Create bill"}
      submitting={createMut.isPending}
      onSubmit={submit}
    >
      <FormSection title="Supplier (optional)">
        <FormField label="Supplier">
          <Pressable style={styles.picker} onPress={pickSupplier}>
            <Text style={[styles.pickerText, !supplierName && styles.placeholder]}>
              {supplierName || "Select supplier…"}
            </Text>
          </Pressable>
        </FormField>
      </FormSection>

      <FormSection title="Details">
        <FormField label="Bill date" hint="YYYY-MM-DD">
          <FormTextInput value={billDate} onChangeText={setBillDate} placeholder="2025-06-01" keyboardType="numbers-and-punctuation" />
        </FormField>
        <FormField label="Due date" hint="YYYY-MM-DD">
          <FormTextInput value={dueDate} onChangeText={setDueDate} placeholder="2025-06-30" keyboardType="numbers-and-punctuation" />
        </FormField>
        <FormField label="Notes (optional)">
          <FormTextInput value={notes} onChangeText={setNotes} placeholder="Invoice reference…" multiline numberOfLines={2} style={{ minHeight: 56, textAlignVertical: "top" }} />
        </FormField>
      </FormSection>

      <FormSection title="Line items">
        {items.map((item, index) => (
          <View key={index} style={styles.itemBlock}>
            <View style={styles.itemHeader}>
              <Text style={styles.itemLabel}>Item {index + 1}</Text>
              {items.length > 1 ? (
                <Pressable onPress={() => removeItem(index)} hitSlop={8}>
                  <Text style={styles.removeText}>Remove</Text>
                </Pressable>
              ) : null}
            </View>
            <FormField label="Description">
              <FormTextInput value={item.description} onChangeText={(v) => updateItem(index, "description", v)} placeholder="Product or service…" />
            </FormField>
            <View style={styles.row2}>
              <View style={{ flex: 1 }}>
                <FormField label="Qty">
                  <FormTextInput value={item.qty} onChangeText={(v) => updateItem(index, "qty", v)} placeholder="1" keyboardType="number-pad" />
                </FormField>
              </View>
              <View style={{ flex: 1 }}>
                <FormField label="Unit cost ($)">
                  <FormTextInput value={item.unitCost} onChangeText={(v) => updateItem(index, "unitCost", v)} placeholder="0.00" keyboardType="decimal-pad" />
                </FormField>
              </View>
            </View>
          </View>
        ))}
        <Pressable style={styles.addItemBtn} onPress={addItem}>
          <Ionicons name="add" size={16} color={ios.brand} />
          <Text style={styles.addItemText}>Add item</Text>
        </Pressable>
      </FormSection>
    </FormSheet>
  );
}

const styles = StyleSheet.create({
  picker: { backgroundColor: ios.fill3, borderRadius: 10, paddingHorizontal: 12, paddingVertical: 11, minHeight: 44, justifyContent: "center" },
  pickerText: { fontSize: 15, fontFamily: "Inter_400Regular", color: ios.label },
  placeholder: { color: ios.label3 },
  itemBlock: { gap: 10, paddingBottom: 12, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: ios.separator },
  itemHeader: { flexDirection: "row", justifyContent: "space-between", alignItems: "center" },
  itemLabel: { fontSize: 12, fontFamily: "Inter_600SemiBold", color: ios.label2, letterSpacing: 0.3, textTransform: "uppercase" },
  removeText: { fontSize: 13, fontFamily: "Inter_500Medium", color: ios.system.redInk },
  row2: { flexDirection: "row", gap: 10 },
  addItemBtn: { flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 6, paddingVertical: 12, borderRadius: 10, backgroundColor: ios.fill3, marginTop: 4 },
  addItemText: { fontSize: 14, fontFamily: "Inter_600SemiBold", color: ios.brand },
});
