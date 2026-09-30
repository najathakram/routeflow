/**
 * Mobile mirrors web Settings PR-1 (#2787): Route defaults card, low-stock digest switch and the
 * Selling restrictions entry. Rules live in lib/settings-parity-logic.ts (pure, tested).
 */
import { useEffect, useState } from "react";
import { ActivityIndicator, Pressable, StyleSheet, Switch, Text, View } from "react-native";
import { useRouter } from "expo-router";
import { ios } from "@routeflow/ui/tokens";
import { FormField, FormSection, FormTextInput } from "../FormSheet";
import { useRouteSettings } from "../../lib/api/routes";
import {
  useRestrictionsSettings,
  useSavePreferences,
  usePreferences,
  useUpdateRouteSettings,
} from "../../lib/api/settings-parity";
import {
  buildRoutePatch,
  depotContext,
  digestPatch,
  isDigestOn,
  restrictionsSummary,
  routeDefaultsFormFrom,
  validateRouteDefaults,
  type RouteDefaultsErrors,
  type RouteDefaultsForm,
} from "../../lib/settings-parity-logic";
import { showToast } from "../../lib/toast";

const BLANK: RouteDefaultsForm = { service: "", start: "", speed: "", lat: "", lng: "" };

export function RouteDefaultsCard() {
  const { data, isLoading, isError, refetch } = useRouteSettings();
  const update = useUpdateRouteSettings();
  const [form, setForm] = useState<RouteDefaultsForm>(BLANK);
  const [errors, setErrors] = useState<RouteDefaultsErrors>({});

  useEffect(() => {
    if (data) setForm(routeDefaultsFormFrom(data));
  }, [data]);

  const set = (k: keyof RouteDefaultsForm) => (v: string) => setForm((f) => ({ ...f, [k]: v }));

  const save = () => {
    const errs = validateRouteDefaults(form);
    setErrors(errs);
    if (Object.keys(errs).length > 0) return;
    update.mutate(buildRoutePatch(form), {
      onSuccess: () => showToast("Route defaults saved"),
      onError: () => showToast("Couldn't save route defaults"),
    });
  };

  return (
    <FormSection title="Route defaults">
      {isLoading ? (
        <ActivityIndicator color={ios.brand} />
      ) : isError || !data ? (
        <Pressable onPress={() => refetch()} accessibilityRole="button">
          <Text style={styles.hint}>Couldn&apos;t load route defaults. Tap to retry.</Text>
        </Pressable>
      ) : (
        <>
          <FormField label="Service time per stop (min)" error={errors.service}>
            <FormTextInput
              value={form.service}
              onChangeText={set("service")}
              keyboardType="number-pad"
            />
          </FormField>
          <FormField label="Default start time" error={errors.start}>
            <FormTextInput value={form.start} onChangeText={set("start")} placeholder="08:00" />
          </FormField>
          <FormField label="Average speed (km/h)" error={errors.speed}>
            <FormTextInput
              value={form.speed}
              onChangeText={set("speed")}
              keyboardType="decimal-pad"
            />
          </FormField>
          <Text style={styles.hint}>
            {depotContext(data)} Enter both coordinates to change it; leave both blank to keep it as
            is (it can&apos;t be cleared here yet).
          </Text>
          <FormField label="Depot latitude" error={errors.lat}>
            <FormTextInput
              value={form.lat}
              onChangeText={set("lat")}
              placeholder="Not set"
              keyboardType="numbers-and-punctuation"
            />
          </FormField>
          <FormField label="Depot longitude" error={errors.lng}>
            <FormTextInput
              value={form.lng}
              onChangeText={set("lng")}
              placeholder="Not set"
              keyboardType="numbers-and-punctuation"
            />
          </FormField>
          <Pressable
            style={[styles.saveBtn, update.isPending && { opacity: 0.5 }]}
            disabled={update.isPending}
            onPress={save}
            accessibilityRole="button"
          >
            <Text style={styles.saveText}>Save route defaults</Text>
          </Pressable>
        </>
      )}
    </FormSection>
  );
}

/** Shown to TENANT_ADMINs only (the digest goes to admins) — the caller gates on the role. */
export function LowStockDigestCard() {
  const { data, isLoading, isError } = usePreferences();
  const save = useSavePreferences();
  const on = isDigestOn(data);
  return (
    <FormSection title="Low-stock digest">
      <View style={styles.switchRow}>
        <View style={{ flex: 1 }}>
          <Text style={styles.switchLabel}>Email me a low-stock digest</Text>
          <Text style={styles.hint}>
            {isError
              ? "Couldn't load this setting."
              : "A daily email listing products running low."}
          </Text>
        </View>
        <Switch
          value={on}
          disabled={isLoading || isError || save.isPending}
          onValueChange={(v) =>
            save.mutate(digestPatch(v), {
              onSuccess: () => showToast("Saved"),
              onError: () => showToast("Couldn't save — try again"),
            })
          }
          trackColor={{ true: ios.brand }}
        />
      </View>
    </FormSection>
  );
}

export function RestrictionsEntryCard() {
  const router = useRouter();
  const { data } = useRestrictionsSettings();
  return (
    <FormSection title="Selling restrictions">
      <Pressable
        onPress={() => router.push("/(operator)/settings/restrictions")}
        accessibilityRole="button"
      >
        <Text style={styles.switchLabel}>Block restricted products by state</Text>
        <Text style={styles.hint}>{restrictionsSummary(data)}</Text>
      </Pressable>
    </FormSection>
  );
}

const styles = StyleSheet.create({
  hint: { fontSize: 12, fontFamily: "Inter_400Regular", color: ios.label2, marginTop: 2 },
  switchRow: { flexDirection: "row", alignItems: "center", gap: 12 },
  switchLabel: { fontSize: 15, fontFamily: "Inter_600SemiBold", color: ios.label },
  saveBtn: {
    backgroundColor: ios.brand,
    borderRadius: 10,
    paddingVertical: 12,
    alignItems: "center",
    marginTop: 8,
  },
  saveText: { color: "#fff", fontSize: 15, fontFamily: "Inter_600SemiBold" },
});
