import { useState } from "react";
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
import { FilterChipRow, NavAction, NavBackButton, NavBar, Pill } from "@routeflow/ui/mobile/ios";
import { useAdminReturns, type AdminReturn } from "../../../lib/api/admin";
import {
  useApproveReturn,
  useMarkReturnInTransit,
  useReceiveReturn,
  useRejectReturn,
} from "../../../lib/api/returns";
import { returnActionFlags, returnPillFor } from "../../../lib/returns-logic";
import { showToast } from "../../../lib/toast";
import { confirm } from "../../../lib/confirm";

// RF-212: default "All" so data is visible immediately. Previous default was
// "PENDING" which caused an empty state when returns were in APPROVED/IN_TRANSIT.
// The API status filter is passed through as-is; "ALL" omits the filter param.
const FILTERS = [
  { id: "ALL", label: "All" },
  { id: "PENDING", label: "Pending" },
  { id: "APPROVED", label: "Approved" },
  { id: "IN_TRANSIT", label: "In transit" },
  { id: "RECEIVED", label: "Received" },
  { id: "CANCELLED", label: "Cancelled" },
] as const;

type FilterId = (typeof FILTERS)[number]["id"];

export default function ReturnsListScreen() {
  const router = useRouter();
  // RF-212: default ALL so existing returns are visible immediately.
  const [filter, setFilter] = useState<FilterId>("ALL");
  const { data, isLoading, isFetching, refetch } = useAdminReturns({
    status: filter === "ALL" ? undefined : filter,
    limit: 100,
  });
  const items = data?.data ?? [];

  const approveMut = useApproveReturn();
  const rejectMut = useRejectReturn();
  const inTransitMut = useMarkReturnInTransit();
  const receiveMut = useReceiveReturn();

  const runMut = (mut: { mutate: (id: string, o: any) => void }, id: string, ok: string) =>
    mut.mutate(id, {
      onSuccess: () => {
        showToast(ok);
        refetch();
      },
      onError: (e: any) => showToast(e?.response?.data?.message ?? e?.message ?? "Try again."),
    });
  const approve = (id: string) => runMut(approveMut, id, "Return approved");
  const reject = (id: string) =>
    confirm(
      "Reject return?",
      "The return will be rejected.",
      () => runMut(rejectMut, id, "Return rejected"),
      {
        confirmText: "Reject",
        destructive: true,
      },
    );
  const markInTransit = (id: string) => runMut(inTransitMut, id, "Marked in transit");
  const receive = (id: string) => runMut(receiveMut, id, "Marked received");

  return (
    <SafeAreaView style={styles.safe} edges={["top", "left", "right"]}>
      <NavBar
        largeTitle="Returns"
        leading={<NavBackButton label="Back" onPress={() => router.back()} />}
        trailing={
          <NavAction label="New" bold onPress={() => router.push("/(operator)/returns/new")} />
        }
      />
      <FilterChipRow
        chips={FILTERS.map((f) => ({ label: f.label }))}
        value={FILTERS.find((f) => f.id === filter)?.label ?? "All"}
        onChange={(label) =>
          setFilter((FILTERS.find((f) => f.label === label)?.id ?? "ALL") as FilterId)
        }
      />
      <ScrollView
        showsVerticalScrollIndicator={false}
        refreshControl={
          <RefreshControl refreshing={isFetching && !isLoading} onRefresh={refetch} />
        }
      >
        {isLoading ? (
          <View style={styles.center}>
            <ActivityIndicator color={ios.brand} />
          </View>
        ) : items.length === 0 ? (
          <View style={styles.center}>
            <Text style={styles.empty}>No returns to process.</Text>
          </View>
        ) : (
          <View style={{ paddingHorizontal: 16, gap: 8, paddingBottom: 24 }}>
            {items.map((r) => (
              <ReturnRow
                key={r.id}
                r={r}
                onOpen={() => router.push(`/(operator)/returns/${r.id}`)}
                onApprove={() => approve(r.id)}
                onReject={() => reject(r.id)}
                onMarkInTransit={() => markInTransit(r.id)}
                onReceive={() => receive(r.id)}
              />
            ))}
          </View>
        )}
      </ScrollView>
    </SafeAreaView>
  );
}

function ReturnRow({
  r,
  onOpen,
  onApprove,
  onReject,
  onMarkInTransit,
  onReceive,
}: {
  r: AdminReturn;
  onOpen: () => void;
  onApprove: () => void;
  onReject: () => void;
  onMarkInTransit: () => void;
  onReceive: () => void;
}) {
  const s = returnPillFor(r.status);
  const flags = returnActionFlags(r.status);

  return (
    <Pressable style={styles.row} onPress={onOpen}>
      <View style={styles.head}>
        <View style={{ flex: 1, minWidth: 0 }}>
          <Text style={styles.title} numberOfLines={1}>
            {r.returnNumber ?? "Return"}
          </Text>
          <Text style={styles.sub} numberOfLines={1}>
            {r.customer?.businessName ?? "Customer"}
            {r.order?.orderNumber ? ` · Order ${r.order.orderNumber}` : ""}
          </Text>
        </View>
        <Pill variant={s.variant} dot>
          {s.label}
        </Pill>
      </View>
      {r.items && r.items.length > 0 ? (
        <Text style={styles.itemList} numberOfLines={2}>
          {r.items.map((i) => `${i.qty} × ${i.product?.name ?? "Item"}`).join(" · ")}
        </Text>
      ) : null}
      {r.reason ? (
        <Text style={styles.reason}>{r.reason.replace(/_/g, " ").toLowerCase()}</Text>
      ) : null}
      {flags.canApprove || flags.canMarkInTransit || flags.canReceive ? (
        // stopPropagation so a quick-action tap doesn't ALSO bubble to the row's
        // onOpen navigation (Pressable-in-Pressable bubbles on the RN-web build).
        <View style={styles.actions}>
          {flags.canApprove ? (
            <>
              <Pressable
                style={[styles.btn, styles.btnPrimary]}
                onPress={(e) => {
                  e.stopPropagation();
                  onApprove();
                }}
              >
                <Ionicons name="checkmark" size={14} color="#fff" />
                <Text style={styles.btnPrimaryText}>Approve</Text>
              </Pressable>
              <Pressable
                style={[styles.btn, styles.btnGhost]}
                onPress={(e) => {
                  e.stopPropagation();
                  onReject();
                }}
              >
                <Text style={styles.btnGhostText}>Reject</Text>
              </Pressable>
            </>
          ) : null}
          {flags.canMarkInTransit ? (
            <Pressable
              style={[styles.btn, styles.btnPrimary]}
              onPress={(e) => {
                e.stopPropagation();
                onMarkInTransit();
              }}
            >
              <Ionicons name="car-outline" size={14} color="#fff" />
              <Text style={styles.btnPrimaryText}>Mark in transit</Text>
            </Pressable>
          ) : null}
          {flags.canReceive ? (
            <Pressable
              style={[styles.btn, styles.btnPrimary]}
              onPress={(e) => {
                e.stopPropagation();
                onReceive();
              }}
            >
              <Ionicons name="archive-outline" size={14} color="#fff" />
              <Text style={styles.btnPrimaryText}>Mark received</Text>
            </Pressable>
          ) : null}
        </View>
      ) : null}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: ios.bg },
  center: { padding: 40, alignItems: "center" },
  empty: { fontSize: 14, fontFamily: "Inter_400Regular", color: ios.label2 },
  row: { backgroundColor: ios.bgElev, borderRadius: 12, padding: 14, gap: 6 },
  head: { flexDirection: "row", alignItems: "center", gap: 10 },
  title: { fontSize: 15, fontFamily: "Inter_600SemiBold", color: ios.label },
  sub: { fontSize: 12, fontFamily: "Inter_400Regular", color: ios.label2, marginTop: 2 },
  itemList: { fontSize: 13, fontFamily: "Inter_400Regular", color: ios.label, marginTop: 4 },
  reason: {
    fontSize: 12,
    fontFamily: "Inter_500Medium",
    color: ios.label2,
    marginTop: 2,
    textTransform: "capitalize",
  },
  actions: { flexDirection: "row", gap: 8, marginTop: 8 },
  btn: {
    flex: 1,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 6,
    paddingVertical: 10,
    borderRadius: 10,
  },
  btnPrimary: { backgroundColor: ios.brand },
  btnPrimaryText: { color: "#fff", fontSize: 13, fontFamily: "Inter_600SemiBold" },
  btnGhost: { backgroundColor: ios.fill3 },
  btnGhostText: { color: ios.label, fontSize: 13, fontFamily: "Inter_500Medium" },
});
