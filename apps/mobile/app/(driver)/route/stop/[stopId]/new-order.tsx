import { useMemo } from "react";
import { ActivityIndicator, StyleSheet, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { useLocalSearchParams } from "expo-router";
import { ios } from "@routeflow/ui/tokens";
import { NewOrderScreen } from "../../../../../components/NewOrderScreen";
import {
  useActiveRouteRun,
  useRouteRun,
} from "../../../../../lib/api/routes";

// Stop-scoped new-order wrapper. Pulls the customer from the stop so the
// order is auto-linked to the route run + stop on save.
export default function StopNewOrderScreen() {
  const params = useLocalSearchParams<{ stopId: string; runId?: string }>();
  const stopId = params.stopId;

  const { data: activeData, isLoading: activeLoading } = useActiveRouteRun();
  const runId = params.runId ?? activeData?.data?.[0]?.id;
  const { data: run, isLoading: runLoading } = useRouteRun(runId ?? "");
  const stop = useMemo(
    () => run?.stops?.find((s) => s.id === stopId),
    [run, stopId],
  );

  if (activeLoading || runLoading) {
    return (
      <SafeAreaView style={styles.safe} edges={["top", "left", "right"]}>
        <View style={styles.center}>
          <ActivityIndicator color={ios.brand} />
        </View>
      </SafeAreaView>
    );
  }

  return (
    <NewOrderScreen
      customerId={stop?.customerId}
      customerName={stop?.customer?.businessName}
      runId={runId}
      stopId={stopId}
      backLabel={stop?.customer?.businessName ?? "Stop"}
    />
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: ios.bgElev },
  center: { flex: 1, alignItems: "center", justifyContent: "center" },
});
