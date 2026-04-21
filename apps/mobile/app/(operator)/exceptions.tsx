import { useMemo } from "react";
import {
  ActivityIndicator,
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
import {
  IosEmptyState,
  NavBackButton,
  NavBar,
  Pill,
} from "@routeflow/ui/mobile/ios";
import { useAdminOrders, useAdminReturns } from "../../lib/api/admin";
import { useOperatorRouteRuns } from "../../lib/api/routes";

type ExceptionSeverity = "urgent" | "warning" | "info";

interface ExceptionItem {
  id: string;
  type: "urgent_order" | "late_route" | "pending_return";
  title: string;
  subtitle: string;
  severity: ExceptionSeverity;
  actionLabel: string;
  actionRoute: string;
}

export default function ExceptionsScreen() {
  const router = useRouter();

  const urgentOrdersQ = useAdminOrders({ urgent: true, status: "PENDING", limit: 20 });
  const pendingReturnsQ = useAdminReturns({ status: "PENDING", limit: 20 });
  const activeRunsQ = useOperatorRouteRuns({ status: "IN_PROGRESS", limit: 20 });

  const isLoading =
    urgentOrdersQ.isLoading ||
    pendingReturnsQ.isLoading ||
    activeRunsQ.isLoading;

  const exceptions = useMemo<ExceptionItem[]>(() => {
    const items: ExceptionItem[] = [];
    const today = new Date();
    today.setHours(0, 0, 0, 0);

    // Urgent pending orders
    for (const o of urgentOrdersQ.data?.data ?? []) {
      items.push({
        id: `order-${o.id}`,
        type: "urgent_order",
        title: `Urgent order ${o.orderNumber}`,
        subtitle: `${o.customer?.businessName ?? "Customer"} · needs immediate attention`,
        severity: "urgent",
        actionLabel: "View order",
        actionRoute: `/(operator)/orders/${o.id}`,
      });
    }

    // Late routes — IN_PROGRESS but scheduled date is before today
    for (const run of activeRunsQ.data?.data ?? []) {
      const scheduled = new Date(run.scheduledDate);
      scheduled.setHours(0, 0, 0, 0);
      if (scheduled < today) {
        const stopsLeft =
          (run.stops ?? []).filter(
            (s) => s.status === "PENDING" || s.status === "IN_PROGRESS",
          ).length;
        items.push({
          id: `run-${run.id}`,
          type: "late_route",
          title: `Late route — ${run.route?.name ?? "Unnamed route"}`,
          subtitle: `${stopsLeft} stop${stopsLeft === 1 ? "" : "s"} remaining · driver: ${run.driver?.contactName ?? "Unassigned"}`,
          severity: "warning",
          actionLabel: "View run",
          actionRoute: `/(operator)/routes`,
        });
      }
    }

    // Pending returns awaiting approval
    for (const r of pendingReturnsQ.data?.data ?? []) {
      items.push({
        id: `return-${r.id}`,
        type: "pending_return",
        title: `Return awaiting approval`,
        subtitle: `${r.customer?.businessName ?? "Customer"} · ${r.returnNumber ?? ""} · ${(r.reason ?? "").replace(/_/g, " ").toLowerCase()}`,
        severity: "info",
        actionLabel: "Review",
        actionRoute: `/(operator)/returns`,
      });
    }

    // Sort: urgent first, then warnings, then info
    const order: Record<ExceptionSeverity, number> = { urgent: 0, warning: 1, info: 2 };
    return items.sort((a, b) => order[a.severity] - order[b.severity]);
  }, [urgentOrdersQ.data, pendingReturnsQ.data, activeRunsQ.data]);

  const refetch = () => {
    urgentOrdersQ.refetch();
    pendingReturnsQ.refetch();
    activeRunsQ.refetch();
  };
  const isFetching =
    urgentOrdersQ.isFetching ||
    pendingReturnsQ.isFetching ||
    activeRunsQ.isFetching;

  return (
    <SafeAreaView style={styles.safe} edges={["top", "left", "right"]}>
      <NavBar
        largeTitle="Exceptions"
        inlineTitle="Needs attention"
        leading={<NavBackButton label="More" onPress={() => router.back()} />}
      />
      {isLoading ? (
        <View style={styles.center}>
          <ActivityIndicator color={ios.brand} />
        </View>
      ) : exceptions.length === 0 ? (
        <IosEmptyState
          icon={
            <Ionicons
              name="checkmark-circle-outline"
              size={40}
              color={ios.system.greenInk}
            />
          }
          title="All clear"
          subtitle="No urgent orders, late routes, or returns pending approval."
        />
      ) : (
        <ScrollView
          showsVerticalScrollIndicator={false}
          refreshControl={
            <RefreshControl refreshing={isFetching && !isLoading} onRefresh={refetch} />
          }
        >
          <View style={styles.countRow}>
            <Text style={styles.countText}>
              {exceptions.length} exception{exceptions.length === 1 ? "" : "s"}
            </Text>
          </View>
          <View style={{ paddingHorizontal: 16, gap: 10, paddingBottom: 32 }}>
            {exceptions.map((ex) => (
              <ExceptionCard
                key={ex.id}
                item={ex}
                onPress={() => router.push(ex.actionRoute as any)}
              />
            ))}
          </View>
        </ScrollView>
      )}
    </SafeAreaView>
  );
}

function ExceptionCard({
  item,
  onPress,
}: {
  item: ExceptionItem;
  onPress: () => void;
}) {
  const iconName =
    item.type === "urgent_order"
      ? "flash-outline"
      : item.type === "late_route"
        ? "time-outline"
        : "return-down-back-outline";

  const iconColor =
    item.severity === "urgent"
      ? ios.system.redInk
      : item.severity === "warning"
        ? ios.system.orangeInk
        : ios.brand;

  const iconBg =
    item.severity === "urgent"
      ? ios.system.redWash
      : item.severity === "warning"
        ? ios.system.orangeWash
        : ios.brandWash;

  const pillVariant: "red" | "orange" | "brand" =
    item.severity === "urgent"
      ? "red"
      : item.severity === "warning"
        ? "orange"
        : "brand";

  const pillLabel =
    item.severity === "urgent"
      ? "Urgent"
      : item.severity === "warning"
        ? "Warning"
        : "Pending";

  return (
    <Pressable style={styles.card} onPress={onPress}>
      <View style={styles.cardHead}>
        <View style={[styles.iconWrap, { backgroundColor: iconBg }]}>
          <Ionicons name={iconName} size={18} color={iconColor} />
        </View>
        <View style={{ flex: 1, minWidth: 0 }}>
          <Text style={styles.cardTitle} numberOfLines={1}>
            {item.title}
          </Text>
          <Text style={styles.cardSub} numberOfLines={2}>
            {item.subtitle}
          </Text>
        </View>
        <Pill variant={pillVariant} small>
          {pillLabel}
        </Pill>
      </View>
      <View style={styles.cardFoot}>
        <Text style={[styles.actionLabel, { color: iconColor }]}>
          {item.actionLabel}
        </Text>
        <Ionicons name="chevron-forward" size={14} color={iconColor} />
      </View>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: ios.bg },
  center: { flex: 1, alignItems: "center", justifyContent: "center" },
  countRow: {
    paddingHorizontal: 20,
    paddingTop: 12,
    paddingBottom: 8,
  },
  countText: {
    fontSize: 13,
    fontFamily: "Inter_600SemiBold",
    color: ios.label2,
    letterSpacing: 0.3,
    textTransform: "uppercase",
  },
  card: {
    backgroundColor: ios.bgElev,
    borderRadius: 14,
    padding: 14,
    gap: 10,
  },
  cardHead: { flexDirection: "row", alignItems: "flex-start", gap: 12 },
  iconWrap: {
    width: 36,
    height: 36,
    borderRadius: 10,
    alignItems: "center",
    justifyContent: "center",
    flexShrink: 0,
  },
  cardTitle: {
    fontSize: 15,
    fontFamily: "Inter_600SemiBold",
    color: ios.label,
    letterSpacing: -0.2,
  },
  cardSub: {
    fontSize: 12,
    fontFamily: "Inter_400Regular",
    color: ios.label2,
    marginTop: 2,
    lineHeight: 17,
  },
  cardFoot: {
    flexDirection: "row",
    alignItems: "center",
    gap: 4,
    paddingLeft: 48,
  },
  actionLabel: {
    fontSize: 13,
    fontFamily: "Inter_600SemiBold",
  },
});
