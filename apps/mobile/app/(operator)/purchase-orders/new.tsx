import { useState } from "react";
import { Alert, Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { Ionicons } from "@expo/vector-icons";
import { useRouter } from "expo-router";
import { ios } from "@routeflow/ui/tokens";
import { FormField, FormSection, FormSheet, FormTextInput } from "../../../components/FormSheet";
import { useCreatePO, useSuppliers } from "../../../lib/api/purchase-orders";
import { useAdminProducts } from "../../../lib/api/admin";

interface LineItem {
  productId: string;
  productName: string;
  qtyOrdered: string;
  unitCost: string;
}

const EMPTY_ITEM: LineItem = { productId: "", productName: "", qtyOrdered: "", unitCost: "" };

export default function NewPurchaseOrderScreen() {
  const router = useRouter();
  const createMut = useCreatePO();
  const { data: suppliers } = useSuppliers();
  const { data: productsData } = useAdminProducts({ isActive: true, limit: 200 });

  const [supplierId, setSupplierId] = useState("");
  const [supplierName, setSupplierName] = useState("");
  const [expectedDate, setExpectedDate] = useState("");
  const [notes, setNotes] = useState("");
  const [items, setItems] = useState<LineItem[]>([{ ...EMPTY_ITEM }]);

  const products = productsData?.data ?? [];

  const pickSupplier = () => {
    const list = suppliers ?? [];
    Alert.alert(
      "Select supplier",
      undefined,
      [
        ...list.map((s: any) => ({
          text: s.name,
          onPress: () => {
            setSupplierId(s.id);
            setSupplierName(s.name);
          },
        })),
        {
          text: "+ New supplier",
          onPress: () => router.push("/(operator)/suppliers/new"),
        },
        { text: "Cancel", style: "cancel" },
      ],
      { cancelable: true },
    );
  };

  const pickProduct = (index: number) => {
    if (products.length === 0) {
      Alert.alert("No products", "No active products found.");
      return;
    }
    // Show up to 8 in Alert (iOS limit) — for real app would use a modal picker
    const slice = products.slice(0, 8);
    Alert.alert(
      "Select product",
      undefined,
      [
        ...slice.map((p: any) => ({
          text: p.name,
          onPress: () =>
            setItems((prev) =>
              prev.map((it, i) =>
                i === index
                  ? {
                      ...it,
                      productId: p.id,
                      productName: p.name,
                      unitCost: p.standardCost != null ? String(p.standardCost) : it.unitCost,
                    }
                  : it,
              ),
            ),
        })),
        { text: "Cancel", style: "cancel" },
      ],
      { cancelable: true },
    );
  };

  const updateItem = (index: number, field: keyof LineItem, value: string) => {
    setItems((prev) =>
      prev.map((it, i) => (i === index ? { ...it, [field]: value } : it)),
    );
  };

  const addItem = () => setItems((prev) => [...prev, { ...EMPTY_ITEM }]);
  const removeItem = (index: number) => setItems((prev) => prev.filter((_, i) => i !== index));

  const submit = () => {
    if (!supplierId) {
      Alert.alert("Supplier required", "Please select a supplier.");
      return;
    }

    const parsedItems = items
      .filter((it) => it.productId)
      .map((it) => ({
        productId: it.productId,
        qtyOrdered: Number(it.qtyOrdered) || 0,
        unitCost: Number(it.unitCost) || 0,
      }));

    if (parsedItems.length === 0) {
      Alert.alert("Items required", "Add at least one product.");
      return;
    }
    if (parsedItems.some((it) => it.qtyOrdered <= 0)) {
      Alert.alert("Invalid quantity", "Each item needs a quantity greater than 0.");
      return;
    }

    const dto: any = { supplierId, items: parsedItems };
    if (expectedDate.trim()) dto.expectedDate = expectedDate.trim();
    if (notes.trim()) dto.notes = notes.trim();

    createMut.mutate(dto, {
      onSuccess: (result) => {
        router.replace(`/(operator)/purchase-orders/${result.id}`);
      },
      onError: (e: any) =>
        Alert.alert("Couldn't create PO", e?.response?.data?.message ?? e?.message ?? "Try again."),
    });
  };

  return (
    <FormSheet
      title="New Purchase Order"
      submitLabel={createMut.isPending ? "Creating…" : "Create PO"}
      submitting={createMut.isPending}
      onSubmit={submit}
    >
      <FormSection title="Supplier">
        <FormField label="Supplier">
          <Pressable style={styles.picker} onPress={pickSupplier}>
            <Text style={[styles.pickerText, !supplierName && styles.pickerPlaceholder]}>
              {supplierName || "Select supplier…"}
            </Text>
          </Pressable>
        </FormField>
      </FormSection>

      <FormSection title="Details">
        <FormField label="Expected date" hint="Format: YYYY-MM-DD">
          <FormTextInput
            value={expectedDate}
            onChangeText={setExpectedDate}
            placeholder="2025-06-01"
            keyboardType="numbers-and-punctuation"
          />
        </FormField>
        <FormField label="Notes (optional)">
          <FormTextInput
            value={notes}
            onChangeText={setNotes}
            placeholder="Any notes for the supplier…"
            multiline
            numberOfLines={3}
            style={{ minHeight: 72, textAlignVertical: "top" }}
          />
        </FormField>
      </FormSection>

      <FormSection title="Items">
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
            <FormField label="Product">
              <Pressable style={styles.picker} onPress={() => pickProduct(index)}>
                <View style={styles.pickerInner}>
                  <Text
                    style={[styles.pickerText, !item.productName && styles.pickerPlaceholder]}
                    numberOfLines={1}
                  >
                    {item.productName || "Select product…"}
                  </Text>
                  <Ionicons name="chevron-down" size={14} color={ios.label3} />
                </View>
              </Pressable>
            </FormField>
            <View style={styles.row2}>
              <View style={{ flex: 1 }}>
                <FormField label="Qty ordered">
                  <FormTextInput
                    value={item.qtyOrdered}
                    onChangeText={(v) => updateItem(index, "qtyOrdered", v)}
                    placeholder="0"
                    keyboardType="number-pad"
                  />
                </FormField>
              </View>
              <View style={{ flex: 1 }}>
                <FormField label="Unit cost ($)">
                  <FormTextInput
                    value={item.unitCost}
                    onChangeText={(v) => updateItem(index, "unitCost", v)}
                    placeholder="0.00"
                    keyboardType="decimal-pad"
                  />
                </FormField>
              </View>
            </View>
          </View>
        ))}

        <Pressable style={styles.addItemBtn} onPress={addItem}>
          <Text style={styles.addItemText}>+ Add item</Text>
        </Pressable>
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
  pickerInner: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
  },
  pickerText: { fontSize: 15, fontFamily: "Inter_400Regular", color: ios.label, flex: 1 },
  pickerPlaceholder: { color: ios.label3 },
  itemBlock: {
    gap: 10,
    paddingBottom: 12,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: ios.separator,
  },
  itemHeader: { flexDirection: "row", justifyContent: "space-between", alignItems: "center" },
  itemLabel: {
    fontSize: 12,
    fontFamily: "Inter_600SemiBold",
    color: ios.label2,
    letterSpacing: 0.3,
    textTransform: "uppercase",
  },
  removeText: { fontSize: 13, fontFamily: "Inter_500Medium", color: ios.system.redInk },
  row2: { flexDirection: "row", gap: 10 },
  addItemBtn: {
    alignItems: "center",
    paddingVertical: 12,
    borderRadius: 10,
    backgroundColor: ios.fill3,
    marginTop: 4,
  },
  addItemText: { fontSize: 14, fontFamily: "Inter_600SemiBold", color: ios.brand },
});
