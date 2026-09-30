import { useCallback, useEffect, useMemo, useState } from "react";
import {
  ActivityIndicator,
  Modal,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { Ionicons } from "@expo/vector-icons";
import { useFocusEffect, useLocalSearchParams, useRouter } from "expo-router";
import DraggableFlatList, {
  RenderItemParams,
  ScaleDecorator,
} from "react-native-draggable-flatlist";
import { ios } from "@routeflow/ui/tokens";
import { NavAction, NavBackButton, NavBar, Pill } from "@routeflow/ui/mobile/ios";
import { useAdminDrivers, useAdminRoute } from "../../../lib/api/admin";
import {
  useCreateRun,
  useDeleteRoute,
  useOptimizeTemplate,
  useRemoveRouteStop,
  useReorderRouteStops,
} from "../../../lib/api/routes";
import { showToast } from "../../../lib/toast";
import { confirm } from "../../../lib/confirm";

function localTodayISO(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

export default function RouteDetailScreen() {
  const router = useRouter();
  const { id } = useLocalSearchParams<{ id: string }>();

  // RF-203: defensive guard — if somehow "create" reaches this screen (e.g. the
  // static create.tsx was not matched), redirect to the proper create form
  // instead of firing a doomed /routes/create API call and spinning forever.
  const isCreateAlias = id === "create" || id === "new";
  useEffect(() => {
    if (isCreateAlias) router.replace("/(operator)/routes/new");
  }, [isCreateAlias, router]);

  const { data: route, isLoading, refetch } = useAdminRoute(isCreateAlias ? null : id);
  const { data: driversData } = useAdminDrivers();
  const driver = useMemo(
    () => driversData?.data.find((d) => d.id === route?.driverId),
    [driversData, route?.driverId],
  );
  const deleteMut = useDeleteRoute();
  const removeMut = useRemoveRouteStop();
  const reorderMut = useReorderRouteStops();
  const optimizeMut = useOptimizeTemplate();
  const createRunMut = useCreateRun();
  const [dispatchVisible, setDispatchVisible] = useState(false);
  // BUG-W-8: use the operator's LOCAL calendar date for the default. Date.toISOString()
  // is always UTC, so an operator at 9pm PST sees tomorrow's UTC date and the run gets
  // scheduled a day ahead.
  const [dispatchDate, setDispatchDate] = useState(localTodayISO());
  const [dispatchNotes, setDispatchNotes] = useState("");
  const [removedIds, setRemovedIds] = useState<Set<string>>(new Set());

  useFocusEffect(
    useCallback(() => {
      refetch();
    }, [refetch]),
  );

  if (isLoading || !route) {
    return (
      <SafeAreaView style={styles.safe} edges={["top", "left", "right"]}>
        <NavBar inlineTitle="Route" leading={<NavBackButton onPress={() => router.back()} />} />
        <View style={styles.center}>
          <ActivityIndicator color={ios.brand} />
        </View>
      </SafeAreaView>
    );
  }

  const stops = (route.stops ?? [])
    .filter((s) => !removedIds.has(s.id))
    .slice()
    .sort((a, b) => a.stopNumber - b.stopNumber);
  const driverName = driver
    ? `${driver.user?.firstName ?? ""} ${driver.user?.lastName ?? ""}`.trim() ||
      driver.user?.username
    : null;

  const removeStop = (stopId: string) => {
    if (!id) return;
    confirm(
      "Remove stop?",
      "The customer will be removed from this route.",
      () => {
        setRemovedIds((prev) => new Set([...prev, stopId]));
        removeMut.mutate(
          { routeId: id, stopId },
          {
            onSuccess: () => {
              showToast("Stop removed");
              refetch();
              setRemovedIds(new Set());
            },
            onError: (e: any) => {
              setRemovedIds((prev) => {
                const next = new Set(prev);
                next.delete(stopId);
                return next;
              });
              showToast(e?.response?.data?.message ?? e?.message ?? "Try again.");
            },
          },
        );
      },
      { confirmText: "Remove", destructive: true },
    );
  };

  const handleDragEnd = ({ data }: { data: typeof stops }) => {
    if (!id) return;
    const order = data.map((s, i) => ({ id: s.id, stopNumber: i + 1 }));
    reorderMut.mutate(
      { routeId: id, order },
      {
        onSuccess: () => refetch(),
        onError: (e: any) => showToast(e?.response?.data?.message ?? e?.message ?? "Try again."),
      },
    );
  };

  const handleOptimize = () => {
    if (!id) return;
    if (stops.length < 2) {
      showToast("Add at least two stops first.");
      return;
    }
    optimizeMut.mutate(id, {
      onSuccess: (res) => {
        showToast(res?.usedFallback ? "Reordered (distance-based fallback)" : "Route optimized");
        refetch();
      },
      onError: (e: any) => showToast(e?.response?.data?.message ?? e?.message ?? "Try again."),
    });
  };

  const handleDispatchConfirm = () => {
    if (!id) return;
    createRunMut.mutate(
      { routeId: id, scheduledDate: dispatchDate, notes: dispatchNotes || undefined },
      {
        onSuccess: (run) => {
          setDispatchVisible(false);
          setDispatchNotes("");
          showToast("Run created");
          router.push(`/(operator)/route-runs/${run.id}` as any);
        },
        onError: (e: any) => showToast(e?.response?.data?.message ?? e?.message ?? "Try again."),
      },
    );
  };

  const handleDelete = () => {
    if (!id) return;
    confirm(
      "Delete route?",
      `${route.name} and all its stops will be removed.`,
      () =>
        deleteMut.mutate(id, {
          onSuccess: () => {
            showToast("Route deleted");
            router.back();
          },
          onError: (e: any) => showToast(e?.response?.data?.message ?? e?.message ?? "Try again."),
        }),
      { confirmText: "Delete", destructive: true },
    );
  };

  return (
    <SafeAreaView style={styles.safe} edges={["top", "left", "right"]}>
      <NavBar
        inlineTitle={route.name}
        leading={<NavBackButton label="Routes" onPress={() => router.back()} />}
        trailing={
          <NavAction
            label="Edit"
            bold
            onPress={() => router.push(`/(operator)/routes/${id}/edit`)}
          />
        }
      />

      <ScrollView showsVerticalScrollIndicator={false}>
        <View style={{ padding: 16, gap: 14 }}>
          <View style={styles.card}>
            <View style={{ flexDirection: "row", alignItems: "center", gap: 6 }}>
              <Text style={styles.title}>{route.name}</Text>
              {route.isActive === false ? <Pill variant="gray">Inactive</Pill> : null}
            </View>
            {route.description ? <Text style={styles.desc}>{route.description}</Text> : null}
          </View>

          <View style={styles.card}>
            <View style={styles.cardHead}>
              <Text style={styles.cardTitle}>Driver</Text>
              <Pressable onPress={() => router.push(`/(operator)/routes/${id}/assign-driver`)}>
                <Text style={styles.linkText}>{driver ? "Change" : "Assign"}</Text>
              </Pressable>
            </View>
            <Text style={styles.driverName}>{driverName ?? "Not assigned"}</Text>
            {driver?.vehicleMake ? (
              <Text style={styles.sub}>
                {driver.vehicleMake} {driver.vehicleModel ?? ""}
                {driver.vehiclePlate ? ` · ${driver.vehiclePlate}` : ""}
              </Text>
            ) : null}
          </View>

          <View style={styles.card}>
            <View style={styles.cardHead}>
              <Text style={styles.cardTitle}>Stops ({stops.length})</Text>
              <Pressable onPress={() => router.push(`/(operator)/routes/${id}/add-stop`)}>
                <Text style={styles.linkText}>Add</Text>
              </Pressable>
            </View>
            {stops.length === 0 ? (
              <Text style={styles.empty}>No stops yet.</Text>
            ) : Platform.OS === "web" ? (
              stops.map((s, i) => (
                <View
                  key={s.id}
                  style={[
                    styles.stopRow,
                    i > 0 && {
                      borderTopWidth: StyleSheet.hairlineWidth,
                      borderTopColor: ios.separator,
                    },
                  ]}
                >
                  <View style={styles.stopBadge}>
                    <Text style={styles.stopBadgeText}>{i + 1}</Text>
                  </View>
                  <View style={{ flex: 1, minWidth: 0 }}>
                    <Text style={styles.stopName} numberOfLines={1}>
                      {s.customer?.businessName ?? s.customerId}
                    </Text>
                    {typeof s.customerAddress?.lat !== "number" ||
                    typeof s.customerAddress?.lng !== "number" ? (
                      <View style={styles.noLocRow}>
                        <Ionicons name="alert-circle" size={11} color={ios.system.orangeInk} />
                        <Text style={styles.noLocText}>No location</Text>
                      </View>
                    ) : null}
                  </View>
                  <View style={{ flexDirection: "row", gap: 4 }}>
                    <Pressable
                      style={styles.iconBtn}
                      onPress={() => {
                        if (i === 0) return;
                        const order = stops.map((x, j) => {
                          if (j === i - 1) return { id: stops[i]!.id, stopNumber: i };
                          if (j === i) return { id: stops[i - 1]!.id, stopNumber: i + 1 };
                          return { id: x.id, stopNumber: j + 1 };
                        });
                        reorderMut.mutate(
                          { routeId: id!, order },
                          {
                            onSuccess: () => refetch(),
                            onError: (e: any) =>
                              showToast(e?.response?.data?.message ?? e?.message ?? "Try again."),
                          },
                        );
                      }}
                      disabled={i === 0}
                      accessibilityLabel="Move up"
                    >
                      <Ionicons
                        name="chevron-up"
                        size={16}
                        color={i === 0 ? ios.label3 : ios.label2}
                      />
                    </Pressable>
                    <Pressable
                      style={styles.iconBtn}
                      onPress={() => {
                        if (i === stops.length - 1) return;
                        const order = stops.map((x, j) => {
                          if (j === i) return { id: stops[i + 1]!.id, stopNumber: i + 1 };
                          if (j === i + 1) return { id: stops[i]!.id, stopNumber: i + 2 };
                          return { id: x.id, stopNumber: j + 1 };
                        });
                        reorderMut.mutate(
                          { routeId: id!, order },
                          {
                            onSuccess: () => refetch(),
                            onError: (e: any) =>
                              showToast(e?.response?.data?.message ?? e?.message ?? "Try again."),
                          },
                        );
                      }}
                      disabled={i === stops.length - 1}
                      accessibilityLabel="Move down"
                    >
                      <Ionicons
                        name="chevron-down"
                        size={16}
                        color={i === stops.length - 1 ? ios.label3 : ios.label2}
                      />
                    </Pressable>
                    <Pressable style={styles.iconBtn} onPress={() => removeStop(s.id)}>
                      <Ionicons name="trash-outline" size={14} color={ios.system.red} />
                    </Pressable>
                  </View>
                </View>
              ))
            ) : (
              <DraggableFlatList
                data={stops}
                keyExtractor={(s) => s.id}
                onDragEnd={handleDragEnd}
                scrollEnabled={false}
                renderItem={({
                  item: s,
                  getIndex,
                  drag,
                  isActive,
                }: RenderItemParams<(typeof stops)[number]>) => {
                  const i = getIndex() ?? 0;
                  return (
                    <ScaleDecorator activeScale={1.03}>
                      <View
                        style={[
                          styles.stopRow,
                          i > 0 && {
                            borderTopWidth: StyleSheet.hairlineWidth,
                            borderTopColor: ios.separator,
                          },
                          isActive && { backgroundColor: ios.fill3, borderRadius: 10 },
                        ]}
                      >
                        <View style={styles.stopBadge}>
                          <Text style={styles.stopBadgeText}>{i + 1}</Text>
                        </View>
                        <View style={{ flex: 1, minWidth: 0 }}>
                          <Text style={styles.stopName} numberOfLines={1}>
                            {s.customer?.businessName ?? s.customerId}
                          </Text>
                          {typeof s.customerAddress?.lat !== "number" ||
                          typeof s.customerAddress?.lng !== "number" ? (
                            <View style={styles.noLocRow}>
                              <Ionicons
                                name="alert-circle"
                                size={11}
                                color={ios.system.orangeInk}
                              />
                              <Text style={styles.noLocText}>No location</Text>
                            </View>
                          ) : null}
                        </View>
                        <View style={{ flexDirection: "row", gap: 4 }}>
                          <Pressable
                            style={styles.iconBtn}
                            onLongPress={drag}
                            accessibilityLabel="Drag to reorder"
                          >
                            <Ionicons name="reorder-three-outline" size={18} color={ios.label2} />
                          </Pressable>
                          <Pressable style={styles.iconBtn} onPress={() => removeStop(s.id)}>
                            <Ionicons name="trash-outline" size={14} color={ios.system.red} />
                          </Pressable>
                        </View>
                      </View>
                    </ScaleDecorator>
                  );
                }}
              />
            )}
          </View>

          <Pressable
            style={styles.mapBtn}
            onPress={() => router.push(`/(operator)/routes/${id}/map`)}
          >
            <Ionicons name="map-outline" size={18} color={ios.brand} />
            <Text style={styles.mapBtnText}>View on map</Text>
          </Pressable>

          <Pressable
            style={[styles.mapBtn, optimizeMut.isPending && { opacity: 0.6 }]}
            onPress={handleOptimize}
            disabled={optimizeMut.isPending || stops.length < 2}
          >
            {optimizeMut.isPending ? (
              <ActivityIndicator color={ios.brand} size="small" />
            ) : (
              <Ionicons name="sparkles-outline" size={18} color={ios.brand} />
            )}
            <Text style={styles.mapBtnText}>
              {optimizeMut.isPending ? "Optimizing…" : "Optimize stops"}
            </Text>
          </Pressable>

          {(() => {
            // An ad-hoc trip carries no order linkage until it is sent, so only
            // the trip builder (which knows the picked orders) may dispatch one —
            // the API rejects a dispatch without orderIds. Block it here rather
            // than offering a button that always fails.
            const isAdhocTrip = route.kind === "ADHOC";
            const cannotDispatch = isAdhocTrip || !driver || stops.length === 0;
            const dispatchHint = isAdhocTrip
              ? "Send this trip from the trip builder — rebuild it from the Orders list"
              : !driver
                ? "Assign a driver before dispatching"
                : stops.length === 0
                  ? "Add at least one stop before dispatching"
                  : null;
            return (
              <>
                <Pressable
                  style={[styles.dispatchBtn, cannotDispatch && { opacity: 0.4 }]}
                  onPress={() => {
                    setDispatchDate(localTodayISO());
                    setDispatchVisible(true);
                  }}
                  disabled={cannotDispatch}
                >
                  <Ionicons name="play-circle-outline" size={18} color="#fff" />
                  <Text style={styles.dispatchBtnText}>Dispatch run</Text>
                </Pressable>
                {dispatchHint ? (
                  <Text
                    style={{ color: ios.label3, fontSize: 13, textAlign: "center", marginTop: -6 }}
                  >
                    {dispatchHint}
                  </Text>
                ) : null}
              </>
            );
          })()}

          <Pressable style={styles.deleteBtn} onPress={handleDelete} disabled={deleteMut.isPending}>
            <Ionicons name="trash-outline" size={18} color={ios.system.red} />
            <Text style={styles.deleteBtnText}>Delete route</Text>
          </Pressable>
        </View>
        <View style={{ height: 24 }} />
      </ScrollView>

      <Modal
        visible={dispatchVisible}
        transparent
        animationType="slide"
        onRequestClose={() => setDispatchVisible(false)}
      >
        <Pressable style={styles.modalBackdrop} onPress={() => setDispatchVisible(false)} />
        <View style={styles.modalSheet}>
          <View style={styles.modalHandle} />
          <Text style={styles.modalTitle}>Dispatch run</Text>
          <Text style={styles.modalLabel}>Date</Text>
          <TextInput
            style={styles.modalInput}
            value={dispatchDate}
            onChangeText={setDispatchDate}
            placeholder="YYYY-MM-DD"
            placeholderTextColor={ios.label3}
            keyboardType="numbers-and-punctuation"
            autoCapitalize="none"
          />
          <Text style={styles.modalLabel}>Notes (optional)</Text>
          <TextInput
            style={[styles.modalInput, { height: 72, textAlignVertical: "top" }]}
            value={dispatchNotes}
            onChangeText={setDispatchNotes}
            placeholder="Driver notes…"
            placeholderTextColor={ios.label3}
            multiline
          />
          <View style={{ flexDirection: "row", gap: 10, marginTop: 6 }}>
            <Pressable
              style={[styles.modalBtn, { backgroundColor: ios.fill2, flex: 1 }]}
              onPress={() => setDispatchVisible(false)}
            >
              <Text style={[styles.modalBtnText, { color: ios.label }]}>Cancel</Text>
            </Pressable>
            <Pressable
              style={[
                styles.modalBtn,
                { backgroundColor: ios.brand, flex: 1 },
                createRunMut.isPending && { opacity: 0.6 },
              ]}
              onPress={handleDispatchConfirm}
              disabled={createRunMut.isPending}
            >
              {createRunMut.isPending ? (
                <ActivityIndicator color="#fff" size="small" />
              ) : (
                <Text style={[styles.modalBtnText, { color: "#fff" }]}>Dispatch</Text>
              )}
            </Pressable>
          </View>
        </View>
      </Modal>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: ios.bg },
  center: { padding: 40, alignItems: "center" },
  card: { backgroundColor: ios.bgElev, borderRadius: 14, padding: 14, gap: 6 },
  cardHead: { flexDirection: "row", alignItems: "center", justifyContent: "space-between" },
  cardTitle: { fontSize: 15, fontFamily: "Inter_600SemiBold", color: ios.label },
  linkText: { fontSize: 14, fontFamily: "Inter_500Medium", color: ios.brand },
  title: { fontSize: 22, fontFamily: "Inter_700Bold", color: ios.label, letterSpacing: -0.4 },
  desc: { fontSize: 13, fontFamily: "Inter_400Regular", color: ios.label2 },
  driverName: { fontSize: 16, fontFamily: "Inter_600SemiBold", color: ios.label, marginTop: 4 },
  sub: { fontSize: 12, fontFamily: "Inter_400Regular", color: ios.label2, marginTop: 2 },
  empty: { fontSize: 13, fontFamily: "Inter_400Regular", color: ios.label2, paddingVertical: 8 },
  stopRow: { flexDirection: "row", alignItems: "center", gap: 10, paddingVertical: 10 },
  stopBadge: {
    width: 28,
    height: 28,
    borderRadius: 999,
    backgroundColor: ios.brandWash,
    alignItems: "center",
    justifyContent: "center",
  },
  stopBadgeText: { color: ios.brand, fontSize: 12, fontFamily: "Inter_700Bold" },
  stopName: { fontSize: 14, fontFamily: "Inter_500Medium", color: ios.label },
  noLocRow: { flexDirection: "row", alignItems: "center", gap: 4, marginTop: 2 },
  noLocText: {
    fontSize: 11,
    fontFamily: "Inter_500Medium",
    color: ios.system.orangeInk,
  },
  iconBtn: {
    width: 30,
    height: 30,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: ios.fill3,
    borderRadius: 8,
  },
  mapBtn: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 8,
    backgroundColor: ios.brandWash,
    paddingVertical: 14,
    borderRadius: 12,
  },
  mapBtnText: { color: ios.brand, fontSize: 15, fontFamily: "Inter_600SemiBold" },
  deleteBtn: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 8,
    backgroundColor: ios.bgElev,
    paddingVertical: 14,
    borderRadius: 12,
  },
  deleteBtnText: { color: ios.system.red, fontSize: 15, fontFamily: "Inter_500Medium" },
  dispatchBtn: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 8,
    backgroundColor: ios.brand,
    paddingVertical: 14,
    borderRadius: 12,
  },
  dispatchBtnText: { color: "#fff", fontSize: 15, fontFamily: "Inter_600SemiBold" },
  modalBackdrop: {
    flex: 1,
    backgroundColor: "rgba(0,0,0,0.4)",
  },
  modalSheet: {
    backgroundColor: ios.bgElev,
    borderTopLeftRadius: 20,
    borderTopRightRadius: 20,
    padding: 20,
    paddingBottom: 36,
    gap: 8,
  },
  modalHandle: {
    alignSelf: "center",
    width: 36,
    height: 4,
    borderRadius: 2,
    backgroundColor: ios.separator,
    marginBottom: 8,
  },
  modalTitle: { fontSize: 18, fontFamily: "Inter_700Bold", color: ios.label, marginBottom: 4 },
  modalLabel: { fontSize: 13, fontFamily: "Inter_500Medium", color: ios.label2, marginTop: 6 },
  modalInput: {
    backgroundColor: ios.fill3,
    borderRadius: 10,
    paddingHorizontal: 12,
    paddingVertical: 10,
    fontSize: 15,
    fontFamily: "Inter_400Regular",
    color: ios.label,
  },
  modalBtn: {
    paddingVertical: 13,
    borderRadius: 12,
    alignItems: "center",
    justifyContent: "center",
  },
  modalBtnText: { fontSize: 15, fontFamily: "Inter_600SemiBold" },
});
