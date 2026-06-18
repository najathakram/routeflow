import { useEffect, useState } from "react";
import { ActivityIndicator, View } from "react-native";
import { useLocalSearchParams, useRouter } from "expo-router";
import { ios } from "@routeflow/ui/tokens";
import { FormField, FormSection, FormSheet, FormTextInput } from "../../../../components/FormSheet";
import { useDriver, useUpdateDriver } from "../../../../lib/api/drivers";
import { showToast } from "../../../../lib/toast";

export default function EditDriverScreen() {
  const router = useRouter();
  const { id } = useLocalSearchParams<{ id: string }>();
  const { data: driver, isLoading } = useDriver(id);
  const mut = useUpdateDriver();

  const [phone, setPhone] = useState("");
  const [vehicleMake, setVehicleMake] = useState("");
  const [vehicleModel, setVehicleModel] = useState("");
  const [vehiclePlate, setVehiclePlate] = useState("");
  const [vehicleColour, setVehicleColour] = useState("");

  useEffect(() => {
    if (driver) {
      setPhone(driver.user?.phone ?? "");
      setVehicleMake(driver.vehicleMake ?? "");
      setVehicleModel(driver.vehicleModel ?? "");
      setVehiclePlate(driver.vehiclePlate ?? "");
      setVehicleColour((driver as any).vehicleColour ?? "");
    }
  }, [driver]);

  if (isLoading || !driver) {
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
    mut.mutate(
      {
        id,
        phone: phone.trim() || undefined,
        vehicleMake: vehicleMake.trim() || undefined,
        vehicleModel: vehicleModel.trim() || undefined,
        vehiclePlate: vehiclePlate.trim() || undefined,
        vehicleColour: vehicleColour.trim() || undefined,
      },
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
      title="Edit driver"
      submitLabel={mut.isPending ? "Saving…" : "Save"}
      submitting={mut.isPending}
      onSubmit={submit}
    >
      <FormSection title="Contact">
        <FormField label="Phone">
          <FormTextInput value={phone} onChangeText={setPhone} keyboardType="phone-pad" />
        </FormField>
      </FormSection>

      <FormSection title="Vehicle">
        <FormField label="Make">
          <FormTextInput value={vehicleMake} onChangeText={setVehicleMake} />
        </FormField>
        <FormField label="Model">
          <FormTextInput value={vehicleModel} onChangeText={setVehicleModel} />
        </FormField>
        <FormField label="Color">
          <FormTextInput value={vehicleColour} onChangeText={setVehicleColour} />
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
