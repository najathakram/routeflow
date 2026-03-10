import {
  ActivityIndicator,
  Pressable,
  ScrollView,
  StyleSheet,
  Switch,
  Text,
  TextInput,
  View,
} from "react-native";
import { router, Stack } from "expo-router";
import { Ionicons } from "@expo/vector-icons";
import { EmptyState } from "@routeflow/ui/mobile";
import { colors, borderRadius, shadows } from "@routeflow/ui/tokens";
import { useOrderStore } from "../../../store/orderStore";
import { useMyOrders } from "../../../lib/api/orders";

function QtyStepper({
  value,
  onDecrease,
  onIncrease,
}: {
  value: number;
  onDecrease: () => void;
  onIncrease: () => void;
}) {
  return (
    <View style={stepperStyles.row}>
      <Pressable
        onPress={onDecrease}
        style={stepperStyles.btn}
        hitSlop={6}
      >
        <Text style={stepperStyles.btnText}>−</Text>
      </Pressable>
      <Text style={stepperStyles.count}>{value}</Text>
      <Pressable onPress={onIncrease} style={stepperStyles.btn} hitSlop={6}>
        <Text style={stepperStyles.btnText}>+</Text>
      </Pressable>
    </View>
  );
}

const stepperStyles = StyleSheet.create({
  row: { flexDirection: "row", alignItems: "center", gap: 10 },
  btn: {
    width: 28,
    height: 28,
    borderRadius: 14,
    borderWidth: 1,
    borderColor: colors.surface.border,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: "#fff",
  },
  btnText: {
    fontSize: 16,
    lineHeight: 20,
    color: colors.navy.DEFAULT,
    fontFamily: "Inter_600SemiBold",
  },
  count: {
    fontSize: 15,
    fontFamily: "Inter_600SemiBold",
    color: colors.navy.DEFAULT,
    minWidth: 20,
    textAlign: "center",
  },
});

export default function OrderScreen() {
  const { items, isUrgent, notes, removeItem, updateQuantity, setUrgent, setNotes } =
    useOrderStore();

  // Fetch pending orders from the API so the server state is always in sync
  const { data: pendingOrdersData, isLoading: pendingLoading } = useMyOrders({ status: "PENDING" });
  const pendingOrders = pendingOrdersData?.data ?? [];

  const total = items.reduce((sum, item) => sum + item.unitPrice * item.quantity, 0);
  const itemCount = items.reduce((sum, item) => sum + item.quantity, 0);

  if (items.length === 0) {
    return (
      <>
        <Stack.Screen options={{ title: "My Order" }} />
        {pendingLoading ? (
          <View style={styles.loadingContainer}>
            <ActivityIndicator size="large" color={colors.brand[500]} />
          </View>
        ) : pendingOrders.length > 0 ? (
          // Show the first pending order from the server
          <View style={styles.container}>
            <ScrollView contentContainerStyle={styles.scroll} showsVerticalScrollIndicator={false}>
              <View style={styles.section}>
                <Text style={styles.sectionTitle}>Pending Order</Text>
                {pendingOrders[0].lineItems.map((item) => (
                  <View key={item.id} style={styles.lineItem}>
                    <View style={styles.lineItemLeft}>
                      <Text style={styles.lineItemName}>{item.product?.name ?? item.productId}</Text>
                      <Text style={styles.lineItemUnit}>{item.product?.unit ?? ""}</Text>
                      <Text style={styles.lineItemPrice}>
                        ${Number(item.unitPrice).toFixed(2)} each
                      </Text>
                    </View>
                    <View style={styles.lineItemRight}>
                      <Text style={styles.lineItemSubtotal}>
                        ${(item.qty * Number(item.unitPrice)).toFixed(2)}
                      </Text>
                      <Text style={styles.qtyLabel}>Qty: {item.qty}</Text>
                    </View>
                  </View>
                ))}
              </View>
              <View style={[styles.section, styles.totalsSection]}>
                <Text style={styles.sectionTitle}>Order Summary</Text>
                <View style={styles.totalRow}>
                  <Text style={styles.totalLabel}>Total</Text>
                  <Text style={styles.grandValue}>${Number(pendingOrders[0].total).toFixed(2)}</Text>
                </View>
              </View>
            </ScrollView>
          </View>
        ) : (
          <EmptyState
            icon={<Ionicons name="clipboard-outline" size={56} color="#cbd5e1" />}
            title="Your order is empty"
            subtitle="Browse the shop and add items to build your order."
            actionLabel="Start Shopping"
            onActionPress={() => router.push("/(customer)/shop")}
          />
        )}
      </>
    );
  }

  return (
    <>
      <Stack.Screen options={{ title: "My Order" }} />
      <View style={styles.container}>
        {/* Urgent banner */}
        {isUrgent ? (
          <View style={styles.urgentBanner}>
            <Ionicons name="alert-circle" size={16} color={colors.danger.DEFAULT} />
            <Text style={styles.urgentBannerText}>
              Marked as Urgent — this order will be prioritised.
            </Text>
          </View>
        ) : null}

        <ScrollView
          contentContainerStyle={styles.scroll}
          showsVerticalScrollIndicator={false}
        >
          {/* Urgent toggle */}
          <View style={styles.urgentToggleRow}>
            <View style={styles.urgentLabel}>
              <Ionicons
                name="flash-outline"
                size={18}
                color={isUrgent ? colors.danger.DEFAULT : "#64748b"}
              />
              <Text
                style={[
                  styles.urgentText,
                  isUrgent && { color: colors.danger.DEFAULT },
                ]}
              >
                Mark as Urgent
              </Text>
            </View>
            <Switch
              value={isUrgent}
              onValueChange={setUrgent}
              trackColor={{
                false: colors.surface.border,
                true: colors.danger.DEFAULT,
              }}
              thumbColor="#fff"
            />
          </View>

          {/* Line items */}
          <View style={styles.section}>
            <Text style={styles.sectionTitle}>
              Items ({itemCount})
            </Text>
            {items.map((item) => (
              <View key={item.productId} style={styles.lineItem}>
                <View style={styles.lineItemLeft}>
                  <Text style={styles.lineItemName}>{item.name}</Text>
                  <Text style={styles.lineItemUnit}>{item.unit}</Text>
                  <Text style={styles.lineItemPrice}>
                    ${item.unitPrice.toFixed(2)} each
                  </Text>
                </View>
                <View style={styles.lineItemRight}>
                  <Pressable
                    onPress={() => removeItem(item.productId)}
                    hitSlop={8}
                    style={styles.removeBtn}
                  >
                    <Ionicons
                      name="trash-outline"
                      size={16}
                      color={colors.danger.DEFAULT}
                    />
                  </Pressable>
                  <QtyStepper
                    value={item.quantity}
                    onDecrease={() =>
                      updateQuantity(item.productId, item.quantity - 1)
                    }
                    onIncrease={() =>
                      updateQuantity(item.productId, item.quantity + 1)
                    }
                  />
                  <Text style={styles.lineItemSubtotal}>
                    ${(item.unitPrice * item.quantity).toFixed(2)}
                  </Text>
                </View>
              </View>
            ))}
          </View>

          {/* Order notes */}
          <View style={styles.section}>
            <Text style={styles.sectionTitle}>Order Notes</Text>
            <TextInput
              style={styles.notesInput}
              placeholder="Add a note for your driver or admin…"
              placeholderTextColor="#94a3b8"
              value={notes}
              onChangeText={setNotes}
              multiline
              numberOfLines={3}
              textAlignVertical="top"
            />
          </View>

          {/* Totals */}
          <View style={[styles.section, styles.totalsSection]}>
            <Text style={styles.sectionTitle}>Order Summary</Text>
            <View style={styles.totalRow}>
              <Text style={styles.totalLabel}>Subtotal</Text>
              <Text style={styles.totalValue}>${total.toFixed(2)}</Text>
            </View>
            <View style={styles.totalRow}>
              <Text style={styles.totalLabel}>Items</Text>
              <Text style={styles.totalValue}>{itemCount}</Text>
            </View>
            <View style={[styles.totalRow, styles.totalGrandRow]}>
              <Text style={styles.grandLabel}>Total</Text>
              <Text style={styles.grandValue}>${total.toFixed(2)}</Text>
            </View>
            <Text style={styles.rollingNote}>
              This is a rolling order — items can be added or removed any time
              before dispatch.
            </Text>
          </View>
        </ScrollView>
      </View>
    </>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: colors.surface.raised,
  },
  loadingContainer: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
  },
  urgentBanner: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    backgroundColor: colors.danger.bg,
    paddingHorizontal: 16,
    paddingVertical: 10,
    borderBottomWidth: 1,
    borderBottomColor: "#fca5a5",
  },
  urgentBannerText: {
    fontSize: 13,
    fontFamily: "Inter_600SemiBold",
    color: colors.danger.DEFAULT,
    flex: 1,
  },
  scroll: {
    paddingBottom: 32,
  },
  urgentToggleRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    backgroundColor: "#fff",
    paddingHorizontal: 16,
    paddingVertical: 14,
    marginBottom: 8,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.surface.border,
  },
  urgentLabel: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
  },
  urgentText: {
    fontSize: 15,
    fontFamily: "Inter_500Medium",
    color: "#64748b",
  },
  section: {
    backgroundColor: "#fff",
    marginBottom: 8,
    paddingHorizontal: 16,
    paddingVertical: 16,
  },
  sectionTitle: {
    fontSize: 13,
    fontFamily: "Inter_600SemiBold",
    color: "#64748b",
    textTransform: "uppercase",
    letterSpacing: 0.5,
    marginBottom: 12,
  },
  lineItem: {
    flexDirection: "row",
    alignItems: "flex-start",
    justifyContent: "space-between",
    paddingVertical: 12,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.surface.border,
  },
  lineItemLeft: {
    flex: 1,
    paddingRight: 12,
  },
  lineItemName: {
    fontSize: 15,
    fontFamily: "Inter_600SemiBold",
    color: colors.navy.DEFAULT,
    marginBottom: 2,
  },
  lineItemUnit: {
    fontSize: 12,
    fontFamily: "Inter_400Regular",
    color: "#94a3b8",
    marginBottom: 4,
  },
  lineItemPrice: {
    fontSize: 13,
    fontFamily: "Inter_400Regular",
    color: "#64748b",
  },
  lineItemRight: {
    alignItems: "flex-end",
    gap: 8,
  },
  removeBtn: {
    padding: 4,
  },
  lineItemSubtotal: {
    fontSize: 15,
    fontFamily: "Inter_700Bold",
    color: colors.navy.DEFAULT,
  },
  qtyLabel: {
    fontSize: 13,
    fontFamily: "Inter_400Regular",
    color: "#64748b",
  },
  notesInput: {
    borderWidth: 1,
    borderColor: colors.surface.border,
    borderRadius: borderRadius.DEFAULT,
    padding: 12,
    fontSize: 14,
    fontFamily: "Inter_400Regular",
    color: colors.navy.DEFAULT,
    minHeight: 80,
    backgroundColor: colors.surface.raised,
  },
  totalsSection: {
    ...shadows.card,
  },
  totalRow: {
    flexDirection: "row",
    justifyContent: "space-between",
    paddingVertical: 6,
  },
  totalLabel: {
    fontSize: 14,
    fontFamily: "Inter_400Regular",
    color: "#64748b",
  },
  totalValue: {
    fontSize: 14,
    fontFamily: "Inter_500Medium",
    color: colors.navy.DEFAULT,
  },
  totalGrandRow: {
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: colors.surface.border,
    marginTop: 8,
    paddingTop: 12,
  },
  grandLabel: {
    fontSize: 16,
    fontFamily: "Inter_700Bold",
    color: colors.navy.DEFAULT,
  },
  grandValue: {
    fontSize: 18,
    fontFamily: "Inter_700Bold",
    color: colors.brand[700],
  },
  rollingNote: {
    fontSize: 12,
    fontFamily: "Inter_400Regular",
    color: "#94a3b8",
    marginTop: 12,
    fontStyle: "italic",
  },
});
