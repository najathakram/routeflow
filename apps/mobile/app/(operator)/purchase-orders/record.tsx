import { useState } from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { useRouter } from "expo-router";
import { ios } from "@routeflow/ui/tokens";
import { FormField, FormSection, FormSheet, FormTextInput } from "../../../components/FormSheet";
import { OptionPickerSheet } from "../../../components/OptionPickerSheet";
import { ProductPickerSheet } from "../../../components/ProductPickerSheet";
import { BarcodeFab } from "../../../components/BarcodeFab";
import { useRecordPurchase } from "../../../lib/api/inventory";
import { useSuppliers } from "../../../lib/api/purchase-orders";
import { normalizeBoxesPieces } from "@routeflow/pricing";
import { showToast } from "../../../lib/toast";
import { archivedMessage, resolveProductByCode } from "../../../lib/barcode-resolve";
import type { AdminProduct } from "../../../lib/api/admin";
import { nextUnitCost } from "../../../lib/purchase-receive-logic";

export default function QuickReceiveScreen() {
  const router = useRouter();
  const mut = useRecordPurchase();
  const { data: suppliers } = useSuppliers();

  const [productId, setProductId] = useState("");
  const [productName, setProductName] = useState("");
  const [productUnit, setProductUnit] = useState("");
  const [unitsPerBox, setUnitsPerBox] = useState(0);
  const [quantity, setQuantity] = useState("");
  const [boxes, setBoxes] = useState("");
  const [pieces, setPieces] = useState("");
  const [unitCost, setUnitCost] = useState("");
  const [supplierId, setSupplierId] = useState("");
  const [supplierName, setSupplierName] = useState("");
  const [productPickerOpen, setProductPickerOpen] = useState(false);
  const [supplierPickerOpen, setSupplierPickerOpen] = useState(false);
  const [reference, setReference] = useState("");
  const [notes, setNotes] = useState("");

  // Boxed products (unitsPerBox > 1) collect boxes + loose pieces instead of a
  // single ambiguous quantity — mirrors web's Quick Restock modal. An operator
  // typing a box count into a field the server reads as PIECES is what drove
  // on-hand stock hugely negative.
  const isBoxed = unitsPerBox > 1;
  const totalPieces = isBoxed
    ? normalizeBoxesPieces({
        boxes: Number(boxes) || 0,
        pieces: Number(pieces) || 0,
        unitsPerBox,
      }).qty
    : 0;

  const pickProduct = () => setProductPickerOpen(true);
  const pickSupplier = () => setSupplierPickerOpen(true);

  // Shared by the picker's onSelect and the scan FAB (B264) so a scanned
  // product fills the form exactly like a tapped one.
  const applyPickedProduct = (p: AdminProduct) => {
    // F4 (independent review, PR-3): capture BEFORE setProductId below, so
    // this compares against the product being REPLACED, not the new one.
    const isNewProduct = p.id !== productId;
    setProductId(p.id);
    setProductName(p.parent?.name ? `${p.parent.name} - ${p.name}` : p.name);
    setProductUnit(p.unit ?? "");
    const upb = Math.trunc(Number(p.unitsPerBox ?? 0));
    setUnitsPerBox(Number.isFinite(upb) ? upb : 0);
    // Prefill the cost from the product's standard cost — see
    // lib/purchase-receive-logic.ts#nextUnitCost (F4, independent review)
    // for the whenever-the-product-changes rule. `standardCost` is per
    // PIECE, so scale it up when the cost field collects a box price.
    const std = p.standardCost != null ? Number(p.standardCost) : NaN;
    const prefill = upb > 1 ? std * upb : std;
    setUnitCost((cur) => nextUnitCost(cur, isNewProduct, prefill));
  };

  // B264: the receive screen had no scan entry outside the product picker
  // sheet — mirrors ProductPickerSheet's own onScanned (same resolve ->
  // archived/not-found handling), feeding the SAME apply path a tapped pick
  // uses rather than a second, parallel one.
  const onScanned = async (code: string) => {
    const trimmed = code.trim();
    if (!trimmed) return;
    try {
      const result = await resolveProductByCode<AdminProduct>(trimmed);
      if (result.archived) {
        showToast(archivedMessage(result.product));
        return;
      }
      if (!result.notFound) {
        applyPickedProduct(result.product);
        return;
      }
    } catch {
      // network error → fall through to the toast
    }
    showToast(`No product for "${trimmed}"`);
  };

  const submit = () => {
    if (!productId) {
      showToast("Please select a product.");
      return;
    }

    const base = {
      productId,
      unitCost: Number(unitCost) || 0,
      supplierId: supplierId || undefined,
      reference: reference.trim() || undefined,
      notes: notes.trim() || undefined,
    };
    const handlers = {
      onSuccess: () => {
        showToast("Stock received");
        router.back();
      },
      onError: (e: any) => showToast(e?.response?.data?.message ?? e?.message ?? "Try again."),
    };

    if (isBoxed) {
      if (totalPieces <= 0) {
        showToast("Enter at least one box or piece to receive.");
        return;
      }
      // Send `boxes`/`pieces` — never a bare `quantity` — for a boxed receipt;
      // the API resolves the piece total from the split, and a bare `quantity`
      // still means PIECES to it (InventoryService.recordPurchase).
      mut.mutate(
        {
          ...base,
          boxes: Math.max(0, Math.trunc(Number(boxes) || 0)),
          pieces: Math.max(0, Math.trunc(Number(pieces) || 0)),
        },
        handlers,
      );
      return;
    }

    const qty = Number(quantity);
    if (!Number.isFinite(qty) || qty <= 0) {
      showToast("Enter a quantity greater than 0.");
      return;
    }
    mut.mutate({ ...base, quantity: qty }, handlers);
  };

  // BarcodeFab renders as a SIBLING of FormSheet, not a child — see edit.tsx
  // (invoice edit, B265) for why: FormSheet's children scroll, the FAB must not.
  return (
    <>
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
          {isBoxed ? (
            <>
              <View style={styles.row2}>
                <View style={{ flex: 1 }}>
                  <FormField label="Boxes received">
                    <FormTextInput
                      value={boxes}
                      onChangeText={setBoxes}
                      placeholder="0"
                      keyboardType="number-pad"
                    />
                  </FormField>
                </View>
                <View style={{ flex: 1 }}>
                  <FormField label="+ Pieces">
                    <FormTextInput
                      value={pieces}
                      onChangeText={setPieces}
                      placeholder="0"
                      keyboardType="number-pad"
                    />
                  </FormField>
                </View>
              </View>
              <FormField
                label="Cost per box ($)"
                hint={`1 box = ${unitsPerBox} ${productUnit || "units"}${
                  totalPieces > 0 ? ` · ${totalPieces} pcs total` : ""
                }`}
              >
                <FormTextInput
                  value={unitCost}
                  onChangeText={setUnitCost}
                  placeholder="0.00"
                  keyboardType="decimal-pad"
                />
              </FormField>
            </>
          ) : (
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
          )}
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

        <ProductPickerSheet
          visible={productPickerOpen}
          title="Product"
          selectedId={productId}
          onClose={() => setProductPickerOpen(false)}
          onSelect={(p) => {
            applyPickedProduct(p);
            setProductPickerOpen(false);
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
            setSupplierName(opt.id ? opt.label : "");
            setSupplierPickerOpen(false);
          }}
        />
      </FormSheet>
      <BarcodeFab onScanned={onScanned} hidden={productPickerOpen || supplierPickerOpen} />
    </>
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
