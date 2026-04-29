import { useState } from "react";
import {
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { useRouter } from "expo-router";
import { ios } from "@routeflow/ui/tokens";
import { FormField, FormSection, FormSheet, FormTextInput } from "../../../components/FormSheet";
import { OptionPickerSheet } from "../../../components/OptionPickerSheet";
import { useCreateVendorBill } from "../../../lib/api/vendor-bills";
import { useSuppliers } from "../../../lib/api/purchase-orders";
import { useProducts } from "../../../lib/api/products";
import { showToast } from "../../../lib/toast";

interface LineItem {
  description: string;
  qty: string;
  unitCost: string;
  productSearch: string;
  showSuggestions: boolean;
}

const EMPTY_ITEM: LineItem = {
  description: "",
  qty: "",
  unitCost: "",
  productSearch: "",
  showSuggestions: false,
};

export default function NewVendorBillScreen() {
  const router = useRouter();
  const createMut = useCreateVendorBill();
  const { data: suppliers } = useSuppliers();

  const [supplierId, setSupplierId] = useState("");
  const [supplierName, setSupplierName] = useState("");
  const [supplierPickerOpen, setSupplierPickerOpen] = useState(false);
  const [billDate, setBillDate] = useState("");
  const [dueDate, setDueDate] = useState("");
  const [notes, setNotes] = useState("");
  const [items, setItems] = useState<LineItem[]>([{ ...EMPTY_ITEM }]);

  const pickSupplier = () => setSupplierPickerOpen(true);

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
      showToast("Add at least one line item.");
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
        showToast(e?.response?.data?.message ?? e?.message ?? "Try again."),
    });
  };

  return (
    <FormSheet
      title="New Vendor Bill"
      submitLabel={createMut.isPending ? "Creating…" : "Create bill"}
      submitting={createMut.isPending}
      onSubmit={submit}
    >
      {/* Scan shortcut banner */}
      <Pressable
        style={styles.scanBanner}
        onPress={() => router.replace("/(operator)/vendor-bills/scan" as any)}
      >
        <Ionicons name="scan-outline" size={18} color={ios.brand} />
        <View style={{ flex: 1 }}>
          <Text style={styles.scanTitle}>Have a paper bill?</Text>
          <Text style={styles.scanSub}>Scan it for automatic line-item extraction</Text>
        </View>
        <Ionicons name="chevron-forward" size={14} color={ios.brand} />
      </Pressable>

      <FormSection title="Supplier">
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
          <LineItemRow
            key={index}
            item={item}
            index={index}
            canRemove={items.length > 1}
            onUpdate={updateItem}
            onRemove={removeItem}
          />
        ))}
        <Pressable style={styles.addItemBtn} onPress={addItem}>
          <Ionicons name="add" size={16} color={ios.brand} />
          <Text style={styles.addItemText}>Add item</Text>
        </Pressable>
      </FormSection>
      <OptionPickerSheet
        visible={supplierPickerOpen}
        title="Supplier"
        options={(suppliers ?? []).map((s: any) => ({ id: s.id, label: s.name }))}
        selectedId={supplierId}
        nullable
        nullLabel="None"
        onClose={() => setSupplierPickerOpen(false)}
        onSelect={(opt) => { setSupplierId(opt.id); setSupplierName(opt.id ? opt.label : ""); setSupplierPickerOpen(false); }}
      />
    </FormSheet>
  );
}

function LineItemRow({
  item,
  index,
  canRemove,
  onUpdate,
  onRemove,
}: {
  item: LineItem;
  index: number;
  canRemove: boolean;
  onUpdate: (i: number, field: keyof LineItem, value: string) => void;
  onRemove: (i: number) => void;
}) {
  const router = useRouter();
  const [search, setSearch] = useState(item.description);
  const { data: productData } = useProducts({
    search: search.trim().length >= 2 ? search.trim() : undefined,
    limit: 8,
  });
  const suggestions = (productData?.data ?? []) as Array<{
    id: string;
    name: string;
    sku?: string;
    pricePerUnit?: number | string;
  }>;
  const [showSugs, setShowSugs] = useState(false);

  const handleDescChange = (v: string) => {
    setSearch(v);
    onUpdate(index, "description", v);
    setShowSugs(v.trim().length >= 2);
  };

  const pickSuggestion = (p: typeof suggestions[number]) => {
    setSearch(p.name);
    onUpdate(index, "description", p.name);
    if (p.pricePerUnit) {
      const cost = Number(p.pricePerUnit);
      if (cost > 0) onUpdate(index, "unitCost", cost.toFixed(2));
    }
    setShowSugs(false);
  };

  const handleScanProduct = () => {
    if (Platform.OS === "web") {
      // On web, expand suggestions (scanner not available in browser)
      setShowSugs(true);
    } else {
      router.push("/(operator)/products/scan" as any);
    }
  };

  return (
    <View style={styles.itemBlock}>
      <View style={styles.itemHeader}>
        <Text style={styles.itemLabel}>Item {index + 1}</Text>
        {canRemove ? (
          <Pressable onPress={() => onRemove(index)} hitSlop={8}>
            <Text style={styles.removeText}>Remove</Text>
          </Pressable>
        ) : null}
      </View>

      {/* Description with autocomplete + scan icon */}
      <View style={{ marginBottom: 8 }}>
        <View style={{ flexDirection: "row", justifyContent: "space-between", alignItems: "center", marginBottom: 4 }}>
          <Text style={styles.fieldLabel}>Description</Text>
          <Pressable onPress={handleScanProduct} hitSlop={8} style={styles.scanIcon}>
            <Ionicons name="barcode-outline" size={16} color={ios.brand} />
            <Text style={styles.scanIconText}>Scan</Text>
          </Pressable>
        </View>
        <TextInput
          style={styles.textInput}
          value={search}
          onChangeText={handleDescChange}
          placeholder="Product or service…"
          placeholderTextColor={ios.label3}
          onBlur={() => setTimeout(() => setShowSugs(false), 150)}
        />
        {showSugs && suggestions.length > 0 ? (
          <View style={styles.sugBox}>
            {suggestions.map((p) => (
              <Pressable key={p.id} style={styles.sugRow} onPress={() => pickSuggestion(p)}>
                <Text style={styles.sugName} numberOfLines={1}>{p.name}</Text>
                {p.sku ? <Text style={styles.sugSub}>SKU {p.sku}</Text> : null}
              </Pressable>
            ))}
          </View>
        ) : null}
      </View>

      <View style={styles.row2}>
        <View style={{ flex: 1 }}>
          <Text style={styles.fieldLabel}>Qty</Text>
          <TextInput
            style={styles.textInput}
            value={item.qty}
            onChangeText={(v) => onUpdate(index, "qty", v)}
            placeholder="1"
            placeholderTextColor={ios.label3}
            keyboardType="number-pad"
          />
        </View>
        <View style={{ flex: 1 }}>
          <Text style={styles.fieldLabel}>Unit cost ($)</Text>
          <TextInput
            style={styles.textInput}
            value={item.unitCost}
            onChangeText={(v) => onUpdate(index, "unitCost", v)}
            placeholder="0.00"
            placeholderTextColor={ios.label3}
            keyboardType="decimal-pad"
          />
        </View>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  scanBanner: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    backgroundColor: ios.brandWash,
    borderRadius: 12,
    padding: 14,
    marginBottom: 16,
  },
  scanTitle: { fontSize: 14, fontFamily: "Inter_600SemiBold", color: ios.brand },
  scanSub: { fontSize: 12, fontFamily: "Inter_400Regular", color: ios.brand, opacity: 0.8, marginTop: 1 },
  picker: { backgroundColor: ios.fill3, borderRadius: 10, paddingHorizontal: 12, paddingVertical: 11, minHeight: 44, justifyContent: "center" },
  pickerText: { fontSize: 15, fontFamily: "Inter_400Regular", color: ios.label },
  placeholder: { color: ios.label3 },
  itemBlock: { gap: 10, paddingBottom: 12, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: ios.separator },
  itemHeader: { flexDirection: "row", justifyContent: "space-between", alignItems: "center" },
  itemLabel: { fontSize: 12, fontFamily: "Inter_600SemiBold", color: ios.label2, letterSpacing: 0.3, textTransform: "uppercase" },
  fieldLabel: { fontSize: 12, fontFamily: "Inter_600SemiBold", color: ios.label2, marginBottom: 5, letterSpacing: 0.2 },
  textInput: {
    backgroundColor: ios.fill3,
    borderRadius: 10,
    paddingHorizontal: 12,
    paddingVertical: 10,
    fontSize: 15,
    fontFamily: "Inter_400Regular",
    color: ios.label,
  },
  sugBox: {
    backgroundColor: ios.bgElev,
    borderRadius: 10,
    marginTop: 4,
    shadowColor: "#000",
    shadowOpacity: 0.08,
    shadowRadius: 8,
    shadowOffset: { width: 0, height: 2 },
    elevation: 4,
    overflow: "hidden",
  },
  sugRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: 12,
    paddingVertical: 10,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: ios.separator,
  },
  sugName: { fontSize: 14, fontFamily: "Inter_500Medium", color: ios.label, flex: 1 },
  sugSub: { fontSize: 12, fontFamily: "Inter_400Regular", color: ios.label2 },
  scanIcon: { flexDirection: "row", alignItems: "center", gap: 4 },
  scanIconText: { fontSize: 12, fontFamily: "Inter_600SemiBold", color: ios.brand },
  removeText: { fontSize: 13, fontFamily: "Inter_500Medium", color: ios.system.redInk },
  row2: { flexDirection: "row", gap: 10 },
  addItemBtn: { flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 6, paddingVertical: 12, borderRadius: 10, backgroundColor: ios.fill3, marginTop: 4 },
  addItemText: { fontSize: 14, fontFamily: "Inter_600SemiBold", color: ios.brand },
});
