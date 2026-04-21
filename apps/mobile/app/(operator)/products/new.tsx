import { Alert } from "react-native";
import { useLocalSearchParams, useRouter } from "expo-router";
import {
  ProductForm,
  emptyProductForm,
} from "../../../components/ProductForm";
import { useCreateProduct, useUpdateReorderSettings } from "../../../lib/api/products";
import { showToast } from "../../../lib/toast";

export default function NewProductScreen() {
  const router = useRouter();
  const params = useLocalSearchParams<{ barcode?: string }>();
  const mut = useCreateProduct();
  const reorderMut = useUpdateReorderSettings();

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
        const { reorderPoint, reorderQty, ...productDto } = payload;
        mut.mutate(productDto, {
          onSuccess: (res) => {
            // Save reorder settings separately (fire-and-forget, don't block nav)
            if (reorderPoint != null || reorderQty != null) {
              reorderMut.mutate({ productId: res.id, reorderPoint, reorderQty });
            }
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
