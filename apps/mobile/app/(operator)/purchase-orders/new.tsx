import { useCallback, useEffect, useRef, useState } from "react";
import { Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { Ionicons } from "@expo/vector-icons";
import { useFocusEffect, useRouter } from "expo-router";
import { ios } from "@routeflow/ui/tokens";
import { FormField, FormSection, FormSheet, FormTextInput } from "../../../components/FormSheet";
import { OptionPickerSheet } from "../../../components/OptionPickerSheet";
import { useCreatePO, useSuppliers } from "../../../lib/api/purchase-orders";
import { normalizeBoxesPieces, roundUnitCost } from "@routeflow/pricing";
import { useProductPickerStore, type PickedProduct } from "../../../store/productPickerStore";
import { showToast } from "../../../lib/toast";

interface LineItem {
  productId: string;
  productName: string;
  /** Base units (pieces) ordered — only used when `unitsPerBox` <= 1. */
  qtyOrdered: string;
  /** Whole boxes ordered — only used when `unitsPerBox` > 1. */
  boxes: string;
  /** Loose pieces beyond whole boxes — pairs with `boxes`. */
  pieces: string;
  /** Cost per SELLING UNIT: per box on a boxed line, per piece otherwise. */
  unitCost: string;
  unitsPerBox: number;
  unit: string;
  pickerKey: string;
}

function makeKey(index: number) {
  return `po-item-${index}-${Date.now()}`;
}

const EMPTY_ITEM = (index: number): LineItem => ({
  productId: "",
  productName: "",
  qtyOrdered: "",
  boxes: "",
  pieces: "",
  unitCost: "",
  unitsPerBox: 0,
  unit: "",
  pickerKey: makeKey(index),
});

/** The operator-editable (free-text) line fields. */
type LineTextField = "qtyOrdered" | "boxes" | "pieces" | "unitCost";

/**
 * Mirror of web's `resolvePOLine` (apps/web/app/(dashboard)/inventory/page.tsx).
 * A boxed line is entered as boxes + loose pieces at a cost per BOX, but
 * `PurchaseOrderItem.qtyOrdered`/`unitCost` are stored in PIECES and per PIECE
 * — receivePurchaseOrder takes the stored line at face value — so the
 * conversion has to happen before the PO is posted.
 */
function resolvePOLine(item: LineItem): { qty: number; unitCost: number } {
  const upb = item.unitsPerBox;
  if (upb > 1) {
    const boxes = Math.max(0, Math.trunc(Number(item.boxes) || 0));
    const pieces = Math.max(0, Math.trunc(Number(item.pieces) || 0));
    const qty = normalizeBoxesPieces({ boxes, pieces, unitsPerBox: upb }).qty;
    const costPerBox = Number(item.unitCost) || 0;
    return { qty, unitCost: roundUnitCost(costPerBox / upb) };
  }
  return { qty: Number(item.qtyOrdered) || 0, unitCost: Number(item.unitCost) || 0 };
}

export default function NewPurchaseOrderScreen() {
  const router = useRouter();
  const createMut = useCreatePO();
  const { data: suppliers, refetch: refetchSuppliers } = useSuppliers();

  const [supplierId, setSupplierId] = useState("");
  const [supplierName, setSupplierName] = useState("");
  const [supplierPickerOpen, setSupplierPickerOpen] = useState(false);
  const [expectedDate, setExpectedDate] = useState("");
  const [notes, setNotes] = useState("");
  const [items, setItems] = useState<LineItem[]>([EMPTY_ITEM(0)]);

  const getSelection = useProductPickerStore((s) => s.selections);
  const clearSelection = useProductPickerStore((s) => s.clearSelection);
  const prevSelectionsRef = useRef<Record<string, PickedProduct>>({});

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
          const upb = Math.max(0, Math.trunc(Number(sel.unitsPerBox ?? 0)));
          // `standardCost` is per PIECE; scale it up when the cost field
          // collects a per-BOX price (same convention as Quick Receive).
          const prefill = sel.standardCost != null ? sel.standardCost * (upb > 1 ? upb : 1) : null;
          return {
            ...item,
            productId: sel.id,
            productName: sel.name,
            unitsPerBox: upb,
            unit: sel.unit ?? "",
            unitCost: prefill != null ? String(roundUnitCost(prefill)) : item.unitCost,
          };
        }
        return item;
      }),
    );
    prevSelectionsRef.current = { ...getSelection };
  }, [getSelection, clearSelection]);

  const pickSupplier = () => setSupplierPickerOpen(true);

  const pickProduct = (item: LineItem) => {
    router.push({
      pathname: "/(operator)/purchase-orders/pick-product",
      params: { callbackKey: item.pickerKey },
    });
  };

  // Only the free-text fields are operator-editable; `unitsPerBox`/`unit` come
  // from the picked product and must never take a raw string.
  const updateItem = (index: number, field: LineTextField, value: string) => {
    setItems((prev) => prev.map((it, i) => (i === index ? { ...it, [field]: value } : it)));
  };

  const addItem = () => setItems((prev) => [...prev, EMPTY_ITEM(prev.length)]);
  const removeItem = (index: number) => setItems((prev) => prev.filter((_, i) => i !== index));

  const submit = () => {
    if (!supplierId) {
      showToast("Please select a supplier.");
      return;
    }

    // Boxed lines convert to a piece total + per-piece cost here: the PO row is
    // stored in PIECES and receiving trusts it at face value (an over-receipt is
    // now rejected, not clamped — a box-denominated PO cannot be received).
    const parsedItems = items
      .filter((it) => it.productId)
      .map((it) => {
        const { qty, unitCost } = resolvePOLine(it);
        return { productId: it.productId, qtyOrdered: qty, unitCost };
      });

    if (parsedItems.length === 0) {
      showToast("Add at least one product.");
      return;
    }
    if (parsedItems.some((it) => it.qtyOrdered <= 0)) {
      showToast("Each item needs a quantity greater than 0.");
      return;
    }

    const dto: any = { supplierId, items: parsedItems };
    if (expectedDate.trim()) dto.expectedDate = expectedDate.trim();
    if (notes.trim()) dto.notes = notes.trim();

    createMut.mutate(dto, {
      onSuccess: (result) => {
        router.replace(`/(operator)/purchase-orders/${result.id}`);
      },
      onError: (e: any) => showToast(e?.response?.data?.message ?? e?.message ?? "Try again."),
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
                    style={[styles.pickerText, !item.productName && styles.pickerPlaceholder]}
                    numberOfLines={1}
                  >
                    {item.productName || "Select product…"}
                  </Text>
                  <Ionicons name="chevron-forward" size={14} color={ios.label3} />
                </View>
              </Pressable>
            </FormField>
            {item.unitsPerBox > 1 ? (
              <>
                <View style={styles.row2}>
                  <View style={{ flex: 1 }}>
                    <FormField label="Boxes ordered">
                      <FormTextInput
                        value={item.boxes}
                        onChangeText={(v) => updateItem(index, "boxes", v)}
                        placeholder="0"
                        keyboardType="number-pad"
                      />
                    </FormField>
                  </View>
                  <View style={{ flex: 1 }}>
                    <FormField label="+ Pieces">
                      <FormTextInput
                        value={item.pieces}
                        onChangeText={(v) => updateItem(index, "pieces", v)}
                        placeholder="0"
                        keyboardType="number-pad"
                      />
                    </FormField>
                  </View>
                </View>
                <FormField
                  label="Cost per box ($)"
                  hint={`1 box = ${item.unitsPerBox} ${item.unit || "units"} · ${
                    resolvePOLine(item).qty
                  } pcs total`}
                >
                  <FormTextInput
                    value={item.unitCost}
                    onChangeText={(v) => updateItem(index, "unitCost", v)}
                    placeholder="0.00"
                    keyboardType="decimal-pad"
                  />
                </FormField>
              </>
            ) : (
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
            )}
          </View>
        ))}

        <Pressable style={styles.addItemBtn} onPress={addItem}>
          <Text style={styles.addItemText}>+ Add item</Text>
        </Pressable>
      </FormSection>

      <OptionPickerSheet
        visible={supplierPickerOpen}
        title="Supplier"
        options={(suppliers ?? []).map((s: any) => ({ id: s.id, label: s.name }))}
        selectedId={supplierId}
        onClose={() => setSupplierPickerOpen(false)}
        onSelect={(opt) => {
          setSupplierId(opt.id);
          setSupplierName(opt.label);
          setSupplierPickerOpen(false);
        }}
      />
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
