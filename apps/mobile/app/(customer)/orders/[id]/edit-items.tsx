import { useState, useMemo, useEffect } from "react";
import { ActivityIndicator, Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { Ionicons } from "@expo/vector-icons";
import { useLocalSearchParams, useRouter } from "expo-router";
import { ios } from "@routeflow/ui/tokens";
import { NavBackButton, NavBar } from "@routeflow/ui/mobile/ios";
import { QtyTextInput } from "../../../../components/QtyStepper";
import { UndoStrip } from "../../../../components/UndoStrip";
import {
  useBuyerOrder,
  useBuyerProducts,
  useBuyerUpdateOrderItems,
} from "../../../../lib/api/buyer";
import { showToast } from "../../../../lib/toast";
import { buyerEditSaveError } from "../../../../lib/buyer-edit-save-error";
import { ENTER_ONE_OR_MORE } from "../../../../lib/qty";
import {
  addCatalogItem,
  buyerEditPriceText,
  buyerSavePlan,
  CUSTOM_LINES_NOTE,
  customLineCount,
  draftCount,
  draftKey,
  hydrateBuyerDraft,
  orderUnitLabel,
  readOnlyNotice,
  readOnlyQtyText,
  restoreDraftRow,
  setDraftCount,
  type BuyerDraftItem,
} from "../../../../lib/buyer-edit-items";

type DraftItem = BuyerDraftItem;

export default function BuyerEditItemsScreen() {
  const router = useRouter();
  const { id } = useLocalSearchParams<{ id: string }>();
  const { data: order, isLoading } = useBuyerOrder(id);
  const { data: catalogData } = useBuyerProducts({ limit: 200 });
  const updateMut = useBuyerUpdateOrderItems();
  const [showCatalog, setShowCatalog] = useState(false);

  const [draft, setDraft] = useState<Record<string, DraftItem>>({});
  // B1395: the row just removed (for Undo) and the one line a row says under itself (the limit, or "Enter 1 or more.").
  const [removed, setRemoved] = useState<DraftItem | null>(null);
  const [note, setNote] = useState<{ key: string; text: string } | null>(null);

  // #2316 review: the unit status is part of the draft's identity — a unit line cancelled after
  // load flips the order editable, and the draft must be rebuilt then, never carry a stale count.
  const unitKey = order ? orderUnitLabel(order.lineItems) : null;

  // Populate draft once order loads (and again whenever its unit status changes)
  useEffect(() => {
    if (!order) return;
    // #2270: a unit line hydrates its COUNT (SA-388), never the stored base qty.
    setDraft(hydrateBuyerDraft(order.lineItems));
    // Run only when the order first loads — intentionally omitting draft from deps
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [order?.id, unitKey]);

  const items = useMemo(() => Object.values(draft).filter((i) => i.qty > 0), [draft]);

  // B297 row 352: rows are keyed by their stored line (`draftKey`), so two lines of one product stay two rows.
  // B1395 (SA-1292): every count is in the row's own unit (a box on a box row) and goes through the one helper.
  const setCount = (key: string, count: number) => {
    const edit = setDraftCount(draft, key, count);
    setDraft(edit.draft);
    setRemoved(edit.removed);
    setNote(edit.limit ? { key, text: edit.limit } : null);
  };
  const undoRemove = () => {
    if (removed) setDraft((d) => restoreDraftRow(d, removed));
    setRemoved(null);
  };

  const addFromCatalog = (p: any) => {
    setDraft((d) => addCatalogItem(d, p));
    setRemoved(null);
    setNote(null);
    setShowCatalog(false);
  };

  const save = () => {
    // #2270: an order with a live unit line is read-only for buyers (the server refuses every
    // buyer edit of it) — buyerSavePlan refuses locally, so no request is ever sent for it.
    const plan = buyerSavePlan(order?.lineItems ?? [], draft);
    if (plan.kind === "refuse") {
      showToast(plan.message);
      return;
    }
    updateMut.mutate(
      { orderId: id, items: plan.items },
      {
        onSuccess: (updated) => {
          if (updated.status === "PENDING" && order?.status === "CONFIRMED") {
            showToast("Items saved — order reverted to Pending for re-confirmation.");
          } else {
            showToast("Items updated");
          }
          router.back();
        },
        onError: (e: any) => showToast(buyerEditSaveError(e)),
      },
    );
  };

  if (isLoading || !order) {
    return (
      <SafeAreaView style={styles.safe} edges={["top", "left", "right"]}>
        <NavBar
          inlineTitle="Edit items"
          leading={<NavBackButton label="Back" onPress={() => router.back()} />}
        />
        <View style={styles.center}>
          <ActivityIndicator color={ios.brand} />
        </View>
      </SafeAreaView>
    );
  }

  const catalog = catalogData?.data ?? [];
  const unitLabel = orderUnitLabel(order.lineItems);
  const readOnly = unitLabel != null;

  return (
    <SafeAreaView style={styles.safe} edges={["top", "left", "right"]}>
      <NavBar
        inlineTitle="Edit items"
        leading={<NavBackButton label="Back" onPress={() => router.back()} />}
      />

      <ScrollView showsVerticalScrollIndicator={false}>
        {readOnly ? <Text style={styles.notice}>{readOnlyNotice(unitLabel)}</Text> : null}
        {/* B889: seller-added custom lines aren't editable here — say so, as web does. */}
        {customLineCount(order.lineItems) > 0 ? (
          <Text style={styles.notice}>{CUSTOM_LINES_NOTE}</Text>
        ) : null}
        {removed ? <UndoStrip name={removed.name} onUndo={undoRemove} /> : null}
        {items.length === 0 ? (
          <Text style={styles.empty}>No items — add from catalog below.</Text>
        ) : (
          <View style={styles.section}>
            {items.map((item) => (
              <View key={draftKey(item)} style={styles.itemRow}>
                <View style={{ flex: 1 }}>
                  <Text style={styles.itemName} numberOfLines={2}>
                    {item.name}
                  </Text>
                  <Text style={styles.itemPrice}>{buyerEditPriceText(item)}</Text>
                  {note?.key === draftKey(item) ? (
                    <Text style={styles.itemNote}>{note.text}</Text>
                  ) : null}
                </View>
                {readOnly ? (
                  <Text style={styles.qtyText}>{readOnlyQtyText(item)}</Text>
                ) : (
                  <View style={styles.qtyRow}>
                    <Pressable
                      style={styles.qtyBtn}
                      onPress={() => setCount(draftKey(item), draftCount(item) - 1)}
                      hitSlop={6}
                    >
                      <Ionicons name="remove" size={16} color={ios.brand} />
                    </Pressable>
                    <QtyTextInput
                      value={draftCount(item)}
                      min={1}
                      rejectNonDigits
                      emptyMeansZero={false}
                      onChangeQty={(n) => setCount(draftKey(item), n)}
                      onReject={() => setNote({ key: draftKey(item), text: ENTER_ONE_OR_MORE })}
                      onZero={() => setCount(draftKey(item), 0)}
                      style={styles.qtyInput}
                    />
                    <Pressable
                      style={styles.qtyBtn}
                      onPress={() => setCount(draftKey(item), draftCount(item) + 1)}
                      hitSlop={6}
                    >
                      <Ionicons name="add" size={16} color={ios.brand} />
                    </Pressable>
                  </View>
                )}
              </View>
            ))}
          </View>
        )}

        {readOnly ? null : (
          <Pressable style={styles.addBtn} onPress={() => setShowCatalog((v) => !v)}>
            <Ionicons name="add-circle-outline" size={18} color={ios.brand} />
            <Text style={styles.addBtnText}>{showCatalog ? "Hide catalog" : "Add product"}</Text>
          </Pressable>
        )}

        {!readOnly && showCatalog && (
          <View style={styles.section}>
            {catalog.map((p) => (
              <Pressable key={p.id} style={styles.catalogRow} onPress={() => addFromCatalog(p)}>
                <View style={{ flex: 1 }}>
                  <Text style={styles.itemName} numberOfLines={1}>
                    {p.name}
                  </Text>
                  <Text style={styles.itemPrice}>
                    {buyerEditPriceText({
                      unitPrice: p.buyerPrice,
                      unit: p.unit,
                      unitsPerBox: p.unitsPerBox,
                    })}
                  </Text>
                </View>
                <Ionicons name="add" size={20} color={ios.brand} />
              </Pressable>
            ))}
          </View>
        )}

        {readOnly ? null : (
          <View style={styles.footer}>
            <Pressable
              style={[styles.saveBtn, updateMut.isPending && { opacity: 0.6 }]}
              onPress={save}
              disabled={updateMut.isPending}
            >
              <Text style={styles.saveBtnText}>
                {updateMut.isPending ? "Saving…" : "Save changes"}
              </Text>
            </Pressable>
          </View>
        )}
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: ios.bg },
  center: { flex: 1, alignItems: "center", justifyContent: "center" },
  empty: { color: ios.label2, fontSize: 14, textAlign: "center", margin: 32 },
  qtyText: { color: ios.label, fontSize: 15, fontWeight: "600", marginLeft: 12 },
  notice: { color: ios.label2, fontSize: 14, marginHorizontal: 16, marginTop: 12, lineHeight: 20 },
  section: {
    marginHorizontal: 16,
    marginTop: 12,
    backgroundColor: "#fff",
    borderRadius: 14,
    overflow: "hidden",
  },
  itemRow: {
    flexDirection: "row",
    alignItems: "center",
    padding: 14,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: ios.separator,
  },
  catalogRow: {
    flexDirection: "row",
    alignItems: "center",
    padding: 14,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: ios.separator,
  },
  itemName: { fontSize: 15, color: ios.label, flexShrink: 1 },
  itemPrice: { fontSize: 13, color: ios.label2, marginTop: 2 },
  itemNote: { fontSize: 12, color: ios.label2, marginTop: 2 },
  qtyRow: { flexDirection: "row", alignItems: "center", gap: 8 },
  qtyBtn: {
    width: 30,
    height: 30,
    borderRadius: 15,
    backgroundColor: ios.fill,
    alignItems: "center",
    justifyContent: "center",
  },
  qtyInput: {
    width: 36,
    textAlign: "center",
    fontSize: 15,
    color: ios.label,
    borderBottomWidth: 1,
    borderBottomColor: ios.separator,
    paddingVertical: 2,
  },
  addBtn: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    marginHorizontal: 16,
    marginTop: 16,
    paddingVertical: 12,
  },
  addBtnText: { color: ios.brand, fontSize: 15 },
  footer: { margin: 16, marginTop: 24 },
  saveBtn: {
    backgroundColor: ios.brand,
    borderRadius: 14,
    paddingVertical: 16,
    alignItems: "center",
  },
  saveBtnText: { color: "#fff", fontSize: 16, fontWeight: "700" },
});
