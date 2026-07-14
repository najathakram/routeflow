import { ActivityIndicator, View } from "react-native";
import { useLocalSearchParams, useRouter } from "expo-router";
import { ios } from "@routeflow/ui/tokens";
import { ProductForm, productFormFromValues } from "../../../../components/ProductForm";
import {
  useProduct,
  useUpdateProduct,
  useUpdateReorderSettings,
} from "../../../../lib/api/products";
import { showToast } from "../../../../lib/toast";

export default function EditProductScreen() {
  const router = useRouter();
  const { id } = useLocalSearchParams<{ id: string }>();
  const { data: product, isLoading } = useProduct(id ?? "");
  const mut = useUpdateProduct();
  const reorderMut = useUpdateReorderSettings();

  if (isLoading || !product) {
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
    <ProductForm
      title="Edit product"
      submitLabel={mut.isPending ? "Saving…" : "Save"}
      submitting={mut.isPending}
      mode="edit"
      initial={productFormFromValues(product)}
      onSubmit={(payload) => {
        if (!id) return;
        const { reorderPoint, reorderQty, ...productDto } = payload;
        mut.mutate(
          { id, ...productDto },
          {
            onSuccess: () => {
              // Save reorder settings separately (PATCH /inventory/products/:id/reorder-settings)
              if (reorderPoint != null || reorderQty != null) {
                reorderMut.mutate({ productId: id, reorderPoint, reorderQty });
              }
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
