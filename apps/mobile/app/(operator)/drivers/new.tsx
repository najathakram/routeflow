import { useState } from "react";
import { useRouter } from "expo-router";
import { FormField, FormSection, FormSheet, FormTextInput } from "../../../components/FormSheet";
import { useCreateDriver } from "../../../lib/api/drivers";
import { showToast } from "../../../lib/toast";
import { alertInfo } from "../../../lib/confirm";

export default function NewDriverScreen() {
  const router = useRouter();
  const mut = useCreateDriver();
  const [contactName, setContactName] = useState("");
  const [email, setEmail] = useState("");
  const [username, setUsername] = useState("");
  const [phone, setPhone] = useState("");
  const [vehicleMake, setVehicleMake] = useState("");
  const [vehicleModel, setVehicleModel] = useState("");
  const [vehiclePlate, setVehiclePlate] = useState("");
  const [error, setError] = useState<string | null>(null);

  const submit = () => {
    if (!contactName.trim() || !email.trim() || !username.trim()) {
      setError("Name, email, and username are required.");
      return;
    }
    setError(null);
    mut.mutate(
      {
        contactName: contactName.trim(),
        email: email.trim(),
        username: username.trim(),
        phone: phone.trim() || undefined,
        vehicleMake: vehicleMake.trim() || undefined,
        vehicleModel: vehicleModel.trim() || undefined,
        vehiclePlate: vehiclePlate.trim() || undefined,
      },
      {
        onSuccess: (res) => {
          alertInfo(
            "Driver created",
            `Temporary password: ${res.tempPassword}\nShare this with the driver to log in. They'll be prompted to set a new password.`,
          );
          router.back();
        },
        onError: (e: any) => showToast(e?.response?.data?.message ?? e?.message ?? "Try again."),
      },
    );
  };

  return (
    <FormSheet
      title="New driver"
      submitLabel={mut.isPending ? "Saving…" : "Create"}
      submitting={mut.isPending}
      onSubmit={submit}
    >
      <FormSection title="Identity">
        <FormField label="Full name" error={error ?? undefined}>
          <FormTextInput
            value={contactName}
            onChangeText={setContactName}
            placeholder="Tom Driver"
            autoCapitalize="words"
          />
        </FormField>
        <FormField label="Email">
          <FormTextInput
            value={email}
            onChangeText={setEmail}
            placeholder="tom@example.com"
            keyboardType="email-address"
            autoCapitalize="none"
            autoCorrect={false}
          />
        </FormField>
        <FormField label="Username" hint="Used for login.">
          <FormTextInput
            value={username}
            onChangeText={setUsername}
            placeholder="driver_tom"
            autoCapitalize="none"
            autoCorrect={false}
          />
        </FormField>
        <FormField label="Phone">
          <FormTextInput value={phone} onChangeText={setPhone} keyboardType="phone-pad" />
        </FormField>
      </FormSection>

      <FormSection title="Vehicle">
        <FormField label="Make">
          <FormTextInput value={vehicleMake} onChangeText={setVehicleMake} placeholder="Ford" />
        </FormField>
        <FormField label="Model">
          <FormTextInput
            value={vehicleModel}
            onChangeText={setVehicleModel}
            placeholder="Transit"
          />
        </FormField>
        <FormField label="License plate">
          <FormTextInput
            value={vehiclePlate}
            onChangeText={setVehiclePlate}
            autoCapitalize="characters"
          />
        </FormField>
      </FormSection>
    </FormSheet>
  );
}
