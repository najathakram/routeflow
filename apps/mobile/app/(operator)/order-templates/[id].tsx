import { ActivityIndicator, Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { Ionicons } from "@expo/vector-icons";
import { useLocalSearchParams, useRouter } from "expo-router";
import { ios } from "@routeflow/ui/tokens";
import { NavBackButton, NavBar, Pill } from "@routeflow/ui/mobile/ios";
import {
  useDeleteOrderTemplate,
  useGenerateTemplateOrder,
  useOrderTemplate,
  useUpdateOrderTemplate,
} from "../../../lib/api/order-templates";
import {
  daysLabel,
  orderTemplateActionFlags,
  orderTemplatePillFor,
} from "../../../lib/order-templates-logic";
import { showToast } from "../../../lib/toast";
import { confirm } from "../../../lib/confirm";

const onErr = (e: any) => showToast(e?.response?.data?.message ?? e?.message ?? "Try again.");

export default function OrderTemplateDetailScreen() {
  const router = useRouter();
  const { id } = useLocalSearchParams<{ id: string }>();

  const { data: template, isLoading, refetch } = useOrderTemplate(id ?? "");
  const genMut = useGenerateTemplateOrder();
  const updateMut = useUpdateOrderTemplate();
  const deleteMut = useDeleteOrderTemplate();

  if (isLoading || !template) {
    return (
      <SafeAreaView style={styles.safe} edges={["top", "left", "right"]}>
        <NavBar
          inlineTitle="Template"
          leading={<NavBackButton label="Templates" onPress={() => router.back()} />}
        />
        <View style={styles.center}>
          <ActivityIndicator color={ios.brand} />
        </View>
      </SafeAreaView>
    );
  }

  const s = orderTemplatePillFor(template.isActive);
  const flags = orderTemplateActionFlags(template.isActive);

  const handleGenerate = () => {
    if (!id) return;
    confirm(
      "Generate order now?",
      "Creates a pending order for this customer from the template.",
      () =>
        genMut.mutate(id, {
          onSuccess: (order) => {
            showToast("Order created");
            // generate returns the created (or merged-winner) ORDER keyed `id`.
            router.push(`/(operator)/orders/${order.id}`);
          },
          onError: onErr,
        }),
      { confirmText: "Generate" },
    );
  };

  const handlePause = () => {
    if (!id) return;
    confirm(
      "Pause template?",
      "The daily auto-generation won't run until you resume it.",
      () =>
        updateMut.mutate(
          { id, isActive: false },
          {
            onSuccess: () => {
              showToast("Template paused");
              refetch();
            },
            onError: onErr,
          },
        ),
      { confirmText: "Pause", destructive: true },
    );
  };

  const handleResume = () => {
    if (!id) return;
    updateMut.mutate(
      { id, isActive: true },
      {
        onSuccess: () => {
          showToast("Template resumed");
          refetch();
        },
        onError: onErr,
      },
    );
  };

  const handleDelete = () => {
    if (!id) return;
    confirm(
      "Delete this template?",
      "This can't be undone.",
      () =>
        deleteMut.mutate(id, {
          onSuccess: () => {
            showToast("Template deleted");
            router.back();
          },
          onError: onErr,
        }),
      { confirmText: "Delete", destructive: true },
    );
  };

  return (
    <SafeAreaView style={styles.safe} edges={["top", "left", "right"]}>
      <NavBar
        inlineTitle={template.name}
        leading={<NavBackButton label="Templates" onPress={() => router.back()} />}
      />

      <ScrollView showsVerticalScrollIndicator={false}>
        <View style={{ padding: 16, gap: 14 }}>
          {/* Header / schedule */}
          <View style={styles.card}>
            <Pill variant={s.variant} dot>
              {s.label}
            </Pill>
            <Text style={styles.customer}>{template.customer?.businessName ?? "Customer"}</Text>
            <Text style={styles.schedule}>{daysLabel(template.daysOfWeek)}</Text>
            {template.notes ? <Text style={styles.dates}>{template.notes}</Text> : null}
          </View>

          {/* Actions — Generate now (always), Pause (active) / Resume (paused), Delete */}
          <View style={styles.actionsGrid}>
            {flags.canGenerate ? (
              <ActionTile
                icon="flash-outline"
                label={genMut.isPending ? "Generating…" : "Generate now"}
                onPress={handleGenerate}
              />
            ) : null}
            {flags.canPause ? (
              <ActionTile
                icon="pause-circle-outline"
                label="Pause"
                tone="danger"
                onPress={handlePause}
              />
            ) : null}
            {flags.canActivate ? (
              <ActionTile
                icon="play-circle-outline"
                label={updateMut.isPending ? "Resuming…" : "Resume"}
                onPress={handleResume}
              />
            ) : null}
            <ActionTile icon="trash-outline" label="Delete" tone="danger" onPress={handleDelete} />
          </View>

          {/* Template line items — qty × product; NO price (items carry no money) */}
          {template.items && template.items.length > 0 ? (
            <View style={styles.card}>
              <Text style={styles.cardTitle}>Ordered each run</Text>
              {template.items.map((it, i) => (
                <View
                  key={it.id}
                  style={[
                    styles.itemRow,
                    i > 0 && {
                      borderTopWidth: StyleSheet.hairlineWidth,
                      borderTopColor: ios.separator,
                    },
                  ]}
                >
                  <View style={{ flex: 1, minWidth: 0 }}>
                    <Text style={styles.itemName} numberOfLines={1}>
                      {it.product?.name ?? it.productId}
                    </Text>
                    {it.notes ? (
                      <Text style={styles.itemNote} numberOfLines={1}>
                        {it.notes}
                      </Text>
                    ) : null}
                  </View>
                  <Text style={styles.itemSub}>
                    {it.qty}
                    {it.product?.unit ? ` ${it.product.unit}` : ""}
                  </Text>
                </View>
              ))}
            </View>
          ) : null}
        </View>
        <View style={{ height: 24 }} />
      </ScrollView>
    </SafeAreaView>
  );
}

function ActionTile({
  icon,
  label,
  onPress,
  tone = "default",
}: {
  icon: keyof typeof Ionicons.glyphMap;
  label: string;
  onPress: () => void;
  tone?: "default" | "danger";
}) {
  const isDanger = tone === "danger";
  return (
    <Pressable style={[styles.tile, isDanger && styles.tileDanger]} onPress={onPress}>
      <Ionicons name={icon} size={22} color={isDanger ? ios.system.red : ios.brand} />
      <Text style={[styles.tileLabel, isDanger && { color: ios.system.red }]}>{label}</Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: ios.bg },
  center: { padding: 40, alignItems: "center" },
  card: { backgroundColor: ios.bgElev, borderRadius: 14, padding: 14 },
  cardTitle: { fontSize: 15, fontFamily: "Inter_600SemiBold", color: ios.label, marginBottom: 8 },
  customer: { fontSize: 15, fontFamily: "Inter_600SemiBold", color: ios.label, marginTop: 8 },
  schedule: {
    fontSize: 22,
    fontFamily: "Inter_700Bold",
    color: ios.label,
    marginTop: 6,
    letterSpacing: -0.4,
  },
  dates: { fontSize: 12, fontFamily: "Inter_400Regular", color: ios.label2, marginTop: 4 },
  actionsGrid: { flexDirection: "row", flexWrap: "wrap", gap: 10 },
  tile: {
    flexBasis: "47%",
    flexGrow: 1,
    backgroundColor: ios.bgElev,
    borderRadius: 14,
    padding: 18,
    alignItems: "center",
    gap: 8,
  },
  tileDanger: { backgroundColor: ios.system.redWash },
  tileLabel: {
    fontSize: 13,
    fontFamily: "Inter_600SemiBold",
    color: ios.label,
    textAlign: "center",
  },
  itemRow: { flexDirection: "row", alignItems: "center", paddingVertical: 8, gap: 10 },
  itemName: { fontSize: 14, fontFamily: "Inter_500Medium", color: ios.label },
  itemNote: { fontSize: 12, fontFamily: "Inter_400Regular", color: ios.label2, marginTop: 2 },
  itemSub: {
    fontSize: 13,
    fontFamily: "Inter_500Medium",
    color: ios.label2,
    fontVariant: ["tabular-nums"],
  },
});
