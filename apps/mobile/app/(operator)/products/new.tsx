import * as React from "react";
import { useLocalSearchParams, useRouter } from "expo-router";
import { suggestPackSize } from "@routeflow/types";
import { ProductForm, emptyProductForm, type SubmitPayload } from "../../../components/ProductForm";
import { PackSizeSheet } from "../../../components/PackSizeSheet";
import { packSizePromptFor } from "../../../lib/pack-size-logic";
import { useCreateProduct, useUpdateReorderSettings } from "../../../lib/api/products";
import { showToast } from "../../../lib/toast";

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

export default function NewProductScreen() {
  const router = useRouter();
  const params = useLocalSearchParams<{ barcode?: string }>();
  const mut = useCreateProduct();
  const reorderMut = useUpdateReorderSettings();
  // Held between "Save" and the pack-size decision — never auto-resolved.
  const [pending, setPending] = React.useState<SubmitPayload | null>(null);

  // Blank unit rather than `emptyProductForm()`'s "ea" default — an untouched
  // placeholder must not read as an operator assertion that this row is
  // piece-priced (see `packSizePromptForPayload`, which would otherwise
  // always classify it PIECE_UNIT and the sheet could never appear on
  // create). The Unit input still shows its "ea, kg, box" placeholder text
  // when blank.
  //
  // `finalize` below persists that blank verbatim rather than substituting
  // "ea". Substituting it classified the suggestion against "" (not a piece
  // unit, so the sheet appears) while SAVING "ea" (a piece unit) next to the
  // accepted unitsPerBox — the guard would judge a value that was never
  // written and miss the one that was. Web's ProductCreateModal already
  // defaults and persists a blank unit, so this matches the golden reference.
  const initial = {
    ...emptyProductForm(),
    unit: "",
    barcode: params.barcode ?? "",
  };

  const finalize = (payload: SubmitPayload) => {
    const { reorderPoint, reorderQty, ...productDto } = payload;
    mut.mutate(
      { ...productDto, unit: productDto.unit ?? "" },
      {
        onSuccess: (res) => {
          // Save reorder settings separately (fire-and-forget, don't block nav)
          if (reorderPoint != null || reorderQty != null) {
            reorderMut.mutate({ productId: res.id, reorderPoint, reorderQty });
          }
          showToast("Product created");
          router.replace(`/(operator)/products/${res.id}`);
        },
        onError: (e: any) => showToast(e?.response?.data?.message ?? e?.message ?? "Try again."),
      },
    );
  };

  return (
    <>
      <ProductForm
        title="New product"
        submitLabel={mut.isPending ? "Saving…" : "Save"}
        submitting={mut.isPending}
        mode="create"
        initial={initial}
        onSubmit={(payload) => {
          if (packSizePromptForPayload(payload)) {
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
