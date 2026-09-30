import * as React from "react";
import { ActivityIndicator, View } from "react-native";
import { useLocalSearchParams, useRouter } from "expo-router";
import { ios } from "@routeflow/ui/tokens";
import { suggestPackSize } from "@routeflow/types";
import {
  ProductForm,
  productFormFromValues,
  type SubmitPayload,
} from "../../../../components/ProductForm";
import { PackSizeSheet } from "../../../../components/PackSizeSheet";
import { packSizePromptFor } from "../../../../lib/pack-size-logic";
import {
  useProduct,
  useUpdateProduct,
  useUpdateReorderSettings,
} from "../../../../lib/api/products";
import { showToast } from "../../../../lib/toast";

/**
 * A name/unit that reads like it's packaged, with `unitsPerBox` still unset,
 * gets a prompt (see PackSizeSheet). Returns null for a piece-priced product,
 * an already-boxed one, or a name with nothing to suggest.
 */
function packSizePromptForPayload(payload: SubmitPayload | null) {
  if (!payload) return null;
  return packSizePromptFor(
    suggestPackSize({
      name: payload.name,
      unit: payload.unit,
      unitSku: payload.unitSku,
      unitsPerBox: payload.unitsPerBox,
    }),
  );
}

// Product ids whose pack-size prompt the operator has already declined this
// app session. Module-level (not component state) so it survives navigating
// away from Edit and back — without it, the blocking sheet re-interrupts
// every subsequent save of the same product, even right after "Skip".
const skippedPackSizePromptIds = new Set<string>();

export default function EditProductScreen() {
  const router = useRouter();
  const { id } = useLocalSearchParams<{ id: string }>();
  const { data: product, isLoading } = useProduct(id ?? "");
  const mut = useUpdateProduct();
  const reorderMut = useUpdateReorderSettings();
  // Held between "Save" and the pack-size decision — never auto-resolved.
  const [pending, setPending] = React.useState<SubmitPayload | null>(null);

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

  const finalize = (payload: SubmitPayload) => {
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
        onError: (e: any) => showToast(e?.response?.data?.message ?? e?.message ?? "Try again."),
      },
    );
  };

  return (
    <>
      <ProductForm
        title="Edit product"
        submitLabel={mut.isPending ? "Saving…" : "Save"}
        submitting={mut.isPending}
        mode="edit"
        initial={productFormFromValues(product)}
        onSubmit={(payload) => {
          const alreadySkipped = !!id && skippedPackSizePromptIds.has(id);
          if (!alreadySkipped && packSizePromptForPayload(payload)) {
            setPending(payload);
            return;
          }
          finalize(payload);
        }}
      />
      <PackSizeSheet
        visible={!!pending}
        prompt={packSizePromptForPayload(pending)}
        submitting={mut.isPending}
        onSkip={() => {
          const payload = pending;
          setPending(null);
          if (id) skippedPackSizePromptIds.add(id);
          if (payload) finalize(payload);
        }}
        onConfirm={(unitsPerBox) => {
          const payload = pending;
          setPending(null);
          if (payload) finalize({ ...payload, unitsPerBox });
        }}
      />
    </>
  );
}
