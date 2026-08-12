/**
 * Standing orders for ONE customer — the mobile mirror of web's
 * customers/[id] "standing-orders" tab. Rows tap through to the existing
 * order-templates detail screen (generate/pause/delete live there — one
 * affordance per action); the header "+" opens the create form.
 */
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
import { useLocalSearchParams, useRouter } from "expo-router";
import { ios } from "@routeflow/ui/tokens";
import { NavAction, NavBackButton, NavBar, Pill } from "@routeflow/ui/mobile/ios";
import { useOrderTemplates, type OrderTemplate } from "../../../../../lib/api/order-templates";
import { daysLabel, orderTemplatePillFor } from "../../../../../lib/order-templates-logic";

export default function CustomerStandingOrdersScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const router = useRouter();
  const { data, isLoading, isFetching, refetch, isError } = useOrderTemplates(id);
  const templates = data ?? [];

  return (
    <SafeAreaView style={styles.safe} edges={["top", "left", "right"]}>
      <NavBar
        inlineTitle="Standing orders"
        leading={<NavBackButton label="Back" onPress={() => router.back()} />}
        trailing={
          <NavAction
            label="Add"
            bold
            onPress={() => router.push(`/(operator)/customers/${id}/standing-orders/new`)}
          />
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
        ) : isError ? (
          <View style={styles.center}>
            <Text style={styles.empty}>Couldn&apos;t load standing orders. Pull to retry.</Text>
          </View>
        ) : templates.length === 0 ? (
          <View style={styles.center}>
            <Text style={styles.empty}>No standing orders for this customer yet.</Text>
            <Pressable
              style={styles.emptyCta}
              onPress={() => router.push(`/(operator)/customers/${id}/standing-orders/new`)}
            >
              <Text style={styles.emptyCtaText}>Add the first one</Text>
            </Pressable>
          </View>
        ) : (
          <View style={{ paddingHorizontal: 16, gap: 8, paddingBottom: 24, paddingTop: 8 }}>
            {templates.map((t) => (
              <Row
                key={t.id}
                template={t}
                onPress={() => router.push(`/(operator)/order-templates/${t.id}`)}
              />
            ))}
          </View>
        )}
      </ScrollView>
    </SafeAreaView>
  );
}

function Row({ template, onPress }: { template: OrderTemplate; onPress: () => void }) {
  const s = orderTemplatePillFor(template.isActive);
  const itemCount = template.items?.length ?? 0;
  return (
    <Pressable style={styles.row} onPress={onPress}>
      <View style={styles.rowHead}>
        <Text style={styles.title} numberOfLines={1}>
          {template.name}
        </Text>
        <Pill variant={s.variant} dot>
          {s.label}
        </Pill>
      </View>
      <View style={styles.rowFoot}>
        <Text style={styles.days}>{daysLabel(template.daysOfWeek)}</Text>
        <Text style={styles.meta}>
          · {itemCount} item{itemCount === 1 ? "" : "s"}
        </Text>
      </View>
      {template.notes ? (
        <Text style={styles.notes} numberOfLines={1}>
          {template.notes}
        </Text>
      ) : null}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: ios.bg },
  center: { padding: 40, alignItems: "center", gap: 12 },
  empty: { fontSize: 14, fontFamily: "Inter_400Regular", color: ios.label2, textAlign: "center" },
  emptyCta: {
    backgroundColor: ios.brand,
    borderRadius: 10,
    paddingHorizontal: 16,
    paddingVertical: 10,
  },
  emptyCtaText: { fontSize: 14, fontFamily: "Inter_600SemiBold", color: "#fff" },
  row: { backgroundColor: ios.bgElev, borderRadius: 12, padding: 14 },
  rowHead: { flexDirection: "row", alignItems: "center", gap: 10 },
  title: {
    flex: 1,
    minWidth: 0,
    fontSize: 15,
    fontFamily: "Inter_600SemiBold",
    color: ios.label,
    letterSpacing: -0.2,
  },
  rowFoot: { marginTop: 8, flexDirection: "row", alignItems: "baseline", gap: 6 },
  days: { fontSize: 13, fontFamily: "Inter_600SemiBold", color: ios.label },
  meta: { fontSize: 12, fontFamily: "Inter_400Regular", color: ios.label2 },
  notes: { marginTop: 6, fontSize: 12, fontFamily: "Inter_400Regular", color: ios.label2 },
});
