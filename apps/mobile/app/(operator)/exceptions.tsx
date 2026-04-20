import { useState } from "react";
import { ScrollView, StyleSheet, Text, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { useRouter } from "expo-router";
import { ios } from "@routeflow/ui/tokens";
import {
  ExceptionCard,
  FilterChipRow,
  NavAction,
  NavBackButton,
  NavBar,
} from "@routeflow/ui/mobile/ios";

type Severity = "red" | "orange" | "yellow";

// TODO: replace with /exceptions?status=open feed.
const EXCEPTIONS: ReadonlyArray<{
  severity: Severity;
  title: string;
  sub: string;
  time: string;
  actions: string[];
}> = [
  {
    severity: "red",
    title: "R05 · Samira H. — 18 min late",
    sub: "Traffic on Highway 1 · 3 stops affected",
    time: "now",
    actions: ["Reroute", "Notify customers"],
  },
  {
    severity: "red",
    title: "R07 · Harbor Café refused delivery",
    sub: "Item damaged · driver needs credit authorization",
    time: "4m ago",
    actions: ["Authorize $22", "Dispatch"],
  },
  {
    severity: "orange",
    title: "R11 · Short pick not resolved",
    sub: "3 × Pain au chocolat for Central Kitchen",
    time: "8m ago",
    actions: ["Substitute"],
  },
  {
    severity: "orange",
    title: "Van 03 · Low fuel",
    sub: "14% · nearest station 2.1 km",
    time: "12m ago",
    actions: ["Notify Ana"],
  },
  {
    severity: "yellow",
    title: "Standing order paused",
    sub: "Luna Roastery · weekly · customer request",
    time: "1h ago",
    actions: ["Review"],
  },
];

export default function ExceptionsScreen() {
  const router = useRouter();
  const [filter, setFilter] = useState("All · 5");
  return (
    <SafeAreaView style={styles.safe} edges={["top", "left", "right"]}>
      <NavBar
        largeTitle="Exceptions"
        subtitle="5 open · 2 urgent · 12 cleared today"
        inlineTitle="Needs attention"
        leading={<NavBackButton label="Home" onPress={() => router.back()} />}
        trailing={<NavAction label="Filter" />}
      />

      <ScrollView showsVerticalScrollIndicator={false}>
        <FilterChipRow
          chips={[
            { label: "All · 5" },
            { label: "Urgent · 2" },
            { label: "Returns" },
            { label: "Payments" },
            { label: "Routes" },
          ]}
          value={filter}
          onChange={setFilter}
        />
        <View style={{ paddingHorizontal: 16, gap: 10, paddingTop: 12, paddingBottom: 20 }}>
          {EXCEPTIONS.map((e, i) => (
            <ExceptionCard
              key={i}
              severity={e.severity}
              title={e.title}
              subtitle={e.sub}
              timeLabel={e.time}
              actions={e.actions.map((a) => ({ label: a }))}
            />
          ))}
        </View>
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: ios.bg },
});
