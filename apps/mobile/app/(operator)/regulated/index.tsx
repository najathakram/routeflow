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
import { NavAction, NavBackButton, NavBar, Pill } from "@routeflow/ui/mobile/ios";
import {
  useTrackedCategories,
  useToggleTrackedCategory,
  type TrackedCategory,
} from "../../../lib/api/tracked-categories";
import { taxRuleLabel, treatmentLabel } from "../../../lib/regulated-format";
import { showToast } from "../../../lib/toast";

export default function RegulatedCategoriesScreen() {
  const router = useRouter();
  const { data: sections = [], isLoading, isFetching, refetch } = useTrackedCategories();
  const toggle = useToggleTrackedCategory();

  return (
    <SafeAreaView style={styles.safe} edges={["top", "left", "right"]}>
      <NavBar
        largeTitle="Regulated"
        leading={<NavBackButton label="More" onPress={() => router.back()} />}
        trailing={
          <NavAction label="New" bold onPress={() => router.push("/(operator)/regulated/new")} />
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
        ) : sections.length === 0 ? (
          <View style={styles.center}>
            <Text style={styles.empty}>No regulated sections yet.</Text>
            <Pressable
              style={styles.primaryBtn}
              onPress={() => router.push("/(operator)/regulated/new")}
            >
              <Ionicons name="add" size={16} color="#fff" />
              <Text style={styles.primaryBtnText}>New section</Text>
            </Pressable>
          </View>
        ) : (
          <View style={{ paddingHorizontal: 16, gap: 8, paddingBottom: 24 }}>
            {sections.map((s) => (
              <SectionRow
                key={s.id}
                section={s}
                toggling={toggle.isPending}
                onPress={() => router.push(`/(operator)/regulated/${s.id}`)}
                onToggle={() =>
                  toggle.mutate(s.id, {
                    onSuccess: (updated) =>
                      showToast(updated.active ? `${s.name} activated` : `${s.name} deactivated`),
                    onError: (e: any) =>
                      showToast(e?.response?.data?.message ?? e?.message ?? "Try again."),
                  })
                }
              />
            ))}
          </View>
        )}
      </ScrollView>
    </SafeAreaView>
  );
}

function SectionRow({
  section,
  toggling,
  onPress,
  onToggle,
}: {
  section: TrackedCategory;
  toggling: boolean;
  onPress: () => void;
  onToggle: () => void;
}) {
  return (
    <Pressable style={[styles.row, !section.active && { opacity: 0.6 }]} onPress={onPress}>
      <View style={styles.rowHead}>
        <View style={{ flex: 1, minWidth: 0, flexDirection: "row", alignItems: "center", gap: 8 }}>
          <Ionicons name="shield-checkmark-outline" size={16} color={ios.brand} />
          <Text style={styles.title} numberOfLines={1}>
            {section.name}
          </Text>
        </View>
        <View style={{ flexDirection: "row", gap: 6 }}>
          {section.requiresLicense ? (
            <Pill variant="orange" small>
              License
            </Pill>
          ) : null}
          <Pill variant={section.active ? "green" : "gray"} small>
            {section.active ? "Active" : "Off"}
          </Pill>
        </View>
      </View>
      <Text style={styles.sub} numberOfLines={1}>
        {taxRuleLabel(section)} · {treatmentLabel(section.invoiceTreatment)} ·{" "}
        {section.productCount} {section.productCount === 1 ? "product" : "products"}
      </Text>
      <Pressable style={styles.toggleBtn} onPress={onToggle} disabled={toggling} hitSlop={6}>
        <Ionicons name="power-outline" size={13} color={ios.label2} />
        <Text style={styles.toggleBtnText}>{section.active ? "Deactivate" : "Activate"}</Text>
      </Pressable>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: ios.bg },
  center: { padding: 40, alignItems: "center", gap: 14 },
  empty: { fontSize: 14, fontFamily: "Inter_400Regular", color: ios.label2 },
  primaryBtn: {
    backgroundColor: ios.brand,
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    paddingHorizontal: 16,
    paddingVertical: 10,
    borderRadius: 12,
  },
  primaryBtnText: { color: "#fff", fontSize: 14, fontFamily: "Inter_600SemiBold" },
  row: { backgroundColor: ios.bgElev, borderRadius: 12, padding: 14, gap: 8 },
  rowHead: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: 8 },
  title: { fontSize: 15, fontFamily: "Inter_600SemiBold", color: ios.label, letterSpacing: -0.2 },
  sub: { fontSize: 12, fontFamily: "Inter_400Regular", color: ios.label2 },
  toggleBtn: {
    alignSelf: "flex-start",
    flexDirection: "row",
    alignItems: "center",
    gap: 4,
    paddingHorizontal: 8,
    paddingVertical: 4,
    borderRadius: 8,
    backgroundColor: ios.fill3,
  },
  toggleBtnText: { fontSize: 12, fontFamily: "Inter_500Medium", color: ios.label2 },
});
