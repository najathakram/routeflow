import { useState } from "react";
import {
  Alert,
  Keyboard,
  KeyboardAvoidingView,
  Linking,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import { router, Stack, useLocalSearchParams } from "expo-router";
import { Ionicons } from "@expo/vector-icons";
import { colors, borderRadius, shadows } from "@routeflow/ui/tokens";
import {
  useRouteStore,
  selectAllItemsResolved,
  selectStopResolutions,
  type ItemDeliveryStatus,
} from "../../../../../store/routeStore";
import { StopItem } from "../../../../../data/driverMockData";

// ─── Open Maps ────────────────────────────────────────────────────────────────

function openMaps(query: string) {
  const encoded = encodeURIComponent(query);
  const url = Platform.select({
    ios: `maps://maps.apple.com/?q=${encoded}`,
    android: `geo:0,0?q=${encoded}`,
    default: `https://maps.google.com/?q=${encoded}`,
  })!;
  Linking.openURL(url).catch(() =>
    Alert.alert("Could not open Maps", "Please open your maps app manually."),
  );
}

// ─── Item Status Selector ─────────────────────────────────────────────────────

const STATUSES: { key: ItemDeliveryStatus; label: string; color: string; bg: string }[] = [
  { key: "DELIVERED", label: "Delivered", color: colors.success.DEFAULT, bg: colors.success.bg },
  { key: "PARTIAL", label: "Partial", color: colors.warning.DEFAULT, bg: colors.warning.bg },
  { key: "REFUSED", label: "Refused", color: colors.danger.DEFAULT, bg: colors.danger.bg },
];

function ItemRow({
  item,
  stopId,
}: {
  item: StopItem & { isAdded?: boolean };
  stopId: string;
}) {
  const resolution = useRouteStore((s) => selectStopResolutions(s, stopId)[item.id]);
  const setItemResolution = useRouteStore((s) => s.setItemResolution);
  const current = resolution?.status ?? "UNRESOLVED";
  const [partialInput, setPartialInput] = useState(
    resolution?.partialQty?.toString() ?? "",
  );

  const handleSelect = (key: ItemDeliveryStatus) => {
    if (key === "PARTIAL") {
      setItemResolution(stopId, item.id, {
        status: "PARTIAL",
        partialQty: parseInt(partialInput || "0", 10) || 0,
      });
    } else {
      setItemResolution(stopId, item.id, { status: key });
    }
  };

  return (
    <View style={itemStyles.container}>
      <View style={itemStyles.header}>
        <Text style={itemStyles.name}>{item.name}</Text>
        <Text style={itemStyles.qty}>
          Ordered: <Text style={itemStyles.qtyBold}>{item.orderedQty}</Text>
          {!item.isAdded ? ` × ${item.unit}` : ""}
        </Text>
      </View>

      {/* Three large toggle buttons */}
      <View style={itemStyles.toggleRow}>
        {STATUSES.map(({ key, label, color, bg }) => {
          const selected = current === key;
          return (
            <Pressable
              key={key}
              style={[
                itemStyles.toggleBtn,
                selected && { backgroundColor: bg, borderColor: color },
              ]}
              onPress={() => handleSelect(key)}
              accessibilityRole="button"
              accessibilityLabel={`Mark ${item.name} as ${label}`}
              accessibilityState={{ selected }}
            >
              <Text
                style={[
                  itemStyles.toggleText,
                  selected && { color },
                ]}
              >
                {label}
              </Text>
            </Pressable>
          );
        })}
      </View>

      {/* Partial qty input */}
      {current === "PARTIAL" && (
        <View style={itemStyles.partialRow}>
          <Text style={itemStyles.partialLabel}>Qty delivered:</Text>
          <TextInput
            style={itemStyles.partialInput}
            keyboardType="number-pad"
            value={partialInput}
            onChangeText={(v) => {
              setPartialInput(v);
              const n = parseInt(v, 10);
              if (!isNaN(n)) {
                setItemResolution(stopId, item.id, {
                  status: "PARTIAL",
                  partialQty: n,
                });
              }
            }}
            placeholder="0"
            maxLength={3}
            returnKeyType="done"
            onSubmitEditing={Keyboard.dismiss}
          />
          <Text style={itemStyles.partialMax}>/ {item.orderedQty}</Text>
        </View>
      )}
    </View>
  );
}

const itemStyles = StyleSheet.create({
  container: {
    backgroundColor: "#fff",
    borderRadius: borderRadius.lg,
    padding: 16,
    gap: 12,
    ...shadows.card,
  },
  header: {
    gap: 2,
  },
  name: {
    fontSize: 18,
    fontFamily: "Inter_700Bold",
    color: colors.navy.DEFAULT,
  },
  qty: {
    fontSize: 15,
    fontFamily: "Inter_400Regular",
    color: "#64748b",
  },
  qtyBold: {
    fontFamily: "Inter_700Bold",
    color: colors.navy.DEFAULT,
  },
  toggleRow: {
    flexDirection: "row",
    gap: 8,
  },
  toggleBtn: {
    flex: 1,
    height: 56,
    borderRadius: borderRadius.DEFAULT,
    borderWidth: 1.5,
    borderColor: colors.surface.border,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: colors.surface.raised,
  },
  toggleText: {
    fontSize: 14,
    fontFamily: "Inter_700Bold",
    color: "#64748b",
  },
  partialRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    paddingTop: 4,
  },
  partialLabel: {
    fontSize: 15,
    fontFamily: "Inter_500Medium",
    color: colors.navy.DEFAULT,
  },
  partialInput: {
    width: 72,
    height: 48,
    borderWidth: 1.5,
    borderColor: colors.warning.DEFAULT,
    borderRadius: borderRadius.DEFAULT,
    textAlign: "center",
    fontSize: 20,
    fontFamily: "Inter_700Bold",
    color: colors.navy.DEFAULT,
    backgroundColor: colors.warning.bg,
  },
  partialMax: {
    fontSize: 15,
    fontFamily: "Inter_400Regular",
    color: "#64748b",
  },
});

// ─── Add Item Inline Form ─────────────────────────────────────────────────────

function AddItemForm({
  stopId,
  onDone,
}: {
  stopId: string;
  onDone: () => void;
}) {
  const addStopItem = useRouteStore((s) => s.addStopItem);
  const [name, setName] = useState("");
  const [qty, setQty] = useState("1");

  const handleAdd = () => {
    const n = parseInt(qty, 10);
    if (!name.trim() || isNaN(n) || n <= 0) return;
    addStopItem(stopId, name.trim(), n);
    setName("");
    setQty("1");
    onDone();
    Keyboard.dismiss();
  };

  return (
    <View style={addStyles.container}>
      <Text style={addStyles.title}>Add Item</Text>
      <TextInput
        style={addStyles.nameInput}
        placeholder="Item name"
        placeholderTextColor="#94a3b8"
        value={name}
        onChangeText={setName}
        autoFocus
        returnKeyType="next"
      />
      <View style={addStyles.row}>
        <TextInput
          style={addStyles.qtyInput}
          placeholder="Qty"
          placeholderTextColor="#94a3b8"
          value={qty}
          onChangeText={setQty}
          keyboardType="number-pad"
          returnKeyType="done"
        />
        <Pressable style={addStyles.addBtn} onPress={handleAdd}>
          <Text style={addStyles.addBtnText}>Add</Text>
        </Pressable>
        <Pressable style={addStyles.cancelBtn} onPress={onDone}>
          <Text style={addStyles.cancelBtnText}>Cancel</Text>
        </Pressable>
      </View>
    </View>
  );
}

const addStyles = StyleSheet.create({
  container: {
    backgroundColor: colors.brand[50],
    borderRadius: borderRadius.lg,
    padding: 16,
    gap: 10,
    borderWidth: 1,
    borderColor: colors.brand[100],
  },
  title: {
    fontSize: 15,
    fontFamily: "Inter_600SemiBold",
    color: colors.navy.DEFAULT,
  },
  nameInput: {
    height: 48,
    borderWidth: 1,
    borderColor: colors.surface.border,
    borderRadius: borderRadius.DEFAULT,
    paddingHorizontal: 12,
    fontSize: 16,
    fontFamily: "Inter_400Regular",
    color: colors.navy.DEFAULT,
    backgroundColor: "#fff",
  },
  row: {
    flexDirection: "row",
    gap: 8,
  },
  qtyInput: {
    width: 72,
    height: 48,
    borderWidth: 1,
    borderColor: colors.surface.border,
    borderRadius: borderRadius.DEFAULT,
    textAlign: "center",
    fontSize: 17,
    fontFamily: "Inter_600SemiBold",
    color: colors.navy.DEFAULT,
    backgroundColor: "#fff",
  },
  addBtn: {
    flex: 1,
    height: 48,
    backgroundColor: colors.brand[500],
    borderRadius: borderRadius.DEFAULT,
    alignItems: "center",
    justifyContent: "center",
  },
  addBtnText: {
    fontSize: 15,
    fontFamily: "Inter_700Bold",
    color: "#fff",
  },
  cancelBtn: {
    flex: 1,
    height: 48,
    backgroundColor: "#fff",
    borderRadius: borderRadius.DEFAULT,
    alignItems: "center",
    justifyContent: "center",
    borderWidth: 1,
    borderColor: colors.surface.border,
  },
  cancelBtnText: {
    fontSize: 15,
    fontFamily: "Inter_600SemiBold",
    color: "#64748b",
  },
});

// ─── Main Screen ──────────────────────────────────────────────────────────────

export default function StopDetailScreen() {
  const { stopId } = useLocalSearchParams<{ stopId: string }>();
  const route = useRouteStore((s) => s.route);
  const stopNote = useRouteStore((s) => s.stopNotes[stopId] ?? "");
  const setStopNote = useRouteStore((s) => s.setStopNote);
  const addedItems = useRouteStore((s) => s.addedItems[stopId]) ?? [];
  const allResolved = useRouteStore((s) => selectAllItemsResolved(s, stopId));
  const [showAddForm, setShowAddForm] = useState(false);

  const stop = route.stops.find((s) => s.id === stopId);
  if (!stop) {
    return (
      <View style={styles.notFound}>
        <Text style={styles.notFoundText}>Stop not found.</Text>
      </View>
    );
  }

  const totalStops = route.stops.length;

  return (
    <>
      <Stack.Screen
        options={{
          title: `Stop ${stop.stopNumber} of ${totalStops}`,
          headerBackTitle: "Route",
        }}
      />
      <KeyboardAvoidingView
        style={{ flex: 1 }}
        behavior={Platform.OS === "ios" ? "padding" : undefined}
        keyboardVerticalOffset={88}
      >
        <View style={styles.container}>
          <ScrollView
            contentContainerStyle={styles.scroll}
            showsVerticalScrollIndicator={false}
            keyboardShouldPersistTaps="handled"
          >
            {/* Business name + stop count */}
            <View style={styles.stopHeader}>
              <Text style={styles.businessName}>{stop.businessName}</Text>
              <Text style={styles.stopMeta}>
                Stop {stop.stopNumber} of {totalStops} ·{" "}
                {stop.items.length + addedItems.length} item
                {stop.items.length + addedItems.length !== 1 ? "s" : ""}
              </Text>
            </View>

            {/* Address + Navigate */}
            <View style={styles.addressCard}>
              <View style={styles.addressLeft}>
                <Ionicons name="location-outline" size={20} color={colors.brand[500]} />
                <Text style={styles.addressText}>{stop.address}</Text>
              </View>
              <Pressable
                style={styles.navigateBtn}
                onPress={() => openMaps(stop.mapsQuery)}
                accessibilityRole="button"
                accessibilityLabel="Open in Maps"
              >
                <Ionicons name="navigate" size={18} color="#fff" />
                <Text style={styles.navigateBtnText}>Navigate</Text>
              </Pressable>
            </View>

            {/* Items section */}
            <Text style={styles.sectionTitle}>Order Items</Text>
            <View style={styles.itemsList}>
              {stop.items.map((item) => (
                <ItemRow key={item.id} item={item} stopId={stopId} />
              ))}

              {/* Added items */}
              {addedItems.map((item) => (
                <ItemRow
                  key={item.id}
                  item={{
                    id: item.id,
                    name: item.name,
                    unit: "",
                    orderedQty: item.qty,
                    isAdded: true,
                  }}
                  stopId={stopId}
                />
              ))}

              {/* Add item button or form */}
              {showAddForm ? (
                <AddItemForm
                  stopId={stopId}
                  onDone={() => setShowAddForm(false)}
                />
              ) : (
                <Pressable
                  style={styles.addItemBtn}
                  onPress={() => setShowAddForm(true)}
                  accessibilityRole="button"
                >
                  <Ionicons name="add-circle-outline" size={22} color={colors.brand[500]} />
                  <Text style={styles.addItemText}>Add item not on order</Text>
                </Pressable>
              )}
            </View>

            {/* Driver notes */}
            <Text style={styles.sectionTitle}>Driver Notes</Text>
            <TextInput
              style={styles.notesInput}
              placeholder="Add a note about this stop…"
              placeholderTextColor="#94a3b8"
              value={stopNote}
              onChangeText={(v) => setStopNote(stopId, v)}
              multiline
              numberOfLines={3}
              textAlignVertical="top"
            />
          </ScrollView>

          {/* Complete Stop — primary action */}
          <View style={styles.footer}>
            {!allResolved && (
              <Text style={styles.resolveHint}>
                Resolve all items above to continue
              </Text>
            )}
            <Pressable
              style={[styles.completeBtn, allResolved && styles.completeBtnReady]}
              onPress={() =>
                allResolved
                  ? router.push(`/(driver)/route/stop/${stopId}/complete`)
                  : null
              }
              accessibilityRole="button"
              accessibilityLabel="Complete Stop"
            >
              <Ionicons
                name={allResolved ? "checkmark-circle" : "ellipse-outline"}
                size={22}
                color={allResolved ? "#fff" : "#94a3b8"}
                style={{ marginRight: 10 }}
              />
              <Text
                style={[
                  styles.completeBtnText,
                  allResolved && styles.completeBtnTextReady,
                ]}
              >
                Complete Stop
              </Text>
            </Pressable>
          </View>
        </View>
      </KeyboardAvoidingView>
    </>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: colors.surface.raised,
  },
  scroll: {
    paddingHorizontal: 16,
    paddingTop: 16,
    paddingBottom: 24,
    gap: 12,
  },
  stopHeader: {
    gap: 4,
  },
  businessName: {
    fontSize: 24,
    fontFamily: "Inter_700Bold",
    color: colors.navy.DEFAULT,
  },
  stopMeta: {
    fontSize: 15,
    fontFamily: "Inter_400Regular",
    color: "#64748b",
  },
  addressCard: {
    backgroundColor: "#fff",
    borderRadius: borderRadius.lg,
    padding: 14,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: 12,
    ...shadows.card,
  },
  addressLeft: {
    flex: 1,
    flexDirection: "row",
    alignItems: "flex-start",
    gap: 8,
  },
  addressText: {
    flex: 1,
    fontSize: 16,
    fontFamily: "Inter_500Medium",
    color: colors.navy.DEFAULT,
    lineHeight: 22,
  },
  navigateBtn: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    backgroundColor: colors.brand[500],
    paddingHorizontal: 14,
    paddingVertical: 10,
    borderRadius: borderRadius.DEFAULT,
    minHeight: 56,
  },
  navigateBtnText: {
    fontSize: 15,
    fontFamily: "Inter_700Bold",
    color: "#fff",
  },
  sectionTitle: {
    fontSize: 13,
    fontFamily: "Inter_600SemiBold",
    color: "#94a3b8",
    textTransform: "uppercase",
    letterSpacing: 0.6,
    marginTop: 4,
  },
  itemsList: {
    gap: 10,
  },
  addItemBtn: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    paddingVertical: 16,
    paddingHorizontal: 16,
    borderRadius: borderRadius.lg,
    borderWidth: 1.5,
    borderStyle: "dashed",
    borderColor: colors.brand[500],
    backgroundColor: colors.brand[50],
    minHeight: 56,
    justifyContent: "center",
  },
  addItemText: {
    fontSize: 16,
    fontFamily: "Inter_600SemiBold",
    color: colors.brand[500],
  },
  notesInput: {
    borderWidth: 1,
    borderColor: colors.surface.border,
    borderRadius: borderRadius.lg,
    padding: 14,
    fontSize: 16,
    fontFamily: "Inter_400Regular",
    color: colors.navy.DEFAULT,
    minHeight: 96,
    backgroundColor: "#fff",
    textAlignVertical: "top",
  },
  footer: {
    paddingHorizontal: 16,
    paddingBottom: 28,
    paddingTop: 10,
    backgroundColor: "#fff",
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: colors.surface.border,
    gap: 8,
  },
  resolveHint: {
    textAlign: "center",
    fontSize: 13,
    fontFamily: "Inter_400Regular",
    color: "#94a3b8",
  },
  completeBtn: {
    height: 56,
    borderRadius: borderRadius.DEFAULT,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: colors.surface.border,
  },
  completeBtnReady: {
    backgroundColor: colors.success.DEFAULT,
  },
  completeBtnText: {
    fontSize: 17,
    fontFamily: "Inter_700Bold",
    color: "#94a3b8",
  },
  completeBtnTextReady: {
    color: "#fff",
  },
  notFound: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
  },
  notFoundText: {
    fontSize: 16,
    fontFamily: "Inter_400Regular",
    color: "#94a3b8",
  },
});
