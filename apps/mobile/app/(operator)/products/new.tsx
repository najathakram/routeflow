import { Alert } from "react-native";
import { useLocalSearchParams, useRouter } from "expo-router";
import {
  ProductForm,
  emptyProductForm,
} from "../../../components/ProductForm";
import { useCreateProduct } from "../../../lib/api/products";
import { showToast } from "../../../lib/toast";

export default function NewProductScreen() {
  const router = useRouter();
  const params = useLocalSearchParams<{ barcode?: string }>();
  const mut = useCreateProduct();

  const initial = {
    ...emptyProductForm(),
    barcode: params.barcode ?? "",
  };

  return (
    <ProductForm
      title="New product"
      submitLabel={mut.isPending ? "Saving…" : "Save"}
      submitting={mut.isPending}
      initial={initial}
      onSubmit={(payload) => {
        mut.mutate(payload, {
          onSuccess: (res) => {
            showToast("Product created");
            router.replace(`/(operator)/products/${res.id}`);
          },
          onError: (e: any) =>
            Alert.alert(
              "Couldn't save",
              e?.response?.data?.message ?? e?.message ?? "Try again.",
            ),
        });
      }}
    />
  );
}
