import { useState } from "react";
import { Alert } from "react-native";
import { useRouter } from "expo-router";
import {
  FormField,
  FormSection,
  FormSheet,
  FormTextInput,
} from "../../../components/FormSheet";
import { useCreateRoute } from "../../../lib/api/routes";
import { showToast } from "../../../lib/toast";

export default function NewRouteScreen() {
  const router = useRouter();
  const mut = useCreateRoute();
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [error, setError] = useState<string | null>(null);

  const submit = () => {
    const trimmed = name.trim();
    if (!trimmed) {
      setError("Name is required.");
      return;
    }
    setError(null);
    mut.mutate(
      { name: trimmed, description: description.trim() || undefined },
      {
        onSuccess: (res) => {
          showToast("Route created");
          router.replace(`/(operator)/routes/${res.id}`);
        },
        onError: (e: any) =>
          Alert.alert("Couldn't save", e?.response?.data?.message ?? e?.message ?? "Try again."),
      },
    );
  };

  return (
    <FormSheet
      title="New route"
      submitLabel={mut.isPending ? "Saving…" : "Create"}
      submitting={mut.isPending}
      onSubmit={submit}
    >
      <FormSection title="Details">
        <FormField label="Name" error={error ?? undefined}>
          <FormTextInput
            value={name}
            onChangeText={setName}
            placeholder="Route A — Downtown"
            autoCapitalize="words"
          />
        </FormField>
        <FormField label="Description">
          <FormTextInput
            value={description}
            onChangeText={setDescription}
            placeholder="Optional"
            multiline
            numberOfLines={3}
            textAlignVertical="top"
            style={{ minHeight: 80 }}
          />
        </FormField>
      </FormSection>
    </FormSheet>
  );
}
