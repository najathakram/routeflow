import { ActivityIndicator, View } from "react-native";
import { useLocalSearchParams, useRouter } from "expo-router";
import { ios } from "@routeflow/ui/tokens";
import { CustomerForm, customerFormFromValues } from "../../../../components/CustomerForm";
import { useCustomer, useUpdateCustomer } from "../../../../lib/api/customers";
import { showToast } from "../../../../lib/toast";

export default function EditCustomerScreen() {
  const router = useRouter();
  const { id } = useLocalSearchParams<{ id: string }>();
  const { data: customer, isLoading } = useCustomer(id ?? "");
  const mut = useUpdateCustomer();

  if (isLoading || !customer) {
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

  return (
    <CustomerForm
      title="Edit customer"
      submitLabel={mut.isPending ? "Saving…" : "Save"}
      submitting={mut.isPending}
      mode="edit"
      initial={customerFormFromValues(customer)}
      onSubmit={(payload) => {
        if (!id) return;
        mut.mutate(
          { id, ...payload },
          {
            onSuccess: () => {
              showToast("Saved");
              router.back();
            },
            onError: (e: any) =>
              showToast(e?.response?.data?.message ?? e?.message ?? "Try again."),
          },
        );
      }}
    />
  );
}
