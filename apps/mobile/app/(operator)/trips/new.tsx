import { useMemo, useState } from "react";
import { ActivityIndicator, Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { Swipeable } from "react-native-gesture-handler";
import { Ionicons } from "@expo/vector-icons";
import { useRouter } from "expo-router";
import { ios } from "@routeflow/ui/tokens";
import { IosEmptyState, NavBackButton, NavBar, SegmentedControl } from "@routeflow/ui/mobile/ios";
import {
  useAdminDrivers,
  useCreateTrip,
  useCreateTripRun,
  useTripEligibility,
  type AdminDriver,
  type TripEligibilityRow,
  type TripOrigin,
} from "../../../lib/api/admin";
import { useOptimizeTemplate, useRouteSettings } from "../../../lib/api/routes";
import { useTripDraftStore } from "../../../lib/trip-draft";
import { groupOrdersForTrip, type TripStopGroup } from "../../../lib/trip-grouping";
import { FormField, FormSection, FormTextInput } from "../../../components/FormSheet";
import { showToast } from "../../../lib/toast";

function localTodayISO(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function driverDisplayName(driver: AdminDriver | undefined): string {
  if (!driver) return "Unassigned";
  if (driver.user?.firstName || driver.user?.lastName) {
    return `${driver.user.firstName ?? ""} ${driver.user.lastName ?? ""}`.trim();
  }
  return driver.user?.username ?? "Driver";
}

const REASON_LABELS: Record<string, string> = {
  SHIP_FULFILLMENT: "Ships via carrier, not routed",
  INELIGIBLE_STATUS: "Not open for delivery",
  ON_ACTIVE_RUN: "Already on an active run",
  PREVIOUSLY_DISPATCHED: "Attached to a finished run",
  NO_ADDRESS: "Customer has no delivery address",
  NOT_FOUND: "Order not found",
};

type OriginTab = "Depot" | "Driver" | "Custom";

/** The run date is free text here (no native date picker on this screen), so
 *  gate it client-side on the exact shape `CreateRouteRunDto.@IsDateString()`
 *  accepts — otherwise "8/25/2026" passes the CTA and 400s only AFTER the
 *  draft route already exists. */
const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/** The draft route created by the first "Send" press, frozen with the stops and
 *  order ids it was built from. Held so a failed dispatch can be retried
 *  against the SAME route (mirrors web's PICKING → BUILT phase) instead of
 *  creating a duplicate draft trip on every press. */
type CreatedTrip = {
  id: string;
  name: string;
  groups: TripStopGroup[];
  orderIds: string[];
};

/**
 * Ad-hoc trip builder — a single review screen (not a FormSheet modal): pick
 * the stops, the start point, the driver, and the date, then one "Send"
 * action runs the same 3-call sequence as web's builder (POST /trips → best-
 * effort optimize → POST /route-runs with orderIds) before landing on the
 * created run. Reads its order selection from the trip-draft store, which the
 * orders-list multi-select (dev-mode only) populates.
 */
export default function TripBuilderScreen() {
  const router = useRouter();
  const draftOrderIds = useTripDraftStore((s) => s.orderIds);
  const clearDraft = useTripDraftStore((s) => s.clear);

  const { data: eligibility, isLoading: eligibilityLoading } = useTripEligibility(draftOrderIds);
  const { data: driversData } = useAdminDrivers();
  const { data: routeSettings } = useRouteSettings();
  const createTrip = useCreateTrip();
  const optimizeMut = useOptimizeTemplate();
  const createRun = useCreateTripRun();

  const [droppedCustomerIds, setDroppedCustomerIds] = useState<Set<string>>(new Set());
  const [originTab, setOriginTab] = useState<OriginTab>("Depot");
  const [driverId, setDriverId] = useState<string | null>(null);
  const [addrLine1, setAddrLine1] = useState("");
  const [addrCity, setAddrCity] = useState("");
  const [addrState, setAddrState] = useState("");
  const [addrZip, setAddrZip] = useState("");
  const [name, setName] = useState("");
  const [date, setDate] = useState(localTodayISO());
  const [submitting, setSubmitting] = useState(false);
  const [createdTrip, setCreatedTrip] = useState<CreatedTrip | null>(null);

  const drivers = driversData?.data ?? [];
  const rows: TripEligibilityRow[] = eligibility ?? [];
  const eligibleRows = rows.filter((r) => r.eligible);
  const ineligibleRows = rows.filter((r) => !r.eligible);
  const orderNumberById = useMemo(() => {
    const m = new Map<string, string | null>();
    for (const r of rows) m.set(r.orderId, r.orderNumber);
    return m;
  }, [rows]);

  const { groups, skipped: noCustomerSkips } = useMemo(
    () =>
      groupOrdersForTrip(
        eligibleRows.map((r) => ({
          id: r.orderId,
          orderNumber: r.orderNumber,
          customerId: r.customerId,
          customerName: r.customerName,
        })),
      ),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [eligibility],
  );

  // Once the draft route exists its stops are server truth — show and dispatch
  // the frozen snapshot rather than a live preview the route no longer matches.
  const pickingGroups = groups.filter((g) => !droppedCustomerIds.has(g.customerId));
  const stopGroups = createdTrip ? createdTrip.groups : pickingGroups;
  const orderIds = createdTrip ? createdTrip.orderIds : pickingGroups.flatMap((g) => g.orderIds);
  const driver = drivers.find((d) => d.id === driverId);
  const driverName = driver ? driverDisplayName(driver) : null;

  // Directive: never drop an order from the preview without a visible reason
  // — combine the server's ineligible[] with the (defensive-only; the server
  // already excludes customerless orders from "eligible") client-side
  // NO_CUSTOMER skip so nothing can silently vanish from this screen.
  const skippedDisplay = [
    ...ineligibleRows.map((r) => ({
      key: r.orderId,
      label: r.orderNumber ?? r.orderId,
      customerName: r.customerName,
      reason: r.detail ?? (r.reason ? REASON_LABELS[r.reason] : "Not eligible"),
    })),
    ...noCustomerSkips.map((s) => ({
      key: s.orderId,
      label: s.orderNumber ?? s.orderId,
      customerName: null as string | null,
      reason: "No customer on this order",
    })),
  ];

  const dropGroup = (customerId: string) => {
    setDroppedCustomerIds((prev) => new Set([...prev, customerId]));
  };

  // Mirrors the server's resolveTenantDepot tiers (cached coords, else geocode
  // the tenant's business address) and the web builder's predicate, so both
  // clients agree on when the depot origin is available.
  const hasDepot =
    (routeSettings?.depotLat != null && routeSettings?.depotLng != null) ||
    !!routeSettings?.depotAddress;

  // A selected driver isn't enough — the server resolves this origin from
  // homeLat/homeLng, written only when someone fills in the Home Base on the
  // driver profile (mirrors the web builder's predicate).
  const hasDriverHome = driver?.homeLat != null && driver?.homeLng != null;

  const originResolvable =
    originTab === "Depot"
      ? hasDepot
      : originTab === "Driver"
        ? !!driverId && hasDriverHome
        : addrLine1.trim().length > 0;

  const dateValid = ISO_DATE_RE.test(date.trim());

  const canSubmit =
    !submitting &&
    !eligibilityLoading &&
    stopGroups.length > 0 &&
    (originResolvable || !!createdTrip) &&
    dateValid;

  const buildOrigin = (): TripOrigin => {
    if (originTab === "Driver" && driverId) return { type: "DRIVER", driverId };
    if (originTab === "Custom") {
      return {
        type: "ADDRESS",
        line1: addrLine1.trim(),
        city: addrCity.trim() || undefined,
        state: addrState.trim() || undefined,
        zip: addrZip.trim() || undefined,
      };
    }
    return { type: "TENANT" };
  };

  const handleCreateTrip = async () => {
    if (!canSubmit) return;
    setSubmitting(true);
    // Retrying after a failed dispatch reuses the route the first press
    // created — re-running createTrip would orphan a duplicate draft trip on
    // every attempt.
    let trip = createdTrip;
    try {
      if (!trip) {
        const route = await createTrip.mutateAsync({
          orderIds,
          name: name.trim() || undefined,
          driverId: driverId ?? undefined,
          origin: buildOrigin(),
        });
        trip = { id: route.id, name: route.name, groups: stopGroups, orderIds };
        setCreatedTrip(trip);
        try {
          await optimizeMut.mutateAsync(route.id);
        } catch {
          showToast("Trip created; optimization unavailable — stops in selection order");
        }
      }
      const run = await createRun.mutateAsync({
        routeId: trip.id,
        scheduledDate: date.trim(),
        driverId: driverId ?? undefined,
        orderIds: trip.orderIds,
      });
      clearDraft();
      showToast("Trip dispatched");
      router.replace(`/(operator)/route-runs/${run.id}` as any);
    } catch (e: any) {
      const raw = e?.response?.data?.message ?? e?.message;
      // class-validator sends `message` as an array of messages.
      const message = (Array.isArray(raw) ? raw.join(" ") : raw) || "Could not create the trip.";
      showToast(
        trip ? `${message} "${trip.name}" is saved — fix the details and send again.` : message,
      );
    } finally {
      setSubmitting(false);
    }
  };

  if (draftOrderIds.length === 0) {
    return (
      <SafeAreaView style={styles.safe} edges={["top", "left", "right"]}>
        <NavBar
          inlineTitle="Plan delivery"
          leading={<NavBackButton onPress={() => router.back()} />}
        />
        <IosEmptyState
          icon={<Ionicons name="navigate-outline" size={40} color={ios.gray[2]} />}
          title="Select orders from the Orders list to plan a trip"
          actionLabel="Go to Orders"
          onActionPress={() => router.replace("/(operator)/(tabs)/orders")}
        />
      </SafeAreaView>
    );
  }

  const ctaLabel = `Send ${stopGroups.length} stop${stopGroups.length === 1 ? "" : "s"} · ${orderIds.length} order${orderIds.length === 1 ? "" : "s"}${driverName ? ` to ${driverName}` : ""}`;

  return (
    <SafeAreaView style={styles.safe} edges={["top", "left", "right"]}>
      <NavBar
        inlineTitle="Plan delivery"
        leading={<NavBackButton onPress={() => router.back()} />}
      />

      <ScrollView
        showsVerticalScrollIndicator={false}
        contentContainerStyle={{ paddingBottom: 24 }}
      >
        <FormSection title={`Stops (${stopGroups.length})`}>
          {eligibilityLoading ? (
            <ActivityIndicator color={ios.brand} style={{ paddingVertical: 20 }} />
          ) : stopGroups.length === 0 ? (
            <Text style={styles.emptyHint}>
              None of the selected orders are eligible — see Skipped below.
            </Text>
          ) : (
            <View style={{ gap: 8 }}>
              <Text style={styles.swipeHint}>
                {createdTrip
                  ? `"${createdTrip.name}" is saved with these stops — sending again dispatches it, it won't create a second trip.`
                  : "Swipe a stop left to remove it."}
              </Text>
              {stopGroups.map((g, i) => (
                <TripStopRow
                  key={g.customerId}
                  index={i + 1}
                  group={g}
                  orderNumberById={orderNumberById}
                  onDrop={createdTrip ? undefined : () => dropGroup(g.customerId)}
                />
              ))}
            </View>
          )}
        </FormSection>

        {skippedDisplay.length > 0 ? (
          <FormSection title={`Skipped (${skippedDisplay.length})`}>
            <View style={{ gap: 8 }}>
              {skippedDisplay.map((s) => (
                <View key={s.key} style={styles.skippedRow}>
                  <Ionicons name="alert-circle-outline" size={16} color={ios.system.orangeInk} />
                  <View style={{ flex: 1, minWidth: 0 }}>
                    <Text style={styles.skippedTitle} numberOfLines={1}>
                      {s.label}
                      {s.customerName ? ` · ${s.customerName}` : ""}
                    </Text>
                    <Text style={styles.skippedReason}>{s.reason}</Text>
                  </View>
                </View>
              ))}
            </View>
          </FormSection>
        ) : null}

        <FormSection title="Start from">
          <SegmentedControl
            items={["Depot", "Driver", "Custom"]}
            value={originTab}
            onChange={(v) => setOriginTab(v as OriginTab)}
            disabledItems={hasDepot ? [] : ["Depot"]}
          />
          {originTab === "Depot" ? (
            routeSettings?.depotAddress ? (
              <Text style={styles.originHint}>{routeSettings.depotAddress}</Text>
            ) : hasDepot ? (
              <Text style={styles.originHint}>Saved depot location</Text>
            ) : (
              <Text style={styles.originWarn}>
                Add your business address in Settings → Business profile.
              </Text>
            )
          ) : null}
          {originTab === "Driver" ? (
            !driverId ? (
              <Text style={styles.originWarn}>Choose a driver below to use their home base.</Text>
            ) : hasDriverHome ? (
              <Text style={styles.originHint}>Starts from {driverName}&rsquo;s home base.</Text>
            ) : (
              // No dead ends: name the driver AND offer the fix.
              <>
                <Text style={styles.originWarn}>{driverName} has no home base set.</Text>
                <Pressable onPress={() => router.push(`/(operator)/drivers/${driverId}/edit`)}>
                  <Text style={styles.originLink}>Add a home address on their profile</Text>
                </Pressable>
              </>
            )
          ) : null}
          {originTab === "Custom" ? (
            <View style={{ gap: 10, marginTop: 10 }}>
              <FormField label="Street">
                <FormTextInput
                  value={addrLine1}
                  onChangeText={setAddrLine1}
                  placeholder="123 Harbor Way"
                />
              </FormField>
              <FormField label="City">
                <FormTextInput
                  value={addrCity}
                  onChangeText={setAddrCity}
                  placeholder="Austin"
                  autoCapitalize="words"
                />
              </FormField>
              <View style={{ flexDirection: "row", gap: 10 }}>
                <View style={{ flex: 1 }}>
                  <FormField label="State">
                    <FormTextInput
                      value={addrState}
                      onChangeText={setAddrState}
                      placeholder="TX"
                      autoCapitalize="characters"
                      maxLength={2}
                    />
                  </FormField>
                </View>
                <View style={{ flex: 1 }}>
                  <FormField label="ZIP">
                    <FormTextInput
                      value={addrZip}
                      onChangeText={setAddrZip}
                      placeholder="78701"
                      keyboardType="number-pad"
                    />
                  </FormField>
                </View>
              </View>
              <Text style={styles.originHint}>
                The server locates this address — no map needed here.
              </Text>
            </View>
          ) : null}
        </FormSection>

        <FormSection title="Driver">
          {drivers.length === 0 ? (
            <Text style={styles.emptyHint}>No drivers on this tenant.</Text>
          ) : (
            <View style={{ gap: 8 }}>
              {drivers.map((d) => {
                const active = d.id === driverId;
                return (
                  <Pressable
                    key={d.id}
                    style={[styles.driverOption, active && styles.driverOptionActive]}
                    onPress={() => setDriverId(active ? null : d.id)}
                  >
                    <Ionicons
                      name={active ? "checkmark-circle" : "ellipse-outline"}
                      size={20}
                      color={active ? ios.brand : ios.gray[3]}
                    />
                    <Text style={styles.driverOptionText}>{driverDisplayName(d)}</Text>
                  </Pressable>
                );
              })}
            </View>
          )}
        </FormSection>

        <FormSection title="Date">
          <FormField label="Delivery date">
            <FormTextInput
              value={date}
              onChangeText={setDate}
              placeholder="YYYY-MM-DD"
              keyboardType="numbers-and-punctuation"
              autoCapitalize="none"
            />
          </FormField>
          {dateValid ? null : (
            // No dead ends: the CTA is disabled until the date matches what the
            // server accepts, so say what the format is.
            <Text style={styles.originWarn}>
              Use the YYYY-MM-DD format, e.g. {localTodayISO()}.
            </Text>
          )}
        </FormSection>

        <FormSection title="Trip name (optional)">
          <FormTextInput
            value={name}
            onChangeText={setName}
            placeholder="e.g. Downtown afternoon run"
          />
        </FormSection>

        {/* Directive: the review screen carries full context — the operator
            should never need to remember what they picked on a prior screen. */}
        <FormSection title="Summary">
          <Text style={styles.summaryLine}>
            Origin:{" "}
            {originTab === "Depot"
              ? (routeSettings?.depotAddress ?? "Tenant depot (not set)")
              : originTab === "Driver"
                ? driverName
                  ? `${driverName}'s home base`
                  : "Choose a driver"
                : addrLine1.trim()
                  ? [addrLine1, addrCity, addrState, addrZip].filter(Boolean).join(", ")
                  : "Enter an address"}
          </Text>
          <Text style={styles.summaryLine}>Driver: {driverName ?? "Unassigned"}</Text>
          <Text style={styles.summaryLine}>Date: {date || "Not set"}</Text>
        </FormSection>
      </ScrollView>

      {/* Footer CTA — in-flow sibling below the ScrollView, already above the
          persistent operator tab bar (see the orders-list bulk bar comment
          for why no extra safe-area math is needed here). */}
      <View style={styles.footer}>
        <Pressable
          style={[styles.submitBtn, !canSubmit && styles.submitBtnDisabled]}
          disabled={!canSubmit}
          onPress={handleCreateTrip}
        >
          {submitting ? (
            <ActivityIndicator color="#fff" size="small" />
          ) : (
            <Text style={styles.submitBtnText} numberOfLines={1}>
              {ctaLabel}
            </Text>
          )}
        </Pressable>
      </View>
    </SafeAreaView>
  );
}

function TripStopRow({
  index,
  group,
  orderNumberById,
  onDrop,
}: {
  index: number;
  group: TripStopGroup;
  orderNumberById: Map<string, string | null>;
  /** Omitted once the trip exists — its stops are server truth by then. */
  onDrop?: () => void;
}) {
  const orderLabels = group.orderIds.map((id) => orderNumberById.get(id) ?? id);
  const row = (
    <View style={styles.stopRow}>
      <View style={styles.stopNumBadge}>
        <Text style={styles.stopNumText}>{index}</Text>
      </View>
      <View style={{ flex: 1, minWidth: 0 }}>
        <Text style={styles.stopName} numberOfLines={1}>
          {group.customerName ?? "Unknown customer"}
        </Text>
        <Text style={styles.stopSub} numberOfLines={2}>
          {group.orderIds.length} order{group.orderIds.length === 1 ? "" : "s"}:{" "}
          {orderLabels.join(", ")}
        </Text>
      </View>
    </View>
  );
  if (!onDrop) return row;
  return (
    <Swipeable
      overshootRight={false}
      renderRightActions={() => (
        <Pressable style={styles.dropAction} onPress={onDrop}>
          <Ionicons name="trash-outline" size={18} color="#fff" />
          <Text style={styles.dropActionText}>Remove</Text>
        </Pressable>
      )}
    >
      {row}
    </Swipeable>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: ios.bg },
  emptyHint: { fontSize: 13, fontFamily: "Inter_400Regular", color: ios.label2 },
  swipeHint: { fontSize: 12, fontFamily: "Inter_400Regular", color: ios.label3 },
  stopRow: {
    backgroundColor: ios.bgElev,
    borderRadius: 14,
    padding: 12,
    paddingHorizontal: 14,
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    minHeight: ios.rowMinH,
  },
  stopNumBadge: {
    width: 26,
    height: 26,
    borderRadius: 999,
    backgroundColor: ios.brand,
    alignItems: "center",
    justifyContent: "center",
  },
  stopNumText: { color: "#fff", fontSize: 13, fontFamily: "Inter_700Bold" },
  stopName: {
    fontSize: 15,
    fontFamily: "Inter_600SemiBold",
    color: ios.label,
    letterSpacing: -0.2,
  },
  stopSub: { fontSize: 12, fontFamily: "Inter_400Regular", color: ios.label2, marginTop: 2 },
  dropAction: {
    width: 88,
    marginLeft: 8,
    borderRadius: 14,
    backgroundColor: ios.system.red,
    alignItems: "center",
    justifyContent: "center",
    gap: 2,
  },
  dropActionText: { color: "#fff", fontSize: 12, fontFamily: "Inter_600SemiBold" },
  skippedRow: {
    flexDirection: "row",
    alignItems: "flex-start",
    gap: 8,
    backgroundColor: ios.system.orangeWash,
    borderRadius: 12,
    padding: 10,
    paddingHorizontal: 12,
  },
  skippedTitle: { fontSize: 13, fontFamily: "Inter_600SemiBold", color: ios.label },
  skippedReason: {
    fontSize: 12,
    fontFamily: "Inter_400Regular",
    color: ios.system.orangeInk,
    marginTop: 1,
  },
  originHint: { fontSize: 13, fontFamily: "Inter_400Regular", color: ios.label2, marginTop: 8 },
  originWarn: {
    fontSize: 13,
    fontFamily: "Inter_500Medium",
    color: ios.system.orangeInk,
    marginTop: 8,
  },
  originLink: {
    fontSize: 13,
    fontFamily: "Inter_500Medium",
    color: ios.brand,
    marginTop: 4,
  },
  driverOption: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    paddingVertical: 10,
    paddingHorizontal: 12,
    borderRadius: 12,
    backgroundColor: ios.fill3,
    minHeight: ios.rowMinH,
  },
  driverOptionActive: { backgroundColor: ios.brandWash },
  driverOptionText: { fontSize: 14, fontFamily: "Inter_500Medium", color: ios.label },
  summaryLine: { fontSize: 13, fontFamily: "Inter_400Regular", color: ios.label2, marginTop: 4 },
  footer: {
    paddingHorizontal: 16,
    paddingTop: 10,
    paddingBottom: 16,
    backgroundColor: ios.bgElev,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: ios.separator,
  },
  submitBtn: {
    minHeight: ios.rowMinH,
    backgroundColor: ios.brand,
    borderRadius: 14,
    alignItems: "center",
    justifyContent: "center",
    paddingHorizontal: 16,
  },
  submitBtnDisabled: { opacity: 0.4 },
  submitBtnText: { color: "#fff", fontSize: 15, fontFamily: "Inter_600SemiBold" },
});
