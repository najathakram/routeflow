import { useEffect, useState } from "react";
import { ActivityIndicator, StyleSheet, Switch, Text, View } from "react-native";
import { useLocalSearchParams, useRouter } from "expo-router";
import { ios } from "@routeflow/ui/tokens";
import { FormField, FormSection, FormSheet, FormTextInput } from "../../../../components/FormSheet";
import { useAdminRoute } from "../../../../lib/api/admin";
import { useUpdateRoute } from "../../../../lib/api/routes";
import { showToast } from "../../../../lib/toast";

export default function EditRouteScreen() {
  const router = useRouter();
  const { id } = useLocalSearchParams<{ id: string }>();
  const { data: route, isLoading } = useAdminRoute(id);
  const mut = useUpdateRoute();
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [active, setActive] = useState(true);

  useEffect(() => {
    if (route) {
      setName(route.name);
      setDescription(route.description ?? "");
      setActive(route.isActive ?? true);
    }
  }, [route]);

  if (isLoading || !route) {
    return (
      <View
        style={{
          flex: 1,
          backgroundColor: ios.bg,
          alignItems: "center",
          justifyContent: "center",
        }}
      >
        <ActivityIndicator color={ios.brand} />
      </View>
    );
  }

  const submit = () => {
    if (!id) return;
    if (!name.trim()) {
      showToast("Name is required.");
      return;
    }
    mut.mutate(
      { id, name: name.trim(), description: description.trim() || undefined, isActive: active },
      {
        onSuccess: () => {
          showToast("Saved");
          router.back();
        },
        onError: (e: any) => showToast(e?.response?.data?.message ?? e?.message ?? "Try again."),
      },
    );
  };

  return (
    <FormSheet
      title="Edit route"
      submitLabel={mut.isPending ? "Saving…" : "Save"}
      submitting={mut.isPending}
      onSubmit={submit}
    >
      <FormSection title="Details">
        <FormField label="Name">
          <FormTextInput value={name} onChangeText={setName} />
        </FormField>
        <FormField label="Description">
          <FormTextInput
            value={description}
            onChangeText={setDescription}
            multiline
            numberOfLines={3}
            textAlignVertical="top"
            style={{ minHeight: 80 }}
          />
        </FormField>
      </FormSection>
      <FormSection>
        <View style={styles.switchRow}>
          <View style={{ flex: 1 }}>
            <Text style={styles.switchLabel}>Active</Text>
            <Text style={styles.switchHint}>Inactive routes are hidden from dispatch.</Text>
          </View>
          <Switch value={active} onValueChange={setActive} trackColor={{ true: ios.brand }} />
        </View>
      </FormSection>
    </FormSheet>
  );
}

const styles = StyleSheet.create({
  switchRow: { flexDirection: "row", alignItems: "center", gap: 12 },
  switchLabel: { fontSize: 15, fontFamily: "Inter_600SemiBold", color: ios.label },
  switchHint: { fontSize: 12, fontFamily: "Inter_400Regular", color: ios.label2, marginTop: 2 },
});
