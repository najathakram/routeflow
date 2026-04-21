import { useState } from "react";
import {
  ActivityIndicator,
  Alert,
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
  FilterChipRow,
  NavBackButton,
  NavBar,
  Pill,
} from "@routeflow/ui/mobile/ios";
import { useAdminReturns, type AdminReturn } from "../../../lib/api/admin";
import {
  useApproveReturn,
  useReceiveReturn,
  useRejectReturn,
} from "../../../lib/api/returns";
import { showToast } from "../../../lib/toast";

const FILTERS = [
  { id: "ALL", label: "All" },
  { id: "PENDING", label: "Pending" },
  { id: "PROCESSED", label: "Processed" },
  { id: "CANCELLED", label: "Cancelled" },
] as const;

type FilterId = (typeof FILTERS)[number]["id"];

function statusPill(status: string) {
  switch (status) {
    case "PENDING":
      return { variant: "orange" as const, label: "Pending" };
    case "PROCESSED":
      return { variant: "green" as const, label: "Processed" };
    case "CANCELLED":
      return { variant: "gray" as const, label: "Cancelled" };
    default:
      return { variant: "gray" as const, label: status };
  }
}

export default function ReturnsListScreen() {
  const router = useRouter();
  const [filter, setFilter] = useState<FilterId>("PENDING");
  const { data, isLoading, isFetching, refetch } = useAdminReturns({
    status: filter === "ALL" ? undefined : filter,
    limit: 100,
  });
  const items = data?.data ?? [];

  const approveMut = useApproveReturn();
  const rejectMut = useRejectReturn();
  const receiveMut = useReceiveReturn();

  const approve = (id: string) =>
    approveMut.mutate(id, {
      onSuccess: () => {
        showToast("Return approved");
        refetch();
      },
      onError: (e: any) =>
        Alert.alert("Couldn't approve", e?.response?.data?.message ?? e?.message ?? "Try again."),
    });
  const reject = (id: string) =>
    Alert.alert("Reject return?", "The return will be cancelled.", [
      { text: "Keep", style: "cancel" },
      {
        text: "Reject",
        style: "destructive",
        onPress: () =>
          rejectMut.mutate(id, {
            onSuccess: () => {
              showToast("Return rejected");
              refetch();
            },
            onError: (e: any) =>
              Alert.alert("Couldn't reject", e?.response?.data?.message ?? e?.message ?? "Try again."),
          }),
      },
    ]);
  const receive = (id: string) =>
    receiveMut.mutate(id, {
      onSuccess: () => {
        showToast("Marked received");
        refetch();
      },
      onError: (e: any) =>
        Alert.alert("Couldn't update", e?.response?.data?.message ?? e?.message ?? "Try again."),
    });

  return (
    <SafeAreaView style={styles.safe} edges={["top", "left", "right"]}>
      <NavBar
        largeTitle="Returns"
        leading={<NavBackButton label="Back" onPress={() => router.back()} />}
      />
      <FilterChipRow
        chips={FILTERS.map((f) => ({ label: f.label }))}
        value={FILTERS.find((f) => f.id === filter)?.label ?? "Pending"}
        onChange={(label) =>
          setFilter((FILTERS.find((f) => f.label === label)?.id as FilterId) ?? "ALL")
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
                onApprove={() => approve(r.id)}
                onReject={() => reject(r.id)}
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
  onApprove,
  onReject,
  onReceive,
}: {
  r: AdminReturn;
  onApprove: () => void;
  onReject: () => void;
  onReceive: () => void;
}) {
  const s = statusPill(r.status);
  const isPending = r.status === "PENDING";
  const isApproved = r.status === "APPROVED" || r.status === "IN_TRANSIT";

  return (
    <View style={styles.row}>
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
      {r.reason ? <Text style={styles.reason}>{r.reason.replace(/_/g, " ").toLowerCase()}</Text> : null}
      {(isPending || isApproved) ? (
        <View style={styles.actions}>
          {isPending ? (
            <>
              <Pressable style={[styles.btn, styles.btnPrimary]} onPress={onApprove}>
                <Ionicons name="checkmark" size={14} color="#fff" />
                <Text style={styles.btnPrimaryText}>Approve</Text>
              </Pressable>
              <Pressable style={[styles.btn, styles.btnGhost]} onPress={onReject}>
                <Text style={styles.btnGhostText}>Reject</Text>
              </Pressable>
            </>
          ) : null}
          {isApproved ? (
            <Pressable style={[styles.btn, styles.btnPrimary]} onPress={onReceive}>
              <Ionicons name="archive-outline" size={14} color="#fff" />
              <Text style={styles.btnPrimaryText}>Mark received</Text>
            </Pressable>
          ) : null}
        </View>
      ) : null}
    </View>
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
  reason: { fontSize: 12, fontFamily: "Inter_500Medium", color: ios.label2, marginTop: 2, textTransform: "capitalize" },
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
