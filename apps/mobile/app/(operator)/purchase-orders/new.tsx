import { useCallback, useEffect, useRef, useState } from "react";
import { Alert, Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { Ionicons } from "@expo/vector-icons";
import { useFocusEffect, useRouter } from "expo-router";
import { ios } from "@routeflow/ui/tokens";
import { FormField, FormSection, FormSheet, FormTextInput } from "../../../components/FormSheet";
import { useCreatePO, useSuppliers } from "../../../lib/api/purchase-orders";
import { useProductPickerStore } from "../../../store/productPickerStore";

interface LineItem {
  productId: string;
  productName: string;
  qtyOrdered: string;
  unitCost: string;
  pickerKey: string;
}

function makeKey(index: number) {
  return `po-item-${index}-${Date.now()}`;
}

const EMPTY_ITEM = (index: number): LineItem => ({
  productId: "",
  productName: "",
  qtyOrdered: "",
  unitCost: "",
  pickerKey: makeKey(index),
});

export default function NewPurchaseOrderScreen() {
  const router = useRouter();
  const createMut = useCreatePO();
  const { data: suppliers, refetch: refetchSuppliers } = useSuppliers();

  const [supplierId, setSupplierId] = useState("");
  const [supplierName, setSupplierName] = useState("");
  const [expectedDate, setExpectedDate] = useState("");
  const [notes, setNotes] = useState("");
  const [items, setItems] = useState<LineItem[]>([EMPTY_ITEM(0)]);

  const getSelection = useProductPickerStore((s) => s.selections);
  const clearSelection = useProductPickerStore((s) => s.clearSelection);
  const prevSelectionsRef = useRef<Record<string, { id: string; name: string; standardCost?: number }>>({});

  // When navigating back from supplier/product pickers, refresh data and
  // apply any pending product selections.
  useFocusEffect(
    useCallback(() => {
      refetchSuppliers();
    }, [refetchSuppliers]),
  );

  // When focus returns and we have no supplier yet, auto-select the newest one.
  useFocusEffect(
    useCallback(() => {
      if (!supplierId && suppliers && suppliers.length > 0) {
        // Sort by nothing — just take the last item (most recently added ends up last
        // in list API response). We only do this once per "return from new supplier" flow.
        const last = suppliers[suppliers.length - 1];
        if (last) {
          setSupplierId(last.id);
          setSupplierName(last.name);
        }
      }
    }, [suppliers, supplierId]),
  );

  // Apply product picker selections when they change.
  useEffect(() => {
    const prev = prevSelectionsRef.current;
    setItems((current) =>
      current.map((item) => {
        const sel = getSelection[item.pickerKey];
        const prevSel = prev[item.pickerKey];
        if (sel && sel !== prevSel) {
          clearSelection(item.pickerKey);
          return {
            ...item,
            productId: sel.id,
            productName: sel.name,
            unitCost:
              sel.standardCost != null ? String(sel.standardCost) : item.unitCost,
          };
        }
        return item;
      }),
    );
    prevSelectionsRef.current = { ...getSelection };
  }, [getSelection, clearSelection]);

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
          onPress: () => {
            setSupplierId("");
            setSupplierName("");
            router.push("/(operator)/suppliers/new");
          },
        },
        { text: "Cancel", style: "cancel" },
      ],
      { cancelable: true },
    );
  };

  const pickProduct = (item: LineItem) => {
    router.push({
      pathname: "/(operator)/purchase-orders/pick-product",
      params: { callbackKey: item.pickerKey },
    });
  };

  const updateItem = (index: number, field: keyof LineItem, value: string) => {
    setItems((prev) =>
      prev.map((it, i) => (i === index ? { ...it, [field]: value } : it)),
    );
  };

  const addItem = () =>
    setItems((prev) => [...prev, EMPTY_ITEM(prev.length)]);
  const removeItem = (index: number) =>
    setItems((prev) => prev.filter((_, i) => i !== index));

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
        Alert.alert(
          "Couldn't create PO",
          e?.response?.data?.message ?? e?.message ?? "Try again.",
        ),
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
            <Text
              style={[styles.pickerText, !supplierName && styles.pickerPlaceholder]}
            >
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
          <View key={item.pickerKey} style={styles.itemBlock}>
            <View style={styles.itemHeader}>
              <Text style={styles.itemLabel}>Item {index + 1}</Text>
              {items.length > 1 ? (
                <Pressable onPress={() => removeItem(index)} hitSlop={8}>
                  <Text style={styles.removeText}>Remove</Text>
                </Pressable>
              ) : null}
            </View>
            <FormField label="Product">
              <Pressable style={styles.picker} onPress={() => pickProduct(item)}>
                <View style={styles.pickerInner}>
                  <Text
                    style={[
                      styles.pickerText,
                      !item.productName && styles.pickerPlaceholder,
                    ]}
                    numberOfLines={1}
                  >
                    {item.productName || "Select product…"}
                  </Text>
                  <Ionicons name="chevron-forward" size={14} color={ios.label3} />
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
  itemHeader: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
  },
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
