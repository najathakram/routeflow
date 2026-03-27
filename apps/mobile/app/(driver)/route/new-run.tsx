import { useState } from "react";
import {
  ActivityIndicator,
  Alert,
  Pressable,
  ScrollView,
  StyleSheet,
  Switch,
  Text,
  TextInput,
  View,
} from "react-native";
import { router, Stack } from "expo-router";
import { Ionicons } from "@expo/vector-icons";
import { colors, borderRadius, shadows } from "@routeflow/ui/tokens";
import { useAllRoutes, useCreateRun, useUpdateRunStatus } from "../../../lib/api/routes";
import { format } from "date-fns";

function formatDateForInput(date: Date): string {
  return format(date, "yyyy-MM-dd");
}

function parseDateInput(value: string): Date | null {
  const parts = value.split("-");
  if (parts.length !== 3) return null;
  const [y, m, d] = parts.map(Number);
  if (isNaN(y) || isNaN(m) || isNaN(d)) return null;
  return new Date(y, m - 1, d);
}

function displayDate(value: string): string {
  const d = parseDateInput(value);
  if (!d) return value;
  return format(d, "EEEE, MMMM d, yyyy");
}

export default function NewRunScreen() {
  const today = formatDateForInput(new Date());
  const [selectedRouteId, setSelectedRouteId] = useState<string | null>(null);
  const [scheduledDate, setScheduledDate] = useState(today);
  const [notes, setNotes] = useState("");
  const [startNow, setStartNow] = useState(false);

  const { data: routesData, isLoading: loadingRoutes } = useAllRoutes();
  const routes = (routesData?.data ?? []).filter((r) => r.isActive);

  const { mutate: createRun, isPending } = useCreateRun();
  const { mutate: updateRunStatus } = useUpdateRunStatus();

  const handleSubmit = () => {
    if (!selectedRouteId) {
      Alert.alert("Select a Route", "Please choose a route before scheduling.");
      return;
    }

    const dateToUse = startNow ? formatDateForInput(new Date()) : scheduledDate;
    if (!dateToUse || !parseDateInput(dateToUse)) {
      Alert.alert("Invalid Date", "Please enter a valid date in YYYY-MM-DD format.");
      return;
    }

    createRun(
      {
        routeId: selectedRouteId,
        scheduledDate: new Date(dateToUse).toISOString(),
        notes: notes.trim() || undefined,
      },
      {
        onSuccess: (newRun) => {
          if (startNow) {
            updateRunStatus({ id: newRun.id, status: "IN_PROGRESS" }, {
              onSuccess: () => {
                Alert.alert("Route Started!", "Your route is now active. Head to the route screen.");
                router.replace("/(driver)/route" as any);
              },
              onError: () => {
                Alert.alert("Scheduled", "Run created but could not start automatically. Use the Route screen to start.");
                router.back();
              },
            });
          } else {
            Alert.alert("Run Scheduled", `Your route has been scheduled for ${displayDate(dateToUse)}.`);
            router.back();
          }
        },
        onError: (err: any) => {
          Alert.alert("Error", err?.response?.data?.message ?? err.message ?? "Failed to schedule run.");
        },
      },
    );
  };

  return (
    <>
      <Stack.Screen options={{ title: "Schedule a Run", headerBackTitle: "Route" }} />
      <ScrollView
        style={styles.container}
        contentContainerStyle={styles.scroll}
        keyboardShouldPersistTaps="handled"
      >
        {/* Route picker */}
        <View style={styles.section}>
          <Text style={styles.sectionTitle}>Select Route</Text>
          {loadingRoutes ? (
            <ActivityIndicator color={colors.brand[500]} style={{ margin: 16 }} />
          ) : routes.length === 0 ? (
            <Text style={styles.emptyText}>No active routes available.</Text>
          ) : (
            <View style={styles.routeList}>
              {routes.map((route) => {
                const isSelected = selectedRouteId === route.id;
                return (
                  <Pressable
                    key={route.id}
                    style={[styles.routeOption, isSelected && styles.routeOptionSelected]}
                    onPress={() => setSelectedRouteId(route.id)}
                    accessibilityRole="radio"
                    accessibilityState={{ checked: isSelected }}
                  >
                    <View style={[styles.radioCircle, isSelected && styles.radioCircleSelected]}>
                      {isSelected && (
                        <View style={styles.radioDot} />
                      )}
                    </View>
                    <Text style={[styles.routeName, isSelected && styles.routeNameSelected]}>
                      {route.name}
                    </Text>
                    {isSelected && (
                      <Ionicons name="checkmark-circle" size={20} color={colors.brand[500]} />
                    )}
                  </Pressable>
                );
              })}
            </View>
          )}
        </View>

        {/* Start Mode */}
        <View style={styles.section}>
          <View style={{ flexDirection: "row", alignItems: "center", gap: 12 }}>
            <View style={{ flex: 1 }}>
              <Text style={styles.sectionTitle}>Start Immediately</Text>
              <Text style={{ fontSize: 13, fontFamily: "Inter_400Regular", color: "#64748b", marginTop: 4 }}>
                {startNow ? "Route will start now and become active" : "Route will be scheduled for the selected date"}
              </Text>
            </View>
            <Switch
              value={startNow}
              onValueChange={setStartNow}
              trackColor={{ true: colors.brand[500], false: colors.surface.border }}
            />
          </View>
        </View>

        {/* Date picker */}
        {!startNow && (
          <View style={styles.section}>
            <Text style={styles.sectionTitle}>Scheduled Date</Text>
            <TextInput
              style={styles.dateInput}
              value={scheduledDate}
              onChangeText={setScheduledDate}
              placeholder="YYYY-MM-DD"
              placeholderTextColor="#94a3b8"
              keyboardType="numbers-and-punctuation"
              returnKeyType="done"
            />
            {scheduledDate && parseDateInput(scheduledDate) ? (
              <Text style={styles.datePreview}>{displayDate(scheduledDate)}</Text>
            ) : null}
          </View>
        )}

        {/* Notes */}
        <View style={styles.section}>
          <Text style={styles.sectionTitle}>Notes (optional)</Text>
          <TextInput
            style={styles.notesInput}
            value={notes}
            onChangeText={setNotes}
            placeholder="Any notes for this run…"
            placeholderTextColor="#94a3b8"
            multiline
            numberOfLines={3}
            textAlignVertical="top"
          />
        </View>
      </ScrollView>

      {/* Submit */}
      <View style={styles.footer}>
        <Pressable
          style={[styles.submitBtn, (isPending || !selectedRouteId) && styles.submitBtnDisabled]}
          onPress={handleSubmit}
          disabled={isPending || !selectedRouteId}
          accessibilityRole="button"
        >
          {isPending ? (
            <ActivityIndicator color="#fff" />
          ) : (
            <>
              <Ionicons name={startNow ? "play-circle-outline" : "calendar-outline"} size={22} color="#fff" style={{ marginRight: 8 }} />
              <Text style={styles.submitBtnText}>{startNow ? "Start Route Now" : "Schedule Run"}</Text>
            </>
          )}
        </Pressable>
      </View>
    </>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.surface.raised },
  scroll: { padding: 16, gap: 16, paddingBottom: 24 },
  section: {
    backgroundColor: "#fff",
    borderRadius: borderRadius.lg,
    padding: 16,
    gap: 10,
    ...shadows.card,
  },
  sectionTitle: {
    fontSize: 13,
    fontFamily: "Inter_600SemiBold",
    color: "#64748b",
    textTransform: "uppercase",
    letterSpacing: 0.5,
  },
  emptyText: {
    fontSize: 14,
    fontFamily: "Inter_400Regular",
    color: "#94a3b8",
    textAlign: "center",
    paddingVertical: 8,
  },
  routeList: { gap: 8 },
  routeOption: {
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
    padding: 12,
    borderRadius: borderRadius.DEFAULT,
    borderWidth: 1.5,
    borderColor: colors.surface.border,
    backgroundColor: colors.surface.raised,
  },
  routeOptionSelected: {
    borderColor: colors.brand[500],
    backgroundColor: colors.brand[50],
  },
  radioCircle: {
    width: 20,
    height: 20,
    borderRadius: 10,
    borderWidth: 2,
    borderColor: colors.surface.border,
    alignItems: "center",
    justifyContent: "center",
  },
  radioCircleSelected: {
    borderColor: colors.brand[500],
  },
  radioDot: {
    width: 10,
    height: 10,
    borderRadius: 5,
    backgroundColor: colors.brand[500],
  },
  routeName: {
    flex: 1,
    fontSize: 15,
    fontFamily: "Inter_500Medium",
    color: colors.navy.DEFAULT,
  },
  routeNameSelected: {
    fontFamily: "Inter_600SemiBold",
    color: colors.brand[600] ?? colors.brand[500],
  },
  dateInput: {
    height: 48,
    borderWidth: 1.5,
    borderColor: colors.surface.border,
    borderRadius: borderRadius.DEFAULT,
    paddingHorizontal: 14,
    fontSize: 16,
    fontFamily: "Inter_400Regular",
    color: colors.navy.DEFAULT,
    backgroundColor: colors.surface.raised,
  },
  datePreview: {
    fontSize: 14,
    fontFamily: "Inter_400Regular",
    color: "#64748b",
  },
  notesInput: {
    borderWidth: 1,
    borderColor: colors.surface.border,
    borderRadius: borderRadius.DEFAULT,
    padding: 12,
    fontSize: 14,
    fontFamily: "Inter_400Regular",
    color: colors.navy.DEFAULT,
    minHeight: 72,
    backgroundColor: colors.surface.raised,
  },
  footer: {
    padding: 16,
    paddingBottom: 32,
    backgroundColor: "#fff",
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: colors.surface.border,
  },
  submitBtn: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: colors.brand[500],
    borderRadius: borderRadius.lg,
    padding: 16,
  },
  submitBtnDisabled: { opacity: 0.5 },
  submitBtnText: {
    fontSize: 16,
    fontFamily: "Inter_700Bold",
    color: "#fff",
  },
});
