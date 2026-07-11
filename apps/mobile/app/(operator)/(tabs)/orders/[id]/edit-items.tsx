import { useEffect, useMemo, useState } from "react";
import {
  ActivityIndicator,
  Modal,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { Ionicons } from "@expo/vector-icons";
import { useLocalSearchParams, useRouter } from "expo-router";
import { ios } from "@routeflow/ui/tokens";
import { NavBackButton, NavBar, SearchBar } from "@routeflow/ui/mobile/ios";
import { useAdminOrder } from "../../../../../lib/api/admin";
import {
  useCustomerPriceHistory,
  useUpdateOrderItems,
  type UpdateOrderItemInput,
} from "../../../../../lib/api/orders";
import { useProducts } from "../../../../../lib/api/products";
import { showToast } from "../../../../../lib/toast";
import { confirm } from "../../../../../lib/confirm";
import { computeLineSubtotal, effectiveQty, roundMoney } from "../../../../../lib/pricing";
import { sanitizeIntInput } from "../../../../../lib/qty";
import { MoneyTextInput } from "../../../../../components/MoneyTextInput";
import { useAuthStore } from "../../../../../lib/auth-store";

/**
 * One row of the in-progress edit. `qty` is total pieces (server's source of
 * truth). For products with `unitsPerBox > 1` operators may also set
 * `boxes`/`pieces` and the server recomputes qty + uses BOX-price proration
 * (see apps/api/src/orders/orders.service.ts:594).
 */
type DraftItem = {
  productId: string;
  qty: number;
  boxes?: number;
  pieces?: number;
  unitsPerBox?: number | null;
  unitPrice: number;
  catalogPrice: number;
  name: string;
  unit?: string;
  overrideReason?: string;
  /** Per-line note (buyer-visible) — must round-trip through the replace-all save. */
  notes?: string;
};

/**
 * A new ad-hoc (unlisted) line being added in this edit session. Serialised as
 * `{ name, qty, unitPrice }` on save (no productId; never boxed). Existing
 * unlisted lines on the order are NOT loaded here (the replace-all edit only
 * re-sends catalog lines + any newly added unlisted lines).
 */
type UnlistedDraft = {
  id: string;
  name: string;
  unitPrice: number;
  qty: number;
  /** Per-line note (buyer-visible) — must round-trip through the replace-all save. */
  notes?: string;
};

function newLocalId(): string {
  return `${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function toNumber(v: number | string | null | undefined): number {
  if (typeof v === "number") return v;
  if (typeof v === "string") {
    const n = Number(v);
    return Number.isFinite(n) ? n : 0;
  }
  return 0;
}

export default function EditOrderItemsScreen() {
  const router = useRouter();
  const { id } = useLocalSearchParams<{ id: string }>();
  const { data: order, isLoading } = useAdminOrder(id ?? "");
  // Remembered per-customer prices — pre-fill a newly added line's price so a
  // prior discount carries forward (operator can still change it).
  const { data: priceHistory } = useCustomerPriceHistory((order as any)?.customerId);
  const userRole = useAuthStore((s) => s.user?.role);
  // Customer accounts shouldn't reach this screen, but defend anyway —
  // box-splitting is operator/driver-only by product policy.
  const canSplitBoxes = userRole !== "CUSTOMER";

  const [draft, setDraft] = useState<Record<string, DraftItem>>({});
  // New + existing ad-hoc lines (productId null). Kept separate from `draft`
  // (which is keyed by productId) and re-sent on save so they aren't dropped.
  const [unlisted, setUnlisted] = useState<UnlistedDraft[]>([]);
  const [unlistedModalOpen, setUnlistedModalOpen] = useState(false);
  const [showPicker, setShowPicker] = useState(false);
  const [substituteFor, setSubstituteFor] = useState<string | null>(null);
  const [priceEditItem, setPriceEditItem] = useState<DraftItem | null>(null);
  const updateMut = useUpdateOrderItems();

  useEffect(() => {
    if (!order) return;
    const next: Record<string, DraftItem> = {};
    const nextUnlisted: UnlistedDraft[] = [];
    for (const li of order.lineItems) {
      // Unlisted line (no productId): carry it through the replace-all save so
      // it isn't lost. `name` holds the free-text label.
      if (!li.productId) {
        nextUnlisted.push({
          id: li.id ?? newLocalId(),
          name: li.name ?? "Unlisted item",
          unitPrice: toNumber(li.unitPrice),
          qty: toNumber(li.qty),
          notes: (li as any).notes ?? undefined,
        });
        continue;
      }
      const product = (li as any).product ?? {};
      const catalogPrice = toNumber(product.pricePerUnit ?? li.unitPrice);
      const upbRaw = product.unitsPerBox;
      const unitsPerBox = upbRaw == null ? null : Number(upbRaw);
      next[li.productId] = {
        productId: li.productId,
        qty: toNumber(li.qty),
        boxes: li.boxes ?? undefined,
        pieces: li.pieces ?? undefined,
        unitsPerBox,
        unitPrice: toNumber(li.unitPrice),
        catalogPrice,
        name: product.name ?? "Item",
        unit: product.unit,
        overrideReason: li.overrideReason ?? undefined,
        notes: (li as any).notes ?? undefined,
      };
    }
    setDraft(next);
    setUnlisted(nextUnlisted);
  }, [order]);

  // Live total mirrors the server math (BOX-price proration when split).
  const total = useMemo(() => {
    let t = 0;
    for (const it of Object.values(draft)) {
      const qty = effectiveQty(it, it.unitsPerBox);
      if (qty <= 0) continue;
      t += computeLineSubtotal({
        unitPrice: it.unitPrice,
        qty,
        boxes: it.boxes ?? null,
        pieces: it.pieces ?? null,
        unitsPerBox: it.unitsPerBox ?? null,
      });
    }
    for (const u of unlisted) {
      if (u.qty <= 0) continue;
      t += computeLineSubtotal({ unitPrice: u.unitPrice, qty: u.qty });
    }
    return t;
  }, [draft, unlisted]);

  const itemCount =
    Object.values(draft).filter((it) => effectiveQty(it, it.unitsPerBox) > 0).length +
    unlisted.filter((u) => u.qty > 0).length;

  // ── Unlisted line helpers ──────────────────────────────────────────────────
  const addUnlisted = (name: string, unitPrice: number, qty: number) =>
    setUnlisted((u) => [...u, { id: newLocalId(), name: name.trim(), unitPrice, qty }]);
  const setUnlistedQty = (id: string, qty: number) =>
    setUnlisted((u) =>
      qty <= 0 ? u.filter((x) => x.id !== id) : u.map((x) => (x.id === id ? { ...x, qty } : x)),
    );
  const setUnlistedPrice = (id: string, value: number | null) =>
    setUnlisted((u) => {
      const price = value == null || value < 0 ? 0 : value;
      return u.map((x) => (x.id === id ? { ...x, unitPrice: price } : x));
    });
  const setUnlistedName = (id: string, name: string) =>
    setUnlisted((u) => u.map((x) => (x.id === id ? { ...x, name } : x)));
  const removeUnlisted = (id: string) => setUnlisted((u) => u.filter((x) => x.id !== id));

  // ── Per-line helpers ──────────────────────────────────────────────────────

  const setQty = (id: string, qty: number) =>
    setDraft((d) => {
      const cur = d[id];
      if (!cur) return d;
      const q = Math.max(0, Math.floor(qty));
      const next = { ...d };
      if (q === 0) delete next[id];
      // Plain qty path — clear boxes/pieces so the server treats it as flat.
      else next[id] = { ...cur, qty: q, boxes: undefined, pieces: undefined };
      return next;
    });

  const setBoxes = (id: string, boxes: number) =>
    setDraft((d) => {
      const cur = d[id];
      if (!cur) return d;
      const upb = Number(cur.unitsPerBox ?? 0);
      const b = Math.max(0, Math.floor(boxes));
      const pcs = cur.pieces ?? 0;
      const qty = b * upb + pcs;
      const next = { ...d };
      if (qty === 0) delete next[id];
      else next[id] = { ...cur, boxes: b, pieces: pcs, qty };
      return next;
    });

  const setPieces = (id: string, pieces: number) =>
    setDraft((d) => {
      const cur = d[id];
      if (!cur) return d;
      const upb = Number(cur.unitsPerBox ?? 0);
      const pcs = Math.max(0, Math.floor(pieces));
      const b = cur.boxes ?? 0;
      const qty = b * upb + pcs;
      const next = { ...d };
      if (qty === 0) delete next[id];
      else next[id] = { ...cur, boxes: b, pieces: pcs, qty };
      return next;
    });

  const incQty = (id: string) => {
    const cur = draft[id];
    if (!cur) return;
    const upb = Number(cur.unitsPerBox ?? 0);
    if (upb > 1) setBoxes(id, (cur.boxes ?? 0) + 1);
    else setQty(id, (cur.qty ?? 0) + 1);
  };

  const decQty = (id: string) => {
    const cur = draft[id];
    if (!cur) return;
    const upb = Number(cur.unitsPerBox ?? 0);
    if (upb > 1) setBoxes(id, Math.max(0, (cur.boxes ?? 0) - 1));
    else setQty(id, Math.max(0, (cur.qty ?? 0) - 1));
  };

  const removeLine = (id: string) =>
    setDraft((d) => {
      const next = { ...d };
      delete next[id];
      return next;
    });

  // ── Save ─────────────────────────────────────────────────────────────────

  const save = () => {
    if (!id) return;
    const catalogItems: UpdateOrderItemInput[] = Object.values(draft)
      .map((i): UpdateOrderItemInput => {
        const qty = effectiveQty(i, i.unitsPerBox);
        const base: {
          productId: string;
          qty: number;
          unitPrice: number;
          boxes?: number;
          pieces?: number;
          overrideReason?: string;
          notes?: string;
        } = {
          productId: i.productId,
          qty,
          unitPrice: i.unitPrice,
        };
        if (i.boxes != null || i.pieces != null) {
          base.boxes = i.boxes ?? 0;
          base.pieces = i.pieces ?? 0;
        }
        if (i.overrideReason) base.overrideReason = i.overrideReason;
        // This save is a replace-all — re-send the note or it is silently wiped.
        if (i.notes?.trim()) base.notes = i.notes.trim();
        return base;
      })
      .filter((i) => "productId" in i && i.qty > 0);
    // Unlisted lines → `{ name, qty, unitPrice }` (no productId; never boxed).
    const unlistedItems: UpdateOrderItemInput[] = unlisted
      .filter((u) => u.qty > 0 && u.name.trim() !== "" && u.unitPrice > 0)
      .map((u) => ({
        name: u.name.trim(),
        qty: u.qty,
        unitPrice: u.unitPrice,
        ...(u.notes?.trim() ? { notes: u.notes.trim() } : {}),
      }));
    const items = [...catalogItems, ...unlistedItems];
    if (items.length === 0) {
      showToast("Orders can't be saved empty.");
      return;
    }
    updateMut.mutate(
      { orderId: id, items },
      {
        onSuccess: () => {
          showToast("Items updated");
          // Land on the orders LIST after a successful save instead of
          // popping back to the order detail. The user reported "Back" not
          // taking them to all orders after submit; explicit navigation
          // sidesteps any unstable back-stack state when the screen was
          // reached via deep link or a fresh tab switch.
          router.replace("/(operator)/(tabs)/orders" as any);
        },
        onError: (e: any) => showToast(e?.response?.data?.message ?? e?.message ?? "Try again."),
      },
    );
  };

  if (isLoading || !order) {
    return (
      <SafeAreaView style={styles.safe} edges={["top", "left", "right"]}>
        <NavBar
          inlineTitle="Edit items"
          leading={<NavBackButton onPress={() => router.back()} />}
        />
        <View style={styles.center}>
          <ActivityIndicator color={ios.brand} />
        </View>
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView style={styles.safe} edges={["top", "left", "right"]}>
      <NavBar
        inlineTitle="Edit items"
        leading={<NavBackButton label={order.orderNumber} onPress={() => router.back()} />}
      />

      {priceEditItem ? (
        <PriceOverrideModal
          item={priceEditItem}
          onSave={(newPrice, reason) => {
            setDraft((d) => ({
              ...d,
              [priceEditItem.productId]: {
                ...priceEditItem,
                unitPrice: newPrice,
                overrideReason: reason || undefined,
              },
            }));
            setPriceEditItem(null);
          }}
          onCancel={() => setPriceEditItem(null)}
        />
      ) : null}

      <UnlistedItemModal
        open={unlistedModalOpen}
        onClose={() => setUnlistedModalOpen(false)}
        onAdd={(name, unitPrice, qty) => {
          addUnlisted(name, unitPrice, qty);
          setUnlistedModalOpen(false);
          showToast(`Added ${name}`);
        }}
      />

      {showPicker ? (
        <ProductPicker
          title={substituteFor ? "Substitute with…" : "Add product"}
          onPick={(p) => {
            const catalogPrice = toNumber(p.pricePerUnit);
            const upbRaw = p.unitsPerBox;
            const unitsPerBox = upbRaw == null ? null : Number(upbRaw);
            if (substituteFor) {
              setDraft((d) => {
                const next = { ...d };
                const old = next[substituteFor];
                const inheritedQty = old?.qty ?? 1;
                delete next[substituteFor];
                next[p.id] = {
                  productId: p.id,
                  qty: inheritedQty,
                  unitsPerBox,
                  unitPrice: catalogPrice,
                  catalogPrice,
                  name: p.name,
                  unit: p.unit,
                };
                return next;
              });
              setSubstituteFor(null);
            } else {
              setDraft((d) => {
                const existing = d[p.id];
                if (existing) {
                  // Re-add increments by 1 of the canonical unit (box if boxed,
                  // otherwise piece).
                  const upb = Number(existing.unitsPerBox ?? 0);
                  if (upb > 1) {
                    const boxes = (existing.boxes ?? 0) + 1;
                    const pieces = existing.pieces ?? 0;
                    return {
                      ...d,
                      [p.id]: { ...existing, boxes, pieces, qty: boxes * upb + pieces },
                    };
                  }
                  return { ...d, [p.id]: { ...existing, qty: (existing.qty ?? 0) + 1 } };
                }
                // Fresh add: pre-fill the remembered price for this customer +
                // product (discount OR upsell), else catalog.
                const hist = priceHistory?.[p.id];
                const startPrice = hist ? hist.lastPrice : catalogPrice;
                // 1 box for boxed, 1 piece for non-boxed.
                if (Number(unitsPerBox ?? 0) > 1) {
                  const upb = Number(unitsPerBox ?? 0);
                  return {
                    ...d,
                    [p.id]: {
                      productId: p.id,
                      qty: upb,
                      boxes: 1,
                      pieces: 0,
                      unitsPerBox,
                      unitPrice: startPrice,
                      catalogPrice,
                      name: p.name,
                      unit: p.unit,
                    },
                  };
                }
                return {
                  ...d,
                  [p.id]: {
                    productId: p.id,
                    qty: 1,
                    unitsPerBox,
                    unitPrice: startPrice,
                    catalogPrice,
                    name: p.name,
                    unit: p.unit,
                  },
                };
              });
            }
            setShowPicker(false);
          }}
          onClose={() => {
            setShowPicker(false);
            setSubstituteFor(null);
          }}
        />
      ) : (
        <>
          <ScrollView showsVerticalScrollIndicator={false}>
            <View style={{ paddingHorizontal: 16, paddingTop: 12, gap: 10 }}>
              {Object.values(draft).length === 0 && unlisted.length === 0 ? (
                <Text style={styles.empty}>No items. Add one below.</Text>
              ) : (
                Object.values(draft).map((it) => (
                  <DraftItemCard
                    key={it.productId}
                    item={it}
                    canSplitBoxes={canSplitBoxes}
                    canEditPrice={["DRAFT", "PENDING", "CONFIRMED"].includes(order.status)}
                    onIncQty={() => incQty(it.productId)}
                    onDecQty={() => decQty(it.productId)}
                    onSetQty={(n) => setQty(it.productId, n)}
                    onSetBoxes={(n) => setBoxes(it.productId, n)}
                    onSetPieces={(n) => setPieces(it.productId, n)}
                    onPressPrice={() => setPriceEditItem(it)}
                    onPressSubstitute={() => {
                      setSubstituteFor(it.productId);
                      setShowPicker(true);
                    }}
                    onRemove={() =>
                      confirm("Remove item?", it.name, () => removeLine(it.productId), {
                        confirmText: "Remove",
                        destructive: true,
                      })
                    }
                  />
                ))
              )}
              {unlisted.map((u) => (
                <UnlistedDraftCard
                  key={u.id}
                  line={u}
                  onSetName={(name) => setUnlistedName(u.id, name)}
                  onSetPrice={(raw) => setUnlistedPrice(u.id, raw)}
                  onSetQty={(n) => setUnlistedQty(u.id, n)}
                  onRemove={() =>
                    confirm("Remove item?", u.name || "Unlisted item", () => removeUnlisted(u.id), {
                      confirmText: "Remove",
                      destructive: true,
                    })
                  }
                />
              ))}
              <Pressable style={styles.addBtn} onPress={() => setShowPicker(true)}>
                <Ionicons name="add-circle-outline" size={18} color={ios.brand} />
                <Text style={styles.addBtnText}>Add product</Text>
              </Pressable>
              <Pressable style={styles.addUnlistedBtn} onPress={() => setUnlistedModalOpen(true)}>
                <Ionicons name="create-outline" size={18} color={ios.brand} />
                <Text style={styles.addBtnText}>Add unlisted item</Text>
              </Pressable>
            </View>
            <View style={{ height: 16 }} />
          </ScrollView>

          <View style={styles.footer}>
            <View>
              <Text style={styles.footerEyebrow}>
                {itemCount} ITEM{itemCount === 1 ? "" : "S"}
              </Text>
              <Text style={styles.footerTotal}>${total.toFixed(2)}</Text>
            </View>
            <Pressable
              style={[styles.saveBtn, updateMut.isPending && styles.saveBtnDisabled]}
              onPress={save}
              disabled={updateMut.isPending}
            >
              <Text style={styles.saveBtnText}>
                {updateMut.isPending ? "Saving…" : "Save changes"}
              </Text>
            </Pressable>
          </View>
        </>
      )}
    </SafeAreaView>
  );
}

// ─── Per-row card ────────────────────────────────────────────────────────────

/**
 * Draft line as a card with three zones:
 *   ┌─────────────────────────────────────────────┐
 *   │ Name                            $line total │  ← header
 *   │ $unit · per box of N · SKU                  │  ← meta
 *   ├─────────────────────────────────────────────┤
 *   │ Boxes  [- 2 +]    Loose pieces  [- 3 +]     │  ← editor (boxed)
 *   │   or                                        │
 *   │ Qty    [- 4 +]                              │  ← editor (loose)
 *   ├─────────────────────────────────────────────┤
 *   │ [Sub]  [Override]  [trash]                  │  ← actions
 *   └─────────────────────────────────────────────┘
 *
 * The previous design crammed everything into one row + tiny trash + tiny
 * stepper, which the user called out as ugly and missing the box/piece
 * controls. This stacked layout gives each function room to breathe.
 */
function DraftItemCard({
  item,
  canSplitBoxes,
  canEditPrice,
  onIncQty,
  onDecQty,
  onSetQty,
  onSetBoxes,
  onSetPieces,
  onPressPrice,
  onPressSubstitute,
  onRemove,
}: {
  item: DraftItem;
  canSplitBoxes: boolean;
  /** Price / discount editing is offered while the order is editable (DRAFT/PENDING/CONFIRMED). */
  canEditPrice: boolean;
  onIncQty: () => void;
  onDecQty: () => void;
  onSetQty: (n: number) => void;
  onSetBoxes: (n: number) => void;
  onSetPieces: (n: number) => void;
  onPressPrice: () => void;
  onPressSubstitute: () => void;
  onRemove: () => void;
}) {
  const isOverridden = item.unitPrice !== item.catalogPrice;
  const isUpsell = item.unitPrice > item.catalogPrice;
  // Green for an upsell (sold above catalog), orange for a discount.
  const overrideColor = isUpsell ? ios.system.greenInk : ios.system.orangeInk;
  const upb = Number(item.unitsPerBox ?? 0);
  const isBoxed = upb > 1 && canSplitBoxes;
  const qty = effectiveQty(item, item.unitsPerBox);
  const lineTotal = computeLineSubtotal({
    unitPrice: item.unitPrice,
    qty,
    boxes: item.boxes ?? null,
    pieces: item.pieces ?? null,
    unitsPerBox: item.unitsPerBox ?? null,
  });

  return (
    <View style={styles.card}>
      {/* Header: name + line total */}
      <View style={styles.cardHeader}>
        <View style={{ flex: 1, minWidth: 0 }}>
          <Text style={styles.cardName} numberOfLines={2}>
            {item.name}
          </Text>
          {/* Meta line: unit price + box hint + override badge.
              Editable (tappable) on DRAFT/PENDING/CONFIRMED; read-only otherwise. */}
          <View style={styles.cardMetaRow}>
            {canEditPrice ? (
              <Pressable onPress={onPressPrice} style={styles.priceTap} hitSlop={6}>
                {isOverridden && !isUpsell ? (
                  <Text style={styles.priceStrike}>${item.catalogPrice.toFixed(2)}</Text>
                ) : null}
                <Text style={[styles.cardMeta, isOverridden && { color: overrideColor }]}>
                  ${item.unitPrice.toFixed(2)}
                  {isBoxed ? ` / box of ${upb}` : item.unit ? ` / ${item.unit}` : ""}
                </Text>
                {isUpsell ? (
                  <Text style={{ color: ios.system.greenInk, fontSize: 11, fontWeight: "600" }}>
                    Upsell
                  </Text>
                ) : null}
                <Ionicons
                  name="pencil-outline"
                  size={11}
                  color={isOverridden ? overrideColor : ios.label3}
                />
              </Pressable>
            ) : (
              <View style={styles.priceTap}>
                {isOverridden && !isUpsell ? (
                  <Text style={styles.priceStrike}>${item.catalogPrice.toFixed(2)}</Text>
                ) : null}
                <Text style={[styles.cardMeta, isOverridden && { color: overrideColor }]}>
                  ${item.unitPrice.toFixed(2)}
                  {isBoxed ? ` / box of ${upb}` : item.unit ? ` / ${item.unit}` : ""}
                </Text>
                {isUpsell ? (
                  <Text style={{ color: ios.system.greenInk, fontSize: 11, fontWeight: "600" }}>
                    Upsell
                  </Text>
                ) : null}
              </View>
            )}
          </View>
        </View>
        <Text style={styles.cardTotal}>${lineTotal.toFixed(2)}</Text>
      </View>

      {/* Editor */}
      {isBoxed ? (
        <View style={{ gap: 8 }}>
          <StepperRow label="Boxes" value={item.boxes ?? 0} onChange={onSetBoxes} />
          <StepperRow
            label={`Loose ${item.unit ?? "pieces"}`}
            value={item.pieces ?? 0}
            onChange={onSetPieces}
            max={upb - 1}
            hint={`${upb} per box`}
          />
        </View>
      ) : (
        <StepperRow
          label={`Qty${item.unit ? ` (${item.unit})` : ""}`}
          value={item.qty}
          onChange={onSetQty}
          onIncrement={onIncQty}
          onDecrement={onDecQty}
        />
      )}

      {/* Actions */}
      <View style={styles.cardActions}>
        <Pressable style={styles.actionChip} onPress={onPressSubstitute} hitSlop={4}>
          <Ionicons name="swap-horizontal-outline" size={14} color={ios.brand} />
          <Text style={styles.actionChipText}>Substitute</Text>
        </Pressable>
        {canEditPrice ? (
          <Pressable
            style={[styles.actionChip, isOverridden && styles.actionChipActive]}
            onPress={onPressPrice}
            hitSlop={4}
          >
            <Ionicons
              name="pricetag-outline"
              size={14}
              color={isOverridden ? ios.system.orangeInk : ios.brand}
            />
            <Text style={[styles.actionChipText, isOverridden && { color: ios.system.orangeInk }]}>
              {isOverridden ? "Price overridden" : "Override price"}
            </Text>
          </Pressable>
        ) : null}
        <View style={{ flex: 1 }} />
        <Pressable style={styles.deleteBtn} onPress={onRemove} hitSlop={6}>
          <Ionicons name="trash-outline" size={16} color={ios.system.redInk} />
        </Pressable>
      </View>
    </View>
  );
}

// ─── Reusable stepper row (Boxes/Pieces/Qty) ─────────────────────────────────

function StepperRow({
  label,
  value,
  onChange,
  onIncrement,
  onDecrement,
  max,
  hint,
}: {
  label: string;
  value: number;
  onChange: (n: number) => void;
  onIncrement?: () => void;
  onDecrement?: () => void;
  max?: number;
  hint?: string;
}) {
  // Local draft so the user can clear the input without it snapping back to 0.
  const [draft, setDraft] = useState(String(value));
  useEffect(() => {
    setDraft(String(value));
  }, [value]);

  const dec = () => {
    if (onDecrement) onDecrement();
    else onChange(Math.max(0, value - 1));
  };
  const inc = () => {
    if (onIncrement) onIncrement();
    else {
      const next = max != null ? Math.min(max, value + 1) : value + 1;
      onChange(next);
    }
  };

  return (
    <View style={styles.stepperRow}>
      <View style={{ flex: 1 }}>
        <Text style={styles.stepperLabel}>{label}</Text>
        {hint ? <Text style={styles.stepperHint}>{hint}</Text> : null}
      </View>
      <View style={styles.stepper}>
        <Pressable style={styles.stepBtn} onPress={dec} hitSlop={6}>
          <Text style={styles.stepText}>−</Text>
        </Pressable>
        <TextInput
          style={styles.qtyInput}
          value={draft}
          onChangeText={(txt) => {
            // Integer-only: strip non-digits + leading zeros live (no "05", no
            // decimals even when Android shows a decimal key); allow empty mid-edit.
            const clean = sanitizeIntInput(txt);
            setDraft(clean);
            if (clean === "") return;
            const n = parseInt(clean, 10);
            if (Number.isFinite(n)) {
              const clamped = max != null ? Math.min(max, n) : n;
              onChange(clamped);
            }
          }}
          onBlur={() => {
            if (draft === "") onChange(0);
            setDraft(String(value));
          }}
          keyboardType="number-pad"
          returnKeyType="done"
          maxLength={5}
          selectTextOnFocus
        />
        <Pressable style={styles.stepBtn} onPress={inc} hitSlop={6}>
          <Text style={styles.stepText}>+</Text>
        </Pressable>
      </View>
    </View>
  );
}

// ─── Price override modal ────────────────────────────────────────────────────

function PriceOverrideModal({
  item,
  onSave,
  onCancel,
}: {
  item: DraftItem;
  onSave: (newPrice: number, reason: string) => void;
  onCancel: () => void;
}) {
  const [priceText, setPriceText] = useState(item.unitPrice.toFixed(2));
  // "$ off / unit" is a lens over (catalogPrice - newPrice); the two inputs stay in sync.
  const [offText, setOffText] = useState(
    item.unitPrice < item.catalogPrice
      ? roundMoney(item.catalogPrice - item.unitPrice).toFixed(2)
      : "",
  );
  const [reason, setReason] = useState(item.overrideReason ?? "");
  const newPrice = toNumber(priceText);
  const valid = newPrice > 0;

  const onChangePrice = (raw: string) => {
    setPriceText(raw);
    const parsed = parseFloat(raw);
    if (raw.trim() === "" || isNaN(parsed)) {
      setOffText("");
      return;
    }
    setOffText(parsed < item.catalogPrice ? roundMoney(item.catalogPrice - parsed).toFixed(2) : "");
  };

  const onChangeOff = (raw: string) => {
    setOffText(raw);
    const off = parseFloat(raw);
    if (raw.trim() === "" || isNaN(off) || off <= 0) {
      setPriceText(item.catalogPrice.toFixed(2));
      return;
    }
    setPriceText(roundMoney(Math.max(0, item.catalogPrice - off)).toFixed(2));
  };

  return (
    <Modal transparent animationType="fade" onRequestClose={onCancel}>
      <Pressable style={styles.modalOverlay} onPress={onCancel}>
        <Pressable style={styles.modalCard} onPress={(e) => e.stopPropagation()}>
          <Text style={styles.modalTitle}>Override price</Text>
          <Text style={styles.modalSub}>{item.name}</Text>
          <Text style={styles.modalLabel}>List price: ${item.catalogPrice.toFixed(2)}</Text>

          <Text style={styles.modalFieldLabel}>New unit price</Text>
          <TextInput
            style={styles.modalInput}
            value={priceText}
            onChangeText={onChangePrice}
            keyboardType="decimal-pad"
            selectTextOnFocus
            autoFocus
            placeholder="0.00"
            placeholderTextColor={ios.label3}
          />

          <Text style={styles.modalFieldLabel}>Amount off / unit</Text>
          <TextInput
            style={styles.modalInput}
            value={offText}
            onChangeText={onChangeOff}
            keyboardType="decimal-pad"
            selectTextOnFocus
            placeholder="0.00"
            placeholderTextColor={ios.label3}
          />

          <Text style={styles.modalFieldLabel}>Reason (optional)</Text>
          <TextInput
            style={[styles.modalInput, { marginBottom: 16 }]}
            value={reason}
            onChangeText={setReason}
            placeholder="e.g. daily market price"
            placeholderTextColor={ios.label3}
          />

          <View style={styles.modalBtns}>
            <Pressable style={styles.modalBtnGhost} onPress={onCancel}>
              <Text style={styles.modalBtnGhostText}>Cancel</Text>
            </Pressable>
            <Pressable
              style={[styles.modalBtnFill, !valid && styles.modalBtnDisabled]}
              onPress={() => valid && onSave(newPrice, reason)}
              disabled={!valid}
            >
              <Text style={styles.modalBtnFillText}>Apply</Text>
            </Pressable>
          </View>
        </Pressable>
      </Pressable>
    </Modal>
  );
}

// ─── Unlisted draft card ─────────────────────────────────────────────────────

/**
 * Card for an ad-hoc (unlisted) line: editable free-text name + price + qty,
 * a "Custom" tag, and no product image (it isn't in the catalog).
 */
function UnlistedDraftCard({
  line,
  onSetName,
  onSetPrice,
  onSetQty,
  onRemove,
}: {
  line: UnlistedDraft;
  onSetName: (name: string) => void;
  onSetPrice: (value: number | null) => void;
  onSetQty: (n: number) => void;
  onRemove: () => void;
}) {
  const lineTotal = computeLineSubtotal({ unitPrice: line.unitPrice, qty: line.qty });
  return (
    <View style={styles.card}>
      <View style={styles.cardHeader}>
        <View style={{ flex: 1, minWidth: 0 }}>
          <View style={styles.unlistedTagRow}>
            <View style={styles.customTag}>
              <Text style={styles.customTagText}>Custom</Text>
            </View>
          </View>
          <TextInput
            style={styles.unlistedNameInput}
            value={line.name}
            onChangeText={onSetName}
            placeholder="Item name"
            placeholderTextColor={ios.label3}
          />
          <View style={styles.unlistedPriceRow}>
            <Text style={styles.cardMeta}>$</Text>
            <MoneyTextInput
              style={styles.unlistedPriceInput}
              value={line.unitPrice || null}
              onChangeValue={onSetPrice}
              placeholder="0.00"
              placeholderTextColor={ios.label3}
            />
            <Text style={styles.cardMeta}>/ unit</Text>
          </View>
        </View>
        <Text style={styles.cardTotal}>${lineTotal.toFixed(2)}</Text>
      </View>

      <StepperRow
        label="Qty"
        value={line.qty}
        onChange={onSetQty}
        onIncrement={() => onSetQty(line.qty + 1)}
        onDecrement={() => onSetQty(Math.max(0, line.qty - 1))}
      />

      <View style={styles.cardActions}>
        <View style={{ flex: 1 }} />
        <Pressable style={styles.deleteBtn} onPress={onRemove} hitSlop={6}>
          <Ionicons name="trash-outline" size={16} color={ios.system.redInk} />
        </Pressable>
      </View>
    </View>
  );
}

// ─── Unlisted item modal ─────────────────────────────────────────────────────

function UnlistedItemModal({
  open,
  onClose,
  onAdd,
}: {
  open: boolean;
  onClose: () => void;
  onAdd: (name: string, unitPrice: number, qty: number) => void;
}) {
  const [name, setName] = useState("");
  const [priceText, setPriceText] = useState("");
  const [qtyText, setQtyText] = useState("1");

  useEffect(() => {
    if (open) {
      setName("");
      setPriceText("");
      setQtyText("1");
    }
  }, [open]);

  const price = parseFloat(priceText);
  const qty = parseInt(qtyText || "0", 10);
  const valid = name.trim() !== "" && Number.isFinite(price) && price > 0 && qty > 0;

  if (!open) return null;

  return (
    <Modal transparent animationType="fade" onRequestClose={onClose}>
      <Pressable style={styles.modalOverlay} onPress={onClose}>
        <Pressable style={styles.modalCard} onPress={(e) => e.stopPropagation()}>
          <Text style={styles.modalTitle}>Add unlisted item</Text>
          <Text style={styles.modalSub}>A one-off line that isn't in your catalog.</Text>

          <Text style={styles.modalFieldLabel}>Item name</Text>
          <TextInput
            style={styles.modalInput}
            value={name}
            onChangeText={setName}
            placeholder="e.g. Delivery surcharge"
            placeholderTextColor={ios.label3}
            autoFocus
          />

          <View style={{ flexDirection: "row", gap: 10 }}>
            <View style={{ flex: 1 }}>
              <Text style={styles.modalFieldLabel}>Unit price</Text>
              <TextInput
                style={styles.modalInput}
                value={priceText}
                onChangeText={setPriceText}
                placeholder="0.00"
                placeholderTextColor={ios.label3}
                keyboardType="decimal-pad"
                selectTextOnFocus
              />
            </View>
            <View style={{ width: 96 }}>
              <Text style={styles.modalFieldLabel}>Qty</Text>
              <TextInput
                style={styles.modalInput}
                value={qtyText}
                onChangeText={(t) => setQtyText(sanitizeIntInput(t))}
                placeholder="1"
                placeholderTextColor={ios.label3}
                keyboardType="number-pad"
                maxLength={5}
                selectTextOnFocus
              />
            </View>
          </View>

          <View style={styles.modalBtns}>
            <Pressable style={styles.modalBtnGhost} onPress={onClose}>
              <Text style={styles.modalBtnGhostText}>Cancel</Text>
            </Pressable>
            <Pressable
              style={[styles.modalBtnFill, !valid && styles.modalBtnDisabled]}
              onPress={() => valid && onAdd(name.trim(), price, qty)}
              disabled={!valid}
            >
              <Text style={styles.modalBtnFillText}>Add to order</Text>
            </Pressable>
          </View>
        </Pressable>
      </Pressable>
    </Modal>
  );
}

// ─── Product picker ──────────────────────────────────────────────────────────

function ProductPicker({
  title = "Add product",
  onPick,
  onClose,
}: {
  title?: string;
  onPick: (p: {
    id: string;
    name: string;
    pricePerUnit: number | string;
    unit?: string;
    unitsPerBox?: number | null;
  }) => void;
  onClose: () => void;
}) {
  const [search, setSearch] = useState("");
  // limit: 0 → all products. Previously this defaulted to the API's 20-row
  // page so suggestion lists "stopped halfway" for any catalogue larger than
  // 20 SKUs. Server-side `search` already narrows the payload.
  const { data, isLoading } = useProducts({
    search: search.trim() || undefined,
    limit: 0,
  });
  const products = (data?.data ?? []) as Array<{
    id: string;
    name: string;
    sku?: string;
    unit?: string;
    unitsPerBox?: number | null;
    pricePerUnit: number | string;
  }>;

  return (
    <>
      <NavBar inlineTitle={title} leading={<NavBackButton label="Cancel" onPress={onClose} />} />
      <SearchBar placeholder="Search products…" value={search} onChangeText={setSearch} />
      <ScrollView showsVerticalScrollIndicator={false}>
        {isLoading ? (
          <View style={styles.center}>
            <ActivityIndicator color={ios.brand} />
          </View>
        ) : products.length === 0 ? (
          <View style={styles.center}>
            <Text style={styles.empty}>No products match.</Text>
          </View>
        ) : (
          <View style={{ paddingHorizontal: 16, gap: 6, paddingBottom: 24 }}>
            {products.map((p) => {
              const upb = Number(p.unitsPerBox ?? 0);
              return (
                <Pressable key={p.id} style={styles.pickRow} onPress={() => onPick(p)}>
                  <View style={{ flex: 1, minWidth: 0 }}>
                    <Text style={styles.cardName} numberOfLines={1}>
                      {p.name}
                    </Text>
                    <Text style={styles.cardMeta}>
                      {p.sku ? `SKU ${p.sku} · ` : ""}${toNumber(p.pricePerUnit).toFixed(2)}
                      {upb > 1 ? ` / box of ${upb}` : p.unit ? ` / ${p.unit}` : ""}
                    </Text>
                  </View>
                  <Ionicons name="add-circle" size={22} color={ios.brand} />
                </Pressable>
              );
            })}
          </View>
        )}
      </ScrollView>
    </>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: ios.bg },
  center: { padding: 40, alignItems: "center" },
  empty: { fontSize: 14, fontFamily: "Inter_400Regular", color: ios.label2 },

  // ── Card ───────────────────────────────────────────────────────────────────
  card: {
    backgroundColor: ios.bgElev,
    borderRadius: 14,
    padding: 14,
    gap: 12,
  },
  cardHeader: {
    flexDirection: "row",
    alignItems: "flex-start",
    gap: 10,
  },
  cardName: {
    fontSize: 15,
    fontFamily: "Inter_600SemiBold",
    color: ios.label,
    letterSpacing: -0.2,
  },
  cardMetaRow: { flexDirection: "row", alignItems: "center", gap: 6, marginTop: 3 },
  cardMeta: {
    fontSize: 12,
    fontFamily: "Inter_400Regular",
    color: ios.label2,
    fontVariant: ["tabular-nums"],
  },
  priceTap: {
    flexDirection: "row",
    alignItems: "center",
    gap: 4,
  },
  priceStrike: {
    fontSize: 11,
    fontFamily: "Inter_400Regular",
    color: ios.label3,
    textDecorationLine: "line-through",
  },
  cardTotal: {
    fontSize: 15,
    fontFamily: "Inter_700Bold",
    color: ios.label,
    fontVariant: ["tabular-nums"],
  },

  // ── Stepper row ───────────────────────────────────────────────────────────
  stepperRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
  },
  stepperLabel: {
    fontSize: 13,
    fontFamily: "Inter_500Medium",
    color: ios.label,
  },
  stepperHint: {
    fontSize: 11,
    fontFamily: "Inter_400Regular",
    color: ios.label3,
    marginTop: 1,
  },
  stepper: {
    flexDirection: "row",
    alignItems: "center",
    backgroundColor: ios.fill3,
    borderRadius: 10,
    padding: 3,
  },
  stepBtn: { width: 30, height: 30, alignItems: "center", justifyContent: "center" },
  stepText: { color: ios.brand, fontSize: 18 },
  qtyInput: {
    minWidth: 44,
    paddingHorizontal: 4,
    textAlign: "center",
    fontSize: 16,
    fontFamily: "Inter_700Bold",
    color: ios.label,
    fontVariant: ["tabular-nums"],
    paddingVertical: 2,
  },

  // ── Card actions ──────────────────────────────────────────────────────────
  cardActions: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    paddingTop: 4,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: ios.separator,
  },
  actionChip: {
    flexDirection: "row",
    alignItems: "center",
    gap: 4,
    backgroundColor: ios.brandWash,
    borderRadius: 8,
    paddingHorizontal: 10,
    paddingVertical: 6,
  },
  actionChipActive: {
    backgroundColor: ios.system.orangeWash,
  },
  actionChipText: {
    fontSize: 12,
    fontFamily: "Inter_600SemiBold",
    color: ios.brand,
  },
  deleteBtn: {
    width: 32,
    height: 32,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: ios.system.redWash,
    borderRadius: 8,
  },

  // ── Add product CTA ───────────────────────────────────────────────────────
  addBtn: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 6,
    backgroundColor: ios.brandWash,
    borderRadius: 12,
    paddingVertical: 14,
    marginTop: 4,
  },
  addBtnText: { color: ios.brand, fontSize: 15, fontFamily: "Inter_600SemiBold" },
  addUnlistedBtn: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 6,
    backgroundColor: ios.brandWash,
    borderRadius: 12,
    paddingVertical: 14,
  },

  // ── Unlisted draft card ──────────────────────────────────────────────────
  unlistedTagRow: { flexDirection: "row", alignItems: "center", gap: 8, marginBottom: 6 },
  customTag: {
    backgroundColor: ios.system.orangeWash,
    borderRadius: 6,
    paddingHorizontal: 8,
    paddingVertical: 2,
  },
  customTagText: {
    fontSize: 11,
    fontFamily: "Inter_600SemiBold",
    color: ios.system.orangeInk,
    letterSpacing: 0.2,
  },
  unlistedNameInput: {
    backgroundColor: ios.fill3,
    borderRadius: 8,
    paddingHorizontal: 10,
    paddingVertical: 8,
    fontSize: 15,
    fontFamily: "Inter_600SemiBold",
    color: ios.label,
  },
  unlistedPriceRow: { flexDirection: "row", alignItems: "center", gap: 4, marginTop: 8 },
  unlistedPriceInput: {
    minWidth: 70,
    paddingHorizontal: 8,
    paddingVertical: 5,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: ios.brand,
    borderRadius: 8,
    textAlign: "right",
    fontSize: 14,
    fontFamily: "Inter_600SemiBold",
    color: ios.brand,
    fontVariant: ["tabular-nums"],
  },

  // ── Product picker rows ───────────────────────────────────────────────────
  pickRow: {
    backgroundColor: ios.bgElev,
    borderRadius: 10,
    padding: 12,
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
  },

  // ── Footer ────────────────────────────────────────────────────────────────
  footer: {
    padding: 16,
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    backgroundColor: ios.bgElev,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: ios.separator,
  },
  footerEyebrow: {
    fontSize: 12,
    fontFamily: "Inter_600SemiBold",
    color: ios.label2,
    letterSpacing: 0.4,
  },
  footerTotal: {
    fontSize: 24,
    fontFamily: "Inter_700Bold",
    color: ios.label,
    fontVariant: ["tabular-nums"],
  },
  saveBtn: {
    backgroundColor: ios.brand,
    borderRadius: 14,
    paddingHorizontal: 20,
    paddingVertical: 14,
  },
  saveBtnDisabled: { opacity: 0.5 },
  saveBtnText: { color: "#fff", fontSize: 15, fontFamily: "Inter_600SemiBold" },

  // ── Price override modal ──────────────────────────────────────────────────
  modalOverlay: {
    flex: 1,
    backgroundColor: "rgba(0,0,0,0.45)",
    alignItems: "center",
    justifyContent: "center",
    padding: 24,
  },
  modalCard: {
    backgroundColor: ios.bgElev,
    borderRadius: 20,
    padding: 20,
    width: "100%",
    maxWidth: 380,
  },
  modalTitle: {
    fontSize: 17,
    fontFamily: "Inter_700Bold",
    color: ios.label,
    letterSpacing: -0.3,
    marginBottom: 2,
  },
  modalSub: {
    fontSize: 14,
    fontFamily: "Inter_400Regular",
    color: ios.label2,
    marginBottom: 8,
  },
  modalLabel: {
    fontSize: 13,
    fontFamily: "Inter_400Regular",
    color: ios.label2,
    marginBottom: 14,
  },
  modalFieldLabel: {
    fontSize: 12,
    fontFamily: "Inter_600SemiBold",
    color: ios.label2,
    letterSpacing: 0.3,
    marginBottom: 6,
  },
  modalInput: {
    backgroundColor: ios.fill3,
    borderRadius: 10,
    paddingHorizontal: 12,
    paddingVertical: 10,
    fontSize: 16,
    fontFamily: "Inter_500Medium",
    color: ios.label,
    marginBottom: 12,
  },
  modalBtns: { flexDirection: "row", gap: 10 },
  modalBtnGhost: {
    flex: 1,
    paddingVertical: 13,
    borderRadius: 12,
    alignItems: "center",
    backgroundColor: ios.fill3,
  },
  modalBtnGhostText: { fontSize: 15, fontFamily: "Inter_600SemiBold", color: ios.label },
  modalBtnFill: {
    flex: 1,
    paddingVertical: 13,
    borderRadius: 12,
    alignItems: "center",
    backgroundColor: ios.brand,
  },
  modalBtnDisabled: { opacity: 0.4 },
  modalBtnFillText: { fontSize: 15, fontFamily: "Inter_600SemiBold", color: "#fff" },
});
