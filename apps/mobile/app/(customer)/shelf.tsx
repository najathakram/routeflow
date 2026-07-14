/**
 * P5-16b: Your Shelf — RN twin of apps/web/app/buyer/portal/[seller]/shelf/page.tsx.
 * Sections: Running low / Due soon / Snoozed / Everything else. Per-row Add
 * (server create/merge — same path as cart) + Snooze/Unsnooze. Header
 * Add-all-low (server-side box splits) + open-order card. NO prices on rows —
 * estimates carry none by design.
 */
import { useState } from "react";
import {
  ActivityIndicator,
  Image,
  Pressable,
  RefreshControl,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { Ionicons } from "@expo/vector-icons";
import { useRouter } from "expo-router";
import { ios } from "@routeflow/ui/tokens";
import { NavBackButton, NavBar, ProgressTrack } from "@routeflow/ui/mobile/ios";
import {
  useBuyerShelf,
  useBuyerCreateOrder,
  useSnoozeReplenishment,
  useUnsnoozeReplenishment,
  useAddAllLow,
  type ShelfEstimate,
} from "../../lib/api/buyer";
import {
  groupShelfEstimates,
  buildShelfAddItem,
  qtyLabel,
  daysLeftFraction,
  daysLeftLabel,
} from "../../lib/shelf-logic";
import { showToast } from "../../lib/toast";

function formatDate(d: string) {
  return new Date(d).toLocaleDateString(undefined, { day: "2-digit", month: "short" });
}

/** Surface a buyer create/add rejection — credit-limit, stock, or regulated-license
 * guards (P5-08b) 4xx with the server message. Mirrors the order-detail sibling. */
function friendlyAddError(e: any): string {
  return (
    e?.response?.data?.message ?? e?.message ?? "Couldn't add to your order. Please try again."
  );
}

const BAR_FILL: Record<ShelfEstimate["state"], "red" | "orange" | "brand"> = {
  low: "red",
  "due-soon": "orange",
  ok: "brand",
};

function ShelfRow({
  e,
  onAdd,
  addPending,
  onSnooze,
  onUnsnooze,
  snoozePending,
}: {
  e: ShelfEstimate;
  onAdd: () => void;
  addPending: boolean;
  onSnooze: () => void;
  onUnsnooze: () => void;
  snoozePending: boolean;
}) {
  const frac = daysLeftFraction(e);
  return (
    <View style={styles.row}>
      {e.imageUrl ? (
        <Image source={{ uri: e.imageUrl }} style={styles.thumb} resizeMode="cover" />
      ) : (
        <View style={[styles.thumb, styles.thumbPlaceholder]}>
          <Ionicons name="cube-outline" size={20} color={ios.label3} />
        </View>
      )}
      <View style={{ flex: 1, minWidth: 0 }}>
        <Text style={styles.name} numberOfLines={2}>
          {e.name}
        </Text>
        <Text style={styles.meta} numberOfLines={1}>
          Last ordered {formatDate(e.lastOrderedAt)}
          {e.cadenceDays != null ? ` · every ~${e.cadenceDays}d` : ""} · {daysLeftLabel(e)}
        </Text>
        {e.snoozed && e.snoozedUntil ? (
          <Text style={styles.snoozedNote}>Snoozed until {formatDate(e.snoozedUntil)}</Text>
        ) : frac != null ? (
          <View style={{ marginTop: 6, maxWidth: 160 }}>
            <ProgressTrack percent={Math.round(frac * 100)} fill={BAR_FILL[e.state]} />
          </View>
        ) : null}
        <Text style={styles.qty}>{qtyLabel(e)}</Text>
      </View>
      <View style={styles.actions}>
        <Pressable style={styles.addBtn} onPress={onAdd} disabled={addPending} hitSlop={8}>
          {addPending ? (
            <ActivityIndicator size="small" color="#fff" />
          ) : (
            <Ionicons name="add" size={18} color="#fff" />
          )}
        </Pressable>
        <Pressable
          style={styles.snoozeBtn}
          onPress={e.snoozed ? onUnsnooze : onSnooze}
          disabled={snoozePending}
          hitSlop={8}
        >
          {snoozePending ? (
            <ActivityIndicator size="small" color={ios.label2} />
          ) : (
            <Ionicons
              name={e.snoozed ? "arrow-undo-outline" : "alarm-outline"}
              size={16}
              color={ios.label2}
            />
          )}
        </Pressable>
      </View>
    </View>
  );
}

function Section({
  title,
  items,
  ...rowProps
}: {
  title: string;
  items: ShelfEstimate[];
  pendingAdd: string | null;
  pendingSnooze: string | null;
  onAdd: (e: ShelfEstimate) => void;
  onSnooze: (e: ShelfEstimate) => void;
  onUnsnooze: (e: ShelfEstimate) => void;
}) {
  if (items.length === 0) return null;
  return (
    <View style={styles.section}>
      <View style={styles.sectionHeaderRow}>
        <Text style={styles.sectionTitle}>{title.toUpperCase()}</Text>
        <View style={styles.countBadge}>
          <Text style={styles.countBadgeText}>{items.length}</Text>
        </View>
      </View>
      <View style={styles.sectionCard}>
        {items.map((e, i) => (
          <View key={e.productId} style={i > 0 ? styles.rowDivider : undefined}>
            <ShelfRow
              e={e}
              onAdd={() => rowProps.onAdd(e)}
              addPending={rowProps.pendingAdd === e.productId}
              onSnooze={() => rowProps.onSnooze(e)}
              onUnsnooze={() => rowProps.onUnsnooze(e)}
              snoozePending={rowProps.pendingSnooze === e.productId}
            />
          </View>
        ))}
      </View>
    </View>
  );
}

export default function BuyerShelfScreen() {
  const router = useRouter();
  const { data: shelf, isLoading, isError, isFetching, refetch } = useBuyerShelf();
  const createOrder = useBuyerCreateOrder();
  const addAllLow = useAddAllLow();
  const snooze = useSnoozeReplenishment();
  const unsnooze = useUnsnoozeReplenishment();

  const [pendingAdd, setPendingAdd] = useState<string | null>(null);
  const [pendingSnooze, setPendingSnooze] = useState<string | null>(null);

  const sections = groupShelfEstimates(shelf?.estimates);
  const total = shelf?.estimates?.length ?? 0;

  const handleAdd = async (e: ShelfEstimate) => {
    if (pendingAdd) return;
    setPendingAdd(e.productId);
    try {
      // Server create/merge into the active order — MONEY: boxed products
      // MUST carry {boxes, pieces:0} or the qty is read as a BOX count.
      await createOrder.mutateAsync({ items: [buildShelfAddItem(e)] });
    } catch (err) {
      showToast(friendlyAddError(err));
    } finally {
      setPendingAdd(null);
    }
  };

  const handleSnooze = async (e: ShelfEstimate) => {
    if (pendingSnooze) return;
    setPendingSnooze(e.productId);
    try {
      if (e.snoozed) await unsnooze.mutateAsync(e.productId);
      else await snooze.mutateAsync(e.productId);
    } finally {
      setPendingSnooze(null);
    }
  };

  return (
    <SafeAreaView style={styles.safe} edges={["top", "left", "right"]}>
      <NavBar
        inlineTitle="Your Shelf"
        leading={<NavBackButton label="Back" onPress={() => router.back()} />}
      />
      <ScrollView
        showsVerticalScrollIndicator={false}
        contentContainerStyle={{ padding: 16, paddingBottom: 40 }}
        refreshControl={
          <RefreshControl refreshing={isFetching && !isLoading} onRefresh={refetch} />
        }
      >
        {isLoading ? (
          <View style={styles.center}>
            <ActivityIndicator color={ios.brand} />
          </View>
        ) : isError ? (
          <View style={styles.center}>
            <Text style={styles.errorText}>Failed to load your shelf. Please try again.</Text>
          </View>
        ) : (
          <>
            {shelf?.activeOrder ? (
              <Pressable
                style={styles.orderCard}
                onPress={() => router.push(`/(customer)/orders/${shelf.activeOrder!.id}`)}
              >
                <View style={{ flex: 1 }}>
                  <Text style={styles.orderCardTitle}>
                    Open order{" "}
                    {shelf.activeOrder.orderNumber ?? `#${shelf.activeOrder.id.slice(0, 8)}`}
                  </Text>
                  <Text style={styles.orderCardMeta}>
                    {shelf.activeOrder.itemCount}{" "}
                    {shelf.activeOrder.itemCount === 1 ? "item" : "items"}
                    {" · "}${Number(shelf.activeOrder.total ?? 0).toFixed(2)}
                  </Text>
                </View>
                <Ionicons name="arrow-forward" size={18} color={ios.brand} />
              </Pressable>
            ) : null}

            <Pressable
              style={[
                styles.addAllBtn,
                (addAllLow.isPending || sections.low.length === 0) && styles.addAllBtnDisabled,
              ]}
              onPress={() =>
                addAllLow.mutate(undefined, {
                  onError: (err) => showToast(friendlyAddError(err)),
                })
              }
              disabled={addAllLow.isPending || sections.low.length === 0}
            >
              {addAllLow.isPending ? (
                <ActivityIndicator size="small" color="#fff" />
              ) : (
                <Ionicons name="cart-outline" size={16} color="#fff" />
              )}
              <Text style={styles.addAllText}>
                Add all low to cart{sections.low.length > 0 ? ` (${sections.low.length})` : ""}
              </Text>
            </Pressable>

            {total === 0 ? (
              <View style={styles.center}>
                <Ionicons name="cube-outline" size={44} color={ios.label3} />
                <Text style={styles.empty}>Nothing on your shelf yet</Text>
                <Text style={styles.emptySub}>
                  Once you&apos;ve placed a few orders, we&apos;ll learn what you usually reorder
                  and when.
                </Text>
                <Pressable
                  style={styles.browseBtn}
                  onPress={() => router.push("/(customer)/(tabs)/catalog")}
                >
                  <Text style={styles.browseText}>Browse catalog</Text>
                </Pressable>
              </View>
            ) : (
              <>
                <Section
                  title="Running low"
                  items={sections.low}
                  pendingAdd={pendingAdd}
                  pendingSnooze={pendingSnooze}
                  onAdd={handleAdd}
                  onSnooze={handleSnooze}
                  onUnsnooze={handleSnooze}
                />
                <Section
                  title="Due soon"
                  items={sections.dueSoon}
                  pendingAdd={pendingAdd}
                  pendingSnooze={pendingSnooze}
                  onAdd={handleAdd}
                  onSnooze={handleSnooze}
                  onUnsnooze={handleSnooze}
                />
                <Section
                  title="Snoozed"
                  items={sections.snoozed}
                  pendingAdd={pendingAdd}
                  pendingSnooze={pendingSnooze}
                  onAdd={handleAdd}
                  onSnooze={handleSnooze}
                  onUnsnooze={handleSnooze}
                />
                <Section
                  title="Everything else"
                  items={sections.rest}
                  pendingAdd={pendingAdd}
                  pendingSnooze={pendingSnooze}
                  onAdd={handleAdd}
                  onSnooze={handleSnooze}
                  onUnsnooze={handleSnooze}
                />
              </>
            )}
          </>
        )}
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: ios.bg },
  center: { padding: 48, alignItems: "center", gap: 8 },
  errorText: { fontSize: 14, fontFamily: "Inter_400Regular", color: ios.system.redInk },
  empty: { fontSize: 16, fontFamily: "Inter_600SemiBold", color: ios.label, marginTop: 4 },
  emptySub: {
    fontSize: 13,
    fontFamily: "Inter_400Regular",
    color: ios.label2,
    textAlign: "center",
  },
  browseBtn: {
    backgroundColor: ios.brand,
    borderRadius: 12,
    paddingHorizontal: 20,
    paddingVertical: 10,
    marginTop: 8,
  },
  browseText: { color: "#fff", fontSize: 14, fontFamily: "Inter_600SemiBold" },
  orderCard: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    backgroundColor: ios.brandWash,
    borderRadius: 14,
    padding: 14,
    marginBottom: 12,
  },
  orderCardTitle: { fontSize: 13, fontFamily: "Inter_600SemiBold", color: ios.label },
  orderCardMeta: { fontSize: 12, fontFamily: "Inter_400Regular", color: ios.label2, marginTop: 2 },
  addAllBtn: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 8,
    backgroundColor: ios.brand,
    borderRadius: 14,
    paddingVertical: 13,
    marginBottom: 16,
  },
  addAllBtnDisabled: { opacity: 0.5 },
  addAllText: { color: "#fff", fontSize: 14, fontFamily: "Inter_600SemiBold" },
  section: { marginBottom: 16 },
  sectionHeaderRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    marginBottom: 8,
    paddingLeft: 4,
  },
  sectionTitle: {
    fontSize: 12,
    fontFamily: "Inter_600SemiBold",
    color: ios.label2,
    letterSpacing: 0.6,
  },
  countBadge: {
    backgroundColor: ios.fill3,
    borderRadius: 10,
    minWidth: 18,
    paddingHorizontal: 5,
    alignItems: "center",
  },
  countBadgeText: { fontSize: 10, fontFamily: "Inter_700Bold", color: ios.label2 },
  sectionCard: { backgroundColor: ios.bgElev, borderRadius: 14, overflow: "hidden" },
  rowDivider: {
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: ios.separator,
  },
  row: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    padding: 12,
  },
  thumb: { width: 44, height: 44, borderRadius: 10 },
  thumbPlaceholder: {
    backgroundColor: ios.fill3,
    alignItems: "center",
    justifyContent: "center",
  },
  name: { fontSize: 14, fontFamily: "Inter_600SemiBold", color: ios.label },
  meta: { fontSize: 11, fontFamily: "Inter_400Regular", color: ios.label2, marginTop: 2 },
  snoozedNote: { fontSize: 11, fontFamily: "Inter_400Regular", color: ios.label3, marginTop: 4 },
  qty: { fontSize: 11, fontFamily: "Inter_500Medium", color: ios.label2, marginTop: 4 },
  actions: { flexDirection: "column", gap: 6, alignItems: "center" },
  addBtn: {
    width: 32,
    height: 32,
    borderRadius: 9,
    backgroundColor: ios.brand,
    alignItems: "center",
    justifyContent: "center",
  },
  snoozeBtn: {
    width: 32,
    height: 32,
    borderRadius: 9,
    backgroundColor: ios.fill3,
    alignItems: "center",
    justifyContent: "center",
  },
});
