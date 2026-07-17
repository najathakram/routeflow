import { useMemo } from "react";
import {
  ActivityIndicator,
  Linking,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from "react-native";
import { showToast } from "../../../../../lib/toast";
import { confirm } from "../../../../../lib/confirm";
import { SafeAreaView } from "react-native-safe-area-context";
import { LinearGradient } from "expo-linear-gradient";
import { Ionicons } from "@expo/vector-icons";
import { useLocalSearchParams, useRouter } from "expo-router";
import { ios } from "@routeflow/ui/tokens";
import { ListGroup, NavAction, NavBackButton, NavBar, Pill } from "@routeflow/ui/mobile/ios";
import {
  useActiveRouteRun,
  useRouteRun,
  IDENTITY_TYPES,
  IDENTITY_TYPE_LABELS,
  type RouteRunStop,
} from "../../../../../lib/api/routes";
import { usePodStore } from "../../../../../store/podStore";
import { openInMaps } from "../../../../../components/openInMaps";

function initialsFrom(name: string): string {
  return (
    name
      .split(/\s+/)
      .filter(Boolean)
      .slice(0, 2)
      .map((w) => w[0]?.toUpperCase() ?? "")
      .join("") || "?"
  );
}

function itemsFromStop(stop: RouteRunStop): Array<{
  id: string;
  name: string;
  sku: string;
  qty: number;
  delivered: boolean;
  short: boolean;
}> {
  const lines: ReturnType<typeof itemsFromStop> = [];
  for (const order of stop.orders ?? []) {
    for (const li of order.lineItems ?? []) {
      lines.push({
        id: li.id,
        name: li.product?.name ?? "Item",
        sku: li.product ? `${li.product.unit ?? ""}${li.product.name ? "" : ""}` : "",
        qty: Number(li.qty ?? 0),
        delivered: li.status === "DELIVERED",
        short: li.status === "PARTIAL" || li.status === "REFUSED",
      });
    }
  }
  return lines;
}

export default function StopDetailScreen() {
  const router = useRouter();
  const params = useLocalSearchParams<{ stopId: string; runId?: string }>();
  const stopId = params.stopId;

  // runId is optional in the URL — derive from the active route run otherwise.
  const { data: activeData, isLoading: activeLoading } = useActiveRouteRun();
  const runIdFromActive = activeData?.data?.[0]?.id;
  const runId = params.runId ?? runIdFromActive;
  const { data: run, isLoading: runLoading } = useRouteRun(runId ?? "");

  const stop = useMemo(() => run?.stops?.find((s) => s.id === stopId), [run, stopId]);
  const pod = usePodStore((s) => s.pods[stopId ?? ""] ?? undefined);
  const setRegulated = usePodStore((s) => s.setRegulated);

  if (activeLoading || runLoading) {
    return (
      <SafeAreaView style={styles.safe} edges={["top", "left", "right"]}>
        <NavBar
          inlineTitle="Stop"
          leading={
            <NavBackButton label="Route" onPress={() => router.replace("/(driver)/route" as any)} />
          }
        />
        <View style={styles.center}>
          <ActivityIndicator color={ios.brand} />
        </View>
      </SafeAreaView>
    );
  }

  if (!stop) {
    return (
      <SafeAreaView style={styles.safe} edges={["top", "left", "right"]}>
        <NavBar
          inlineTitle="Stop"
          leading={
            <NavBackButton label="Route" onPress={() => router.replace("/(driver)/route" as any)} />
          }
        />
        <View style={styles.center}>
          <Ionicons name="alert-circle-outline" size={36} color={ios.label3} />
          <Text style={styles.emptyTitle}>Stop not found</Text>
          <Text style={styles.emptySub}>It may have been removed from your route.</Text>
        </View>
      </SafeAreaView>
    );
  }

  const totalStops = run?.stops?.length ?? 0;
  const customerName = stop.customer?.businessName ?? "Stop";
  const phone = stop.customer?.phone?.trim();
  const address = [
    stop.customerAddress?.line1,
    stop.customerAddress?.city,
    stop.customerAddress?.state,
    stop.customerAddress?.zip,
  ]
    .filter(Boolean)
    .join(", ");

  const openTel = () => {
    if (!phone) {
      showToast("This customer doesn't have a phone on file.");
      return;
    }
    Linking.openURL(`tel:${phone.replace(/[^0-9+]/g, "")}`).catch(() => {});
  };
  const openSms = () => {
    if (!phone) {
      showToast("This customer doesn't have a phone on file.");
      return;
    }
    const sep = Platform.OS === "ios" ? "&" : "?";
    Linking.openURL(`sms:${phone.replace(/[^0-9+]/g, "")}${sep}body=`).catch(() => {});
  };
  const openMaps = () => {
    if (!address) {
      showToast("This stop doesn't have an address on file.");
      return;
    }
    // Pass the business name + address so Google/Apple Maps can match the
    // actual place listing (with photo, hours, phone) instead of dropping
    // a generic pin at the coordinates.
    openInMaps({
      address,
      lat: stop.customerAddress?.lat,
      lng: stop.customerAddress?.lng,
      label: customerName,
    });
  };
  const photoCount = pod?.photoUrls?.length ?? 0;
  const hasSig = !!pod?.signatureUri;
  const hasNote = !!pod?.note;
  // NEW-m1-1: memoize items so itemsFromStop is not called on every render.
  // Without this, tapping any checkbox on a DELIVERED stop triggers
  // React error #185 (max update depth exceeded) because itemsFromStop
  // returns a new array reference on each render cycle, causing downstream
  // effects that depend on `items` to re-run indefinitely.
  const items = useMemo(() => itemsFromStop(stop), [stop]);
  const itemCount = items.length;
  // R1e: the stop's order for the direct "Edit items" flow. A stop usually has one
  // order (a delivery); a consolidated multi-order stop edits the first.
  const editOrderId = stop.orders?.[0]?.id;
  const dollarTotal = (stop.orders ?? []).reduce(
    (sum, o) =>
      sum +
      (o.lineItems ?? []).reduce((s, li) => s + Number(li.qty ?? 0) * Number(li.unitPrice ?? 0), 0),
    0,
  );

  return (
    <SafeAreaView style={styles.safe} edges={["top", "left", "right"]}>
      <NavBar
        inlineTitle={`Stop ${stop.stopNumber} / ${totalStops}`}
        leading={
          <NavBackButton label="Route" onPress={() => router.replace("/(driver)/route" as any)} />
        }
        trailing={<NavAction label="Call" onPress={openTel} />}
      />

      <ScrollView showsVerticalScrollIndicator={false}>
        <View style={styles.custCard}>
          <View style={styles.custRow}>
            <LinearGradient
              colors={[ios.brandGradient[0]!, ios.brandGradient[1]!, ios.brandGradient[2]!]}
              start={{ x: 0, y: 0 }}
              end={{ x: 1, y: 1 }}
              style={styles.avatar}
            >
              <Text style={styles.avatarText}>{initialsFrom(customerName)}</Text>
            </LinearGradient>
            <View style={{ flex: 1 }}>
              <Text style={styles.custName}>{customerName}</Text>
              {address ? <Text style={styles.custAddr}>{address}</Text> : null}
              <View style={styles.pillRow}>
                <Pill variant="brand">
                  {itemCount} item{itemCount === 1 ? "" : "s"}
                </Pill>
                {dollarTotal > 0 ? (
                  <Pill variant="orange">${dollarTotal.toFixed(2)} due</Pill>
                ) : null}
              </View>
            </View>
          </View>
          <View style={styles.quickActions}>
            <QuickAction icon="call-outline" label="Call" onPress={openTel} />
            <QuickAction icon="chatbubble-outline" label="Text" onPress={openSms} />
            <QuickAction icon="location-outline" label="Directions" onPress={openMaps} />
          </View>
        </View>

        <SectionRow title="Items" />
        {items.length === 0 ? (
          <View style={styles.emptyInline}>
            <Text style={styles.emptyInlineText}>No items scheduled for this stop.</Text>
          </View>
        ) : (
          <ListGroup>
            {items.map((i) => (
              <View key={i.id} style={styles.itemRow}>
                <View
                  style={[
                    styles.check,
                    i.delivered ? { backgroundColor: ios.system.green, borderWidth: 0 } : null,
                  ]}
                >
                  {i.delivered ? <Ionicons name="checkmark" size={13} color="#fff" /> : null}
                </View>
                <View style={{ flex: 1 }}>
                  <Text style={styles.itemName}>{i.name}</Text>
                </View>
                {i.short ? (
                  <View style={{ marginRight: 8 }}>
                    <Pill variant="orange" small>
                      Short
                    </Pill>
                  </View>
                ) : null}
                <View style={styles.qtyBadge}>
                  <Text style={styles.qtyText}>×{i.qty}</Text>
                </View>
              </View>
            ))}
          </ListGroup>
        )}

        <SectionRow title="Proof of delivery" />
        <View style={styles.podRow}>
          <PodTile
            icon="camera-outline"
            label={photoCount > 0 ? `Photo · ${photoCount}` : "Photo"}
            captured={photoCount > 0}
            onPress={() => router.push(`/route/stop/${stopId}/photo`)}
          />
          <PodTile
            icon="create-outline"
            label={hasSig ? "Signature ✓" : "Signature"}
            captured={hasSig}
            onPress={() => router.push(`/route/stop/${stopId}/signature`)}
          />
          <PodTile
            icon="chatbubble-outline"
            label={hasNote ? "Note ✓" : "Note"}
            captured={hasNote}
            onPress={() => router.push(`/route/stop/${stopId}/note`)}
          />
        </View>

        {/* Phase 4 (W7b): regulated-delivery age / identity capture */}
        {stop.ageCheckRequired || stop.identityCheckRequired ? (
          <>
            <SectionRow title="Age & identity" />
            <View style={styles.regBanner}>
              <Ionicons name="shield-checkmark-outline" size={16} color="#B45309" />
              <Text style={styles.regBannerText}>
                Regulated delivery — hand to a verified recipient with a signature (no
                leave-at-door).
              </Text>
            </View>
            {stop.ageCheckRequired ? (
              <CheckRow
                label="Recipient meets the minimum age"
                checked={!!pod?.ageVerified}
                onToggle={() => setRegulated(stopId, { ageVerified: !pod?.ageVerified })}
              />
            ) : null}
            {stop.identityCheckRequired ? (
              <CheckRow
                label="Recipient's ID checked"
                checked={!!pod?.identityVerified}
                onToggle={() =>
                  setRegulated(stopId, {
                    identityVerified: !pod?.identityVerified,
                    // clearing the check also clears the recorded ID type
                    ...(pod?.identityVerified ? { identityType: null } : {}),
                  })
                }
              />
            ) : null}
            {stop.identityCheckRequired && pod?.identityVerified ? (
              <View style={styles.idTypeRow}>
                {IDENTITY_TYPES.map((t) => (
                  <Pressable
                    key={t}
                    onPress={() => setRegulated(stopId, { identityType: t })}
                    style={[styles.idTypePill, pod?.identityType === t && styles.idTypePillActive]}
                  >
                    <Text
                      style={[
                        styles.idTypePillText,
                        pod?.identityType === t && styles.idTypePillTextActive,
                      ]}
                    >
                      {IDENTITY_TYPE_LABELS[t]}
                    </Text>
                  </Pressable>
                ))}
              </View>
            ) : null}
          </>
        ) : null}

        <View style={styles.actionsBlock}>
          <View style={styles.actionBtnRow}>
            <SecondaryBtn
              label="Skip stop"
              onPress={() =>
                confirm(
                  "Skip stop",
                  "Mark this stop as skipped? You can reopen it later.",
                  () => router.replace("/(driver)/route" as any),
                  { confirmText: "Skip", destructive: true },
                )
              }
            />
            <SecondaryBtn
              label="Partial return"
              onPress={() => router.push(`/route/stop/${stopId}/return`)}
            />
          </View>
          {/* P10-POS-3: at-the-door actions — reachable in exactly one tap from
              here (satisfies "≤2 taps deep" together with each destination
              screen's own Save). "Adjust order" drives the P5-09 change-request
              engine; "New order at door" links the previously-orphaned
              new-order.tsx. "Collect payment" needs no tile of its own — the
              green button below already is the prefilled collect-payment action. */}
          <View style={styles.actionBtnRow}>
            {items.length > 0 ? (
              <SecondaryBtn
                label="Adjust order"
                onPress={() => router.push(`/route/stop/${stopId}/adjust`)}
              />
            ) : null}
            <SecondaryBtn
              label="New order at door"
              onPress={() => router.push(`/route/stop/${stopId}/new-order`)}
            />
          </View>
          {/* R1e: direct order editing at the stop — add / update / remove items
              (updateOrderItems, list-priced for drivers). Works at every live stage
              incl. out-for-delivery / delivered; the invoice + ledger re-sync. */}
          {editOrderId ? (
            <SecondaryBtn
              label="Edit items"
              onPress={() => router.push(`/route/stop/${stopId}/edit-items?orderId=${editOrderId}`)}
            />
          ) : null}
          {/* Optional split-invoice flow: lets the driver issue 2+ invoices for the
              stop's order(s), each with its own due date. After splitting, the
              auto-invoice on stop completion sees fully-invoiced items and skips. */}
          <SecondaryBtn
            label="Split into invoices…"
            onPress={() => router.push(`/route/stop/${stopId}/split-invoice`)}
          />
          <Pressable
            style={styles.greenBtn}
            onPress={() => router.push(`/route/stop/${stopId}/short-pick`)}
          >
            <Text style={styles.greenBtnText}>Complete & collect →</Text>
          </Pressable>
        </View>
        <View style={{ height: 20 }} />
      </ScrollView>
    </SafeAreaView>
  );
}

function QuickAction({
  icon,
  label,
  onPress,
}: {
  icon: keyof typeof Ionicons.glyphMap;
  label: string;
  onPress?: () => void;
}) {
  return (
    <Pressable style={styles.qa} onPress={onPress}>
      <Ionicons name={icon} size={15} color={ios.label} />
      <Text style={styles.qaLabel}>{label}</Text>
    </Pressable>
  );
}

function PodTile({
  icon,
  label,
  onPress,
  captured,
}: {
  icon: keyof typeof Ionicons.glyphMap;
  label: string;
  onPress?: () => void;
  captured?: boolean;
}) {
  return (
    <Pressable style={[styles.podTile, captured && styles.podTileCaptured]} onPress={onPress}>
      <Ionicons name={icon} size={22} color={captured ? ios.brand : ios.label2} />
      <Text style={[styles.podTileLabel, captured && { color: ios.brand }]}>{label}</Text>
    </Pressable>
  );
}

function SectionRow({ title }: { title: string }) {
  return (
    <View style={styles.sectionRow}>
      <Text style={styles.sectionTitle}>{title}</Text>
    </View>
  );
}

function SecondaryBtn({ label, onPress }: { label: string; onPress?: () => void }) {
  return (
    <Pressable onPress={onPress} style={styles.secondaryBtn}>
      <Text style={styles.secondaryBtnText}>{label}</Text>
    </Pressable>
  );
}

function CheckRow({
  label,
  checked,
  onToggle,
}: {
  label: string;
  checked: boolean;
  onToggle: () => void;
}) {
  return (
    <Pressable onPress={onToggle} style={styles.checkRow}>
      <View style={[styles.checkBox, checked && styles.checkBoxOn]}>
        {checked ? <Ionicons name="checkmark" size={14} color="#fff" /> : null}
      </View>
      <Text style={styles.checkRowLabel}>{label}</Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: ios.bgElev },
  regBanner: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    marginHorizontal: 16,
    padding: 12,
    borderRadius: 12,
    backgroundColor: "#FEF3C7",
    borderWidth: 1,
    borderColor: "#FCD34D",
  },
  regBannerText: { flex: 1, fontSize: 13, fontFamily: "Inter_500Medium", color: "#92400E" },
  checkRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
    marginHorizontal: 16,
    marginTop: 8,
    paddingVertical: 12,
    paddingHorizontal: 14,
    backgroundColor: ios.bgElev,
    borderRadius: 12,
  },
  checkBox: {
    width: 24,
    height: 24,
    borderRadius: 6,
    borderWidth: 2,
    borderColor: ios.gray[3],
    alignItems: "center",
    justifyContent: "center",
  },
  checkBoxOn: { backgroundColor: ios.system.green, borderColor: ios.system.green },
  checkRowLabel: { flex: 1, fontSize: 15, fontFamily: "Inter_500Medium", color: ios.label },
  idTypeRow: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: 8,
    marginHorizontal: 16,
    marginTop: 8,
  },
  idTypePill: {
    borderRadius: 20,
    borderWidth: 1,
    borderColor: ios.separator,
    backgroundColor: ios.bgElev,
    paddingHorizontal: 12,
    paddingVertical: 6,
  },
  idTypePillActive: { backgroundColor: ios.brand, borderColor: ios.brand },
  idTypePillText: { fontSize: 13, fontFamily: "Inter_500Medium", color: ios.label2 },
  idTypePillTextActive: { color: "#fff" },
  center: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    gap: 8,
    paddingHorizontal: 40,
  },
  emptyTitle: {
    fontSize: 17,
    fontFamily: "Inter_600SemiBold",
    color: ios.label,
    marginTop: 6,
  },
  emptySub: {
    fontSize: 14,
    fontFamily: "Inter_400Regular",
    color: ios.label2,
    textAlign: "center",
  },
  custCard: {
    backgroundColor: ios.bgElev,
    paddingHorizontal: 16,
    paddingTop: 16,
    paddingBottom: 18,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: ios.separator,
  },
  custRow: { flexDirection: "row", gap: 12, alignItems: "flex-start" },
  avatar: {
    width: 52,
    height: 52,
    borderRadius: 14,
    alignItems: "center",
    justifyContent: "center",
  },
  avatarText: {
    color: "#fff",
    fontSize: 18,
    fontFamily: "Inter_700Bold",
    letterSpacing: -0.5,
  },
  custName: {
    fontSize: 22,
    fontFamily: "Inter_700Bold",
    color: ios.label,
    letterSpacing: -0.4,
  },
  custAddr: {
    fontSize: 14,
    fontFamily: "Inter_400Regular",
    color: ios.label2,
    marginTop: 2,
  },
  pillRow: { flexDirection: "row", gap: 6, marginTop: 8, flexWrap: "wrap" },
  quickActions: { flexDirection: "row", gap: 6, marginTop: 14 },
  qa: {
    flex: 1,
    padding: 10,
    backgroundColor: ios.fill3,
    borderRadius: 10,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 6,
  },
  qaLabel: { fontSize: 13, fontFamily: "Inter_600SemiBold", color: ios.label },
  sectionRow: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "baseline",
    paddingHorizontal: 20,
    paddingTop: 20,
    paddingBottom: 8,
  },
  sectionTitle: {
    fontSize: 17,
    fontFamily: "Inter_700Bold",
    color: ios.label,
    letterSpacing: -0.3,
  },
  emptyInline: {
    marginHorizontal: 16,
    paddingVertical: 12,
    paddingHorizontal: 14,
    backgroundColor: ios.bgElev,
    borderRadius: 12,
  },
  emptyInlineText: {
    fontSize: 14,
    fontFamily: "Inter_400Regular",
    color: ios.label2,
    textAlign: "center",
  },
  itemRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 14,
    paddingHorizontal: 16,
    paddingVertical: 11,
    backgroundColor: ios.bgElev,
    minHeight: 44,
  },
  check: {
    width: 26,
    height: 26,
    borderRadius: 999,
    borderWidth: 2,
    borderColor: ios.gray[3],
    alignItems: "center",
    justifyContent: "center",
  },
  itemName: { fontSize: 16, fontFamily: "Inter_500Medium", color: ios.label },
  qtyBadge: {
    backgroundColor: ios.brandWash,
    borderRadius: 8,
    paddingHorizontal: 10,
    paddingVertical: 4,
  },
  qtyText: {
    color: ios.brand,
    fontSize: 14,
    fontFamily: "Inter_700Bold",
    fontVariant: ["tabular-nums"],
  },
  podRow: { paddingHorizontal: 16, flexDirection: "row", gap: 10 },
  podTile: {
    flex: 1,
    height: 96,
    backgroundColor: ios.fill3,
    borderWidth: 1.5,
    borderStyle: "dashed",
    borderColor: ios.gray[3],
    borderRadius: 14,
    alignItems: "center",
    justifyContent: "center",
    gap: 6,
  },
  podTileLabel: { fontSize: 12, fontFamily: "Inter_500Medium", color: ios.label2 },
  podTileCaptured: {
    backgroundColor: ios.brandWash,
    borderColor: ios.brand,
    borderStyle: "solid",
  },
  actionsBlock: { padding: 16, gap: 8 },
  actionBtnRow: { flexDirection: "row", gap: 10 },
  secondaryBtn: {
    flex: 1,
    backgroundColor: ios.fill2,
    borderRadius: 10,
    paddingVertical: 12,
    alignItems: "center",
  },
  secondaryBtnText: {
    color: ios.brand,
    fontSize: 14,
    fontFamily: "Inter_600SemiBold",
  },
  greenBtn: {
    backgroundColor: ios.system.green,
    borderRadius: 14,
    paddingVertical: 16,
    alignItems: "center",
  },
  greenBtnText: {
    color: "#fff",
    fontSize: 17,
    fontFamily: "Inter_600SemiBold",
    letterSpacing: -0.2,
  },
});
