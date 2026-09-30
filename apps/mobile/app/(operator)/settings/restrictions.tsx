/**
 * Selling restrictions (#2787): read-only for operators, the master switch for a TENANT_ADMIN.
 * Mirrors web /settings/restrictions; same GET/PATCH /settings/restrictions contract.
 */
import { ScrollView, StyleSheet, Switch, Text, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { useRouter } from "expo-router";
import { ios } from "@routeflow/ui/tokens";
import { NavBackButton, NavBar } from "@routeflow/ui/mobile/ios";
import { FormSection } from "../../../components/FormSheet";
import { useAuthStore } from "../../../lib/auth-store";
import {
  useRestrictionsSettings,
  useUpdateRestrictionsSettings,
} from "../../../lib/api/settings-parity";
import {
  canEditSellingRules,
  notReadyMessage,
  restrictionsSummary,
} from "../../../lib/settings-parity-logic";
import { alertInfo } from "../../../lib/confirm";
import { showToast } from "../../../lib/toast";

export default function RestrictionsSettingsScreen() {
  const router = useRouter();
  const role = useAuthStore((s) => s.user?.role);
  const { data, isLoading, isError } = useRestrictionsSettings();
  const update = useUpdateRestrictionsSettings();
  const canEdit = canEditSellingRules(role);

  const toggle = (enabled: boolean) =>
    update.mutate(
      { enabled },
      {
        onSuccess: () => showToast("Saved"),
        onError: (e) => {
          const reason = notReadyMessage(e);
          if (reason) alertInfo("Not ready yet", reason);
          else showToast("Couldn't save — try again");
        },
      },
    );

  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: ios.bg }} edges={["top"]}>
      <NavBar
        largeTitle="Selling restrictions"
        leading={<NavBackButton label="Back" onPress={() => router.back()} />}
      />
      <ScrollView contentContainerStyle={{ padding: 16, gap: 18 }}>
        <FormSection>
          {isLoading ? (
            <Text style={styles.hint}>Loading…</Text>
          ) : isError || !data ? (
            <Text style={styles.hint}>Couldn&apos;t load selling restrictions.</Text>
          ) : (
            <>
              <View style={styles.row}>
                <View style={{ flex: 1 }}>
                  <Text style={styles.label}>Restrict products by the customer&apos;s state</Text>
                  <Text style={styles.hint}>{restrictionsSummary(data)}</Text>
                </View>
                <Switch
                  value={data.enabled}
                  disabled={!canEdit || update.isPending}
                  onValueChange={toggle}
                  trackColor={{ true: ios.brand }}
                />
              </View>
              {!canEdit ? (
                <Text style={styles.hint}>Only a Tenant Admin can change this.</Text>
              ) : null}
            </>
          )}
        </FormSection>
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: "row", alignItems: "center", gap: 12 },
  label: { fontSize: 15, fontFamily: "Inter_600SemiBold", color: ios.label },
  hint: { fontSize: 12, fontFamily: "Inter_400Regular", color: ios.label2, marginTop: 2 },
});
