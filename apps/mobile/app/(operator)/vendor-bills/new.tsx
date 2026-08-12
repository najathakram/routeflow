import { useState } from "react";
import { Platform, Pressable, StyleSheet, Text, TextInput, View } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { useRouter } from "expo-router";
import { ios } from "@routeflow/ui/tokens";
import { FormField, FormSection, FormSheet, FormTextInput } from "../../../components/FormSheet";
import { OptionPickerSheet } from "../../../components/OptionPickerSheet";
import { BarcodeScanner } from "../../../components/BarcodeScanner";
import { useCreateVendorBill } from "../../../lib/api/vendor-bills";
import { useSuppliers } from "../../../lib/api/purchase-orders";
import { useProducts } from "../../../lib/api/products";
import { resolveProductByCode } from "../../../lib/barcode-resolve";
import { showToast } from "../../../lib/toast";

interface LineItem {
  description: string;
  qty: string;
  unitCost: string;
  /** Catalog link — WITHOUT it, receiving the bill updates no stock and no
   *  cost (server skips unlinked lines). Mobile bills used to never set it. */
  productId: string | null;
  /** Pieces per case when the line is priced per CASE (server converts
   *  qty × packSize pieces at unitCost ÷ packSize on receive). Blank = the
   *  line is already per piece/unit. */
  packSize: string;
  productSearch: string;
  showSuggestions: boolean;
}

const EMPTY_ITEM: LineItem = {
  description: "",
  qty: "",
  unitCost: "",
  productId: null,
  packSize: "",
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

  const updateItem = (index: number, patch: Partial<LineItem>) =>
    setItems((prev) => prev.map((it, i) => (i === index ? { ...it, ...patch } : it)));

  const addItem = () => setItems((prev) => [...prev, { ...EMPTY_ITEM }]);
  const removeItem = (index: number) => setItems((prev) => prev.filter((_, i) => i !== index));

  const submit = () => {
    const parsedItems = items
      .filter((it) => it.description)
      .map((it) => {
        const pack = Math.max(0, Math.trunc(Number(it.packSize) || 0));
        return {
          description: it.description,
          qty: Number(it.qty) || 1,
          unitCost: Number(it.unitCost) || 0,
          ...(it.productId ? { productId: it.productId } : {}),
          ...(pack > 1 ? { packSize: pack } : {}),
        };
      });

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
      onError: (e: any) => showToast(e?.response?.data?.message ?? e?.message ?? "Try again."),
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
          <FormTextInput
            value={billDate}
            onChangeText={setBillDate}
            placeholder="2025-06-01"
            keyboardType="numbers-and-punctuation"
          />
        </FormField>
        <FormField label="Due date" hint="YYYY-MM-DD">
          <FormTextInput
            value={dueDate}
            onChangeText={setDueDate}
            placeholder="2025-06-30"
            keyboardType="numbers-and-punctuation"
          />
        </FormField>
        <FormField label="Notes (optional)">
          <FormTextInput
            value={notes}
            onChangeText={setNotes}
            placeholder="Invoice reference…"
            multiline
            numberOfLines={2}
            style={{ minHeight: 56, textAlignVertical: "top" }}
          />
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
        onSelect={(opt) => {
          setSupplierId(opt.id);
          setSupplierName(opt.id ? opt.label : "");
          setSupplierPickerOpen(false);
        }}
      />
    </FormSheet>
  );
}

/** What a picked catalog product contributes to the line. */
interface PickableProduct {
  id: string;
  name: string;
  sku?: string;
  pricePerUnit?: number | string;
  averageCost?: number | string | null;
  standardCost?: number | string | null;
  unitsPerBox?: number | null;
}

/**
 * Prefill for a linked line — COST-side truth, never the selling price (the
 * old prefill used pricePerUnit, seeding supplier bills with retail prices).
 * `averageCost` is per PIECE; a boxed product's invoice line is per CASE, so
 * prefill the case cost (avg × unitsPerBox) and packSize together — receive()
 * converts back to pieces at unitCost ÷ packSize.
 */
function linePrefillFor(p: PickableProduct): Partial<LineItem> {
  const perPiece = Number(p.averageCost ?? p.standardCost ?? 0);
  const upb = Number(p.unitsPerBox ?? 0);
  const patch: Partial<LineItem> = { description: p.name, productId: p.id };
  if (upb > 1) {
    patch.packSize = String(upb);
    if (perPiece > 0) patch.unitCost = (perPiece * upb).toFixed(2);
  } else {
    patch.packSize = "";
    if (perPiece > 0) patch.unitCost = perPiece.toFixed(2);
  }
  return patch;
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
  onUpdate: (i: number, patch: Partial<LineItem>) => void;
  onRemove: (i: number) => void;
}) {
  const [search, setSearch] = useState(item.description);
  const { data: productData } = useProducts({
    search: search.trim().length >= 2 ? search.trim() : undefined,
    limit: 8,
  });
  const suggestions = (productData?.data ?? []) as PickableProduct[];
  const [showSugs, setShowSugs] = useState(false);
  const [scanOpen, setScanOpen] = useState(false);

  const handleDescChange = (v: string) => {
    setSearch(v);
    // Hand-typing breaks the catalog link — an unlinked line updates no
    // stock/cost on receive, and the receive flow will warn about it.
    onUpdate(index, { description: v, productId: null });
    setShowSugs(v.trim().length >= 2);
  };

  const pickSuggestion = (p: PickableProduct) => {
    setSearch(p.name);
    onUpdate(index, linePrefillFor(p));
    setShowSugs(false);
  };

  const handleScanProduct = () => {
    if (Platform.OS === "web") {
      // On web, expand suggestions (scanner not available in browser)
      setShowSugs(true);
    } else {
      setScanOpen(true);
    }
  };

  const handleScanned = async (code: string) => {
    setScanOpen(false);
    const trimmed = code.trim();
    if (!trimmed) return;
    try {
      const result = await resolveProductByCode<PickableProduct>(trimmed);
      if (!result.notFound && result.product) {
        setSearch(result.product.name);
        onUpdate(index, linePrefillFor(result.product));
        setShowSugs(false);
        return;
      }
    } catch {
      // network error → fall through
    }
    showToast(`No product for "${trimmed}"`);
  };

  return (
    <View style={styles.itemBlock}>
      <View style={styles.itemHeader}>
        <View style={{ flexDirection: "row", alignItems: "center", gap: 6 }}>
          <Text style={styles.itemLabel}>Item {index + 1}</Text>
          {item.productId ? (
            <View style={styles.linkedChip}>
              <Ionicons name="link-outline" size={11} color={ios.system.greenInk} />
              <Text style={styles.linkedChipText}>Linked</Text>
            </View>
          ) : (
            <Text style={styles.unlinkedHint}>not linked — won&apos;t update stock</Text>
          )}
        </View>
        {canRemove ? (
          <Pressable onPress={() => onRemove(index)} hitSlop={8}>
            <Text style={styles.removeText}>Remove</Text>
          </Pressable>
        ) : null}
      </View>

      {/* Description with autocomplete + scan icon */}
      <View style={{ marginBottom: 8 }}>
        <View
          style={{
            flexDirection: "row",
            justifyContent: "space-between",
            alignItems: "center",
            marginBottom: 4,
          }}
        >
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
                <Text style={styles.sugName} numberOfLines={1}>
                  {p.name}
                </Text>
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
            onChangeText={(v) => onUpdate(index, { qty: v })}
            placeholder="1"
            placeholderTextColor={ios.label3}
            keyboardType="number-pad"
          />
        </View>
        <View style={{ flex: 1 }}>
          <Text style={styles.fieldLabel}>
            {Number(item.packSize) > 1 ? "Cost / case ($)" : "Unit cost ($)"}
          </Text>
          <TextInput
            style={styles.textInput}
            value={item.unitCost}
            onChangeText={(v) => onUpdate(index, { unitCost: v })}
            placeholder="0.00"
            placeholderTextColor={ios.label3}
            keyboardType="decimal-pad"
          />
        </View>
        <View style={{ width: 92 }}>
          <Text style={styles.fieldLabel}>Pcs/case</Text>
          <TextInput
            style={styles.textInput}
            value={item.packSize}
            onChangeText={(v) => onUpdate(index, { packSize: v.replace(/[^0-9]/g, "") })}
            placeholder="—"
            placeholderTextColor={ios.label3}
            keyboardType="number-pad"
          />
        </View>
      </View>
      {Number(item.packSize) > 1 ? (
        <Text style={styles.packHint}>
          Case line: stock receives qty × {item.packSize} pieces at cost ÷ {item.packSize} each.
        </Text>
      ) : null}
      {scanOpen ? (
        <BarcodeScanner onScanned={handleScanned} onClose={() => setScanOpen(false)} />
      ) : null}
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
  scanSub: {
    fontSize: 12,
    fontFamily: "Inter_400Regular",
    color: ios.brand,
    opacity: 0.8,
    marginTop: 1,
  },
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
  fieldLabel: {
    fontSize: 12,
    fontFamily: "Inter_600SemiBold",
    color: ios.label2,
    marginBottom: 5,
    letterSpacing: 0.2,
  },
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
  linkedChip: {
    flexDirection: "row",
    alignItems: "center",
    gap: 3,
    backgroundColor: ios.system.greenWash,
    borderRadius: 6,
    paddingHorizontal: 6,
    paddingVertical: 2,
  },
  linkedChipText: { fontSize: 10, fontFamily: "Inter_600SemiBold", color: ios.system.greenInk },
  unlinkedHint: { fontSize: 10, fontFamily: "Inter_400Regular", color: ios.label3 },
  packHint: { fontSize: 11, fontFamily: "Inter_400Regular", color: ios.label3 },
  addItemBtn: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 6,
    paddingVertical: 12,
    borderRadius: 10,
    backgroundColor: ios.fill3,
    marginTop: 4,
  },
  addItemText: { fontSize: 14, fontFamily: "Inter_600SemiBold", color: ios.brand },
});
