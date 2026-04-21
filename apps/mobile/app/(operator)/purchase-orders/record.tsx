import { useState } from "react";
import { Alert, Pressable, StyleSheet, Text, View } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { useRouter } from "expo-router";
import { ios } from "@routeflow/ui/tokens";
import { FormField, FormSection, FormSheet, FormTextInput } from "../../../components/FormSheet";
import { useRecordPurchase } from "../../../lib/api/inventory";
import { useSuppliers } from "../../../lib/api/purchase-orders";
import { useAdminProducts } from "../../../lib/api/admin";
import { showToast } from "../../../lib/toast";

export default function QuickReceiveScreen() {
  const router = useRouter();
  const mut = useRecordPurchase();
  const { data: suppliers } = useSuppliers();
  const { data: productsData } = useAdminProducts({ isActive: true, limit: 200 });

  const [productId, setProductId] = useState("");
  const [productName, setProductName] = useState("");
  const [quantity, setQuantity] = useState("");
  const [unitCost, setUnitCost] = useState("");
  const [supplierId, setSupplierId] = useState("");
  const [supplierName, setSupplierName] = useState("");
  const [reference, setReference] = useState("");
  const [notes, setNotes] = useState("");

  const products = productsData?.data ?? [];

  const pickProduct = () => {
    if (products.length === 0) {
      Alert.alert("No products", "No active products found.");
      return;
    }
    const slice = products.slice(0, 8);
    Alert.alert(
      "Select product",
      undefined,
      [
        ...slice.map((p: any) => ({
          text: p.name,
          onPress: () => {
            setProductId(p.id);
            setProductName(p.name);
            if (p.standardCost != null) setUnitCost(String(p.standardCost));
          },
        })),
        { text: "Cancel", style: "cancel" },
      ],
      { cancelable: true },
    );
  };

  const pickSupplier = () => {
    const list = suppliers ?? [];
    if (list.length === 0) {
      Alert.alert("No suppliers", "No suppliers have been set up.");
      return;
    }
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
        { text: "Cancel", style: "cancel" },
      ],
      { cancelable: true },
    );
  };

  const submit = () => {
    if (!productId) {
      Alert.alert("Product required", "Please select a product.");
      return;
    }
    const qty = Number(quantity);
    if (!Number.isFinite(qty) || qty <= 0) {
      Alert.alert("Invalid quantity", "Enter a quantity greater than 0.");
      return;
    }

    mut.mutate(
      {
        productId,
        quantity: qty,
        unitCost: Number(unitCost) || 0,
        supplierId: supplierId || undefined,
        reference: reference.trim() || undefined,
        notes: notes.trim() || undefined,
      },
      {
        onSuccess: () => {
          showToast("Stock received");
          router.back();
        },
        onError: (e: any) =>
          Alert.alert(
            "Couldn't record",
            e?.response?.data?.message ?? e?.message ?? "Try again.",
          ),
      },
    );
  };

  return (
    <FormSheet
      title="Quick Receive"
      submitLabel={mut.isPending ? "Recording…" : "Record receipt"}
      submitting={mut.isPending}
      onSubmit={submit}
    >
      <FormSection title="Product">
        <FormField label="Product">
          <Pressable style={styles.picker} onPress={pickProduct}>
            <View style={styles.pickerInner}>
              <Text style={[styles.pickerText, !productName && styles.placeholder]}>
                {productName || "Select product…"}
              </Text>
              <Ionicons name="chevron-down" size={14} color={ios.label3} />
            </View>
          </Pressable>
        </FormField>
        <View style={styles.row2}>
          <View style={{ flex: 1 }}>
            <FormField label="Qty received">
              <FormTextInput
                value={quantity}
                onChangeText={setQuantity}
                placeholder="0"
                keyboardType="number-pad"
              />
            </FormField>
          </View>
          <View style={{ flex: 1 }}>
            <FormField label="Unit cost ($)">
              <FormTextInput
                value={unitCost}
                onChangeText={setUnitCost}
                placeholder="0.00"
                keyboardType="decimal-pad"
              />
            </FormField>
          </View>
        </View>
      </FormSection>

      <FormSection title="Optional">
        <FormField label="Supplier">
          <Pressable style={styles.picker} onPress={pickSupplier}>
            <Text style={[styles.pickerText, !supplierName && styles.placeholder]}>
              {supplierName || "Select supplier…"}
            </Text>
          </Pressable>
        </FormField>
        <FormField label="Reference">
          <FormTextInput
            value={reference}
            onChangeText={setReference}
            placeholder="Invoice #, delivery note…"
          />
        </FormField>
        <FormField label="Notes">
          <FormTextInput
            value={notes}
            onChangeText={setNotes}
            placeholder="Any notes…"
            multiline
            numberOfLines={2}
            style={{ minHeight: 56, textAlignVertical: "top" }}
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
  pickerInner: { flexDirection: "row", alignItems: "center", justifyContent: "space-between" },
  pickerText: { fontSize: 15, fontFamily: "Inter_400Regular", color: ios.label, flex: 1 },
  placeholder: { color: ios.label3 },
  row2: { flexDirection: "row", gap: 10 },
});
