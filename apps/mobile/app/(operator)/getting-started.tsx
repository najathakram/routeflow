import { useState } from "react";
import {
  ActivityIndicator,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { Ionicons } from "@expo/vector-icons";
import { useRouter } from "expo-router";
import { ios } from "@routeflow/ui/tokens";
import { IosEmptyState, NavBackButton, NavBar } from "@routeflow/ui/mobile/ios";
import {
  ONBOARDING_STAGE_CUSTOMER_LABEL as STAGE_LABEL,
  ONBOARDING_STAGE_VALUES,
  tenantOnboardingSignOffErrorCopy,
} from "@routeflow/types";
import { useAuthStore } from "../../lib/auth-store";
import { useOnboardingSignOff, useTenantOnboarding } from "../../lib/api/onboarding";
import { fmtCalendarDate } from "../../lib/format-date";

/**
 * #2159 S4 — the workspace's onboarding checklist and written sign-off. Mirrors the web's
 * /getting-started page (same endpoints, same copy); only the UI differs.
 */
export default function GettingStartedScreen() {
  const router = useRouter();
  const { user } = useAuthStore();
  const { data, isLoading } = useTenantOnboarding();
  const signOff = useOnboardingSignOff();
  const [name, setName] = useState("");
  const o = data?.onboarding ?? null;

  const nav = (
    <NavBar
      largeTitle="Getting started"
      inlineTitle="Getting started"
      leading={<NavBackButton label="Home" onPress={() => router.back()} />}
    />
  );

  if (isLoading) {
    return (
      <SafeAreaView style={styles.safe} edges={["top", "left", "right"]}>
        {nav}
        <View style={styles.center}>
          <ActivityIndicator color={ios.brand} />
        </View>
      </SafeAreaView>
    );
  }
  if (!o) {
    return (
      <SafeAreaView style={styles.safe} edges={["top", "left", "right"]}>
        {nav}
        <IosEmptyState
          icon={<Ionicons name="checkmark-circle-outline" size={40} color={ios.system.greenInk} />}
          title="No onboarding in progress"
          subtitle="There's nothing to set up here right now."
        />
      </SafeAreaView>
    );
  }

  const live = o.status === "LIVE";
  const canSignOff = user?.role === "TENANT_ADMIN";
  const groups = ONBOARDING_STAGE_VALUES.map((stage) => ({
    stage,
    steps: o.steps.filter((s) => s.stage === stage),
  })).filter((g) => g.steps.length > 0);

  return (
    <SafeAreaView style={styles.safe} edges={["top", "left", "right"]}>
      {nav}
      <ScrollView contentContainerStyle={styles.scroll} keyboardShouldPersistTaps="handled">
        <View style={styles.card}>
          <Text style={styles.title}>{live ? "You're live" : `Now: ${STAGE_LABEL[o.stage]}`}</Text>
          <Text style={styles.sub}>
            {live
              ? "Onboarding is complete. Your RouteFlow team is still here if you need anything."
              : o.status === "ON_HOLD"
                ? "Onboarding is paused for now. Your onboarding lead will pick it back up with you."
                : "Here's where your onboarding stands and what we need from you."}
            {o.targetGoLiveOn && !live
              ? ` Target go-live: ${fmtCalendarDate(o.targetGoLiveOn, "short")}.`
              : ""}
          </Text>
        </View>

        {groups.map(({ stage, steps }) => (
          <View key={stage} style={styles.card}>
            <Text style={styles.section}>{STAGE_LABEL[stage]}</Text>
            {steps.map((s) => (
              <View key={s.key} style={styles.row}>
                <View style={{ flex: 1, minWidth: 0 }}>
                  <Text style={styles.rowTitle}>
                    {s.title}
                    {!s.required ? <Text style={styles.muted}> (optional)</Text> : null}
                  </Text>
                  {s.check && s.status === "PENDING" ? (
                    <Text
                      style={[
                        styles.hint,
                        { color: s.check.ok ? ios.system.greenInk : ios.system.orangeInk },
                      ]}
                    >
                      {s.check.detail}
                    </Text>
                  ) : null}
                </View>
                <Text
                  style={[styles.pill, s.status === "PENDING" ? styles.pillTodo : styles.pillDone]}
                >
                  {s.status === "PENDING" ? "To do" : s.status === "DONE" ? "Done" : "Not needed"}
                </Text>
              </View>
            ))}
          </View>
        ))}

        {o.signOff ? (
          <View style={styles.card} testID="onboarding-sign-off">
            <Text style={styles.section}>Sign-off</Text>
            {o.signOff.status === "DONE" ? (
              <Text style={styles.sub}>
                Signed off{o.signOff.signedName ? ` by ${o.signOff.signedName}` : ""}
                {o.signOff.signedAt
                  ? ` on ${fmtCalendarDate(o.signOff.signedAt.slice(0, 10), "short")}`
                  : ""}
                .
              </Text>
            ) : !o.signOff.available ? (
              <Text style={styles.sub}>
                Once training is done and you&apos;re happy with the setup, the workspace admin
                signs off here. We&apos;ll let you know when it&apos;s time.
              </Text>
            ) : !canSignOff ? (
              <Text style={styles.sub}>
                Sign-off is open. Your workspace admin needs to sign in and give it here.
              </Text>
            ) : (
              <View style={{ gap: 10 }}>
                <Text style={styles.sub}>
                  By signing off you confirm your team has been trained and the workspace is set up
                  the way you agreed. Type your full name to sign.
                </Text>
                <TextInput
                  value={name}
                  onChangeText={setName}
                  placeholder="Your full name"
                  accessibilityLabel="Your full name"
                  autoComplete="name"
                  maxLength={120}
                  style={styles.input}
                />
                {signOff.isError ? (
                  <Text style={[styles.hint, { color: ios.system.redInk }]}>
                    {tenantOnboardingSignOffErrorCopy(signOff.error)}
                  </Text>
                ) : null}
                <Pressable
                  accessibilityRole="button"
                  disabled={name.trim().length < 2 || signOff.isPending}
                  onPress={() => signOff.mutate({ signedName: name })}
                  style={[
                    styles.button,
                    (name.trim().length < 2 || signOff.isPending) && { opacity: 0.5 },
                  ]}
                >
                  {signOff.isPending ? (
                    <ActivityIndicator color="#fff" />
                  ) : (
                    <Text style={styles.buttonText}>Sign off</Text>
                  )}
                </Pressable>
              </View>
            )}
          </View>
        ) : null}
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: ios.bg },
  center: { flex: 1, alignItems: "center", justifyContent: "center" },
  scroll: { padding: 16, gap: 12, paddingBottom: 40 },
  card: { backgroundColor: ios.bgElev, borderRadius: 14, padding: 14, gap: 8 },
  title: { fontSize: 17, fontFamily: "Inter_600SemiBold", color: ios.label },
  section: { fontSize: 15, fontFamily: "Inter_600SemiBold", color: ios.label },
  sub: { fontSize: 13, fontFamily: "Inter_400Regular", color: ios.label2, lineHeight: 18 },
  muted: { color: ios.label2 },
  row: {
    flexDirection: "row",
    alignItems: "flex-start",
    gap: 10,
    paddingVertical: 8,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: ios.separator,
    minHeight: ios.rowMinH,
  },
  rowTitle: { fontSize: 14, fontFamily: "Inter_400Regular", color: ios.label },
  hint: { fontSize: 12, fontFamily: "Inter_400Regular", marginTop: 2 },
  pill: {
    fontSize: 12,
    fontFamily: "Inter_600SemiBold",
    paddingHorizontal: 8,
    paddingVertical: 3,
    borderRadius: 999,
    overflow: "hidden",
  },
  pillTodo: { backgroundColor: ios.fill3, color: ios.label2 },
  pillDone: { backgroundColor: ios.system.greenWash, color: ios.system.greenInk },
  input: {
    minHeight: 44,
    borderRadius: 10,
    borderWidth: 1,
    borderColor: ios.separator,
    paddingHorizontal: 12,
    fontSize: 15,
    color: ios.label,
    backgroundColor: ios.bg,
  },
  button: {
    minHeight: 44,
    borderRadius: 12,
    backgroundColor: ios.brand,
    alignItems: "center",
    justifyContent: "center",
  },
  buttonText: { color: "#fff", fontSize: 15, fontFamily: "Inter_600SemiBold" },
});
