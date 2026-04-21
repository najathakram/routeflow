import { useState } from "react";
import { Alert } from "react-native";
import { useRouter } from "expo-router";
import { FormField, FormSection, FormSheet, FormTextInput } from "../../../components/FormSheet";
import { useCreateSupplier } from "../../../lib/api/purchase-orders";
import { showToast } from "../../../lib/toast";

export default function NewSupplierScreen() {
  const router = useRouter();
  const mut = useCreateSupplier();

  const [name, setName] = useState("");
  const [contactName, setContactName] = useState("");
  const [phone, setPhone] = useState("");
  const [email, setEmail] = useState("");
  const [notes, setNotes] = useState("");

  const submit = () => {
    if (!name.trim()) {
      Alert.alert("Name required", "Please enter a supplier name.");
      return;
    }
    mut.mutate(
      {
        name: name.trim(),
        contactName: contactName.trim() || undefined,
        phone: phone.trim() || undefined,
        email: email.trim() || undefined,
        notes: notes.trim() || undefined,
      },
      {
        onSuccess: () => {
          showToast("Supplier created");
          router.back();
        },
        onError: (e: any) =>
          Alert.alert(
            "Couldn't create",
            e?.response?.data?.message ?? e?.message ?? "Try again.",
          ),
      },
    );
  };

  return (
    <FormSheet
      title="New Supplier"
      submitLabel={mut.isPending ? "Creating…" : "Create"}
      submitting={mut.isPending}
      onSubmit={submit}
    >
      <FormSection title="Supplier">
        <FormField label="Name">
          <FormTextInput
            value={name}
            onChangeText={setName}
            placeholder="Supplier name"
            autoFocus
          />
        </FormField>
        <FormField label="Contact name (optional)">
          <FormTextInput
            value={contactName}
            onChangeText={setContactName}
            placeholder="Full name"
          />
        </FormField>
      </FormSection>

      <FormSection title="Contact">
        <FormField label="Phone (optional)">
          <FormTextInput
            value={phone}
            onChangeText={setPhone}
            placeholder="+1 555 000 0000"
            keyboardType="phone-pad"
          />
        </FormField>
        <FormField label="Email (optional)">
          <FormTextInput
            value={email}
            onChangeText={setEmail}
            placeholder="supplier@example.com"
            keyboardType="email-address"
            autoCapitalize="none"
          />
        </FormField>
      </FormSection>

      <FormSection title="Notes">
        <FormField label="Notes (optional)">
          <FormTextInput
            value={notes}
            onChangeText={setNotes}
            placeholder="Any notes about this supplier…"
            multiline
            numberOfLines={3}
            style={{ minHeight: 72, textAlignVertical: "top" }}
          />
        </FormField>
      </FormSection>
    </FormSheet>
  );
}
