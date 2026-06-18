import { useEffect, useState } from "react";
import { ActivityIndicator, View } from "react-native";
import { useLocalSearchParams, useRouter } from "expo-router";
import { ios } from "@routeflow/ui/tokens";
import { FormField, FormSection, FormSheet, FormTextInput } from "../../../../components/FormSheet";
import { useSuppliers, useUpdateSupplier } from "../../../../lib/api/purchase-orders";
import { showToast } from "../../../../lib/toast";

export default function EditSupplierScreen() {
  const router = useRouter();
  const { id } = useLocalSearchParams<{ id: string }>();
  const { data: suppliers, isLoading } = useSuppliers();
  const mut = useUpdateSupplier();

  const supplier = suppliers?.find((s) => s.id === id);

  const [name, setName] = useState("");
  const [contactName, setContactName] = useState("");
  const [phone, setPhone] = useState("");
  const [email, setEmail] = useState("");
  const [notes, setNotes] = useState("");

  useEffect(() => {
    if (supplier) {
      setName(supplier.name);
      setContactName(supplier.contactName ?? "");
      setPhone(supplier.phone ?? "");
      setEmail(supplier.email ?? "");
      setNotes(supplier.notes ?? "");
    }
  }, [supplier]);

  if (isLoading || !supplier) {
    return (
      <View
        style={{ flex: 1, alignItems: "center", justifyContent: "center", backgroundColor: ios.bg }}
      >
        <ActivityIndicator color={ios.brand} />
      </View>
    );
  }

  const submit = () => {
    if (!name.trim()) {
      showToast("Please enter a supplier name.");
      return;
    }
    mut.mutate(
      {
        id: id ?? "",
        name: name.trim(),
        contactName: contactName.trim() || undefined,
        phone: phone.trim() || undefined,
        email: email.trim() || undefined,
        notes: notes.trim() || undefined,
      },
      {
        onSuccess: () => {
          showToast("Supplier updated");
          router.back();
        },
        onError: (e: any) => showToast(e?.response?.data?.message ?? e?.message ?? "Try again."),
      },
    );
  };

  return (
    <FormSheet
      title="Edit Supplier"
      submitLabel={mut.isPending ? "Saving…" : "Save"}
      submitting={mut.isPending}
      onSubmit={submit}
    >
      <FormSection title="Supplier">
        <FormField label="Name">
          <FormTextInput value={name} onChangeText={setName} placeholder="Supplier name" />
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
