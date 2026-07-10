import { ScrollView, StyleSheet, Text, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { Ionicons } from "@expo/vector-icons";
import { useRouter } from "expo-router";
import { ios } from "@routeflow/ui/tokens";
import { ListGroup, ListRow, NavBar } from "@routeflow/ui/mobile/ios";
import { reportGroups, type ReportId } from "../../../lib/reports-logic";

// Icon + tint per report — decorative only (registry stays pure/screen-free).
const REPORT_ICON: Record<
  ReportId,
  { name: keyof typeof Ionicons.glyphMap; ink: string; bg: string }
> = {
  "profit-loss": {
    name: "trending-up-outline",
    ink: ios.system.purpleInk,
    bg: ios.system.purpleWash,
  },
  cashflow: { name: "swap-vertical-outline", ink: ios.brand, bg: ios.brandWash },
  "sales-by-customer": {
    name: "people-outline",
    ink: ios.system.greenInk,
    bg: ios.system.greenWash,
  },
  "sales-by-item": { name: "cube-outline", ink: ios.system.greenInk, bg: ios.system.greenWash },
  "ar-aging": { name: "hourglass-outline", ink: ios.system.orangeInk, bg: ios.system.orangeWash },
};

export default function ReportsIndexScreen() {
  const router = useRouter();
  const groups = reportGroups();

  return (
    <SafeAreaView style={styles.safe} edges={["top", "left", "right"]}>
      <NavBar largeTitle="Reports" />
      <ScrollView showsVerticalScrollIndicator={false}>
        <Text style={styles.intro}>Read-only finance reports. Tap one to pick a period.</Text>
        {groups.map((g) => (
          <ListGroup key={g.group} header={g.group.toUpperCase()}>
            {g.reports.map((r) => {
              const ic = REPORT_ICON[r.id];
              return (
                <ListRow
                  key={r.id}
                  icon={<Ionicons name={ic.name} size={16} color={ic.ink} />}
                  iconBg={ic.bg}
                  title={r.label}
                  subtitle={r.description}
                  onPress={() => router.push(`/(operator)/reports/${r.id}`)}
                  chevron
                />
              );
            })}
          </ListGroup>
        ))}
        <View style={{ height: 24 }} />
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: ios.bg },
  intro: {
    fontSize: 13,
    fontFamily: "Inter_400Regular",
    color: ios.label2,
    paddingHorizontal: 20,
    paddingTop: 4,
    paddingBottom: 4,
  },
});
