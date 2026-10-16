import * as React from "react";
import { ActivityIndicator, View } from "react-native";
import { useLocalSearchParams, useRouter } from "expo-router";
import { ios } from "@routeflow/ui/tokens";
import { suggestPackSize, type ProductPackAtOpen } from "@routeflow/types";
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
import { productSaveErrorCopy } from "../../../../lib/product-save-error-copy";
import { expectedPackFor } from "../../../../lib/product-edit-pack";
import { alertInfo, confirm } from "../../../../lib/confirm";
import { getFamilyCascadePrompt } from "../../../../lib/product-family-cascade";
import {
  getProductConflictRefusal,
  reactivationResolveLabel,
  type ReactivationRefusal,
} from "../../../../lib/product-reactivation-refusal";

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
  // SA-797: the pack this form OPENED with (the first loaded product, never a later refetch). The save sends it
  // back as the expected values, so a Settings > Units rename made meanwhile is a 409, not overwritten.
  const openedPack = React.useRef<ProductPackAtOpen | null>(null);
  React.useEffect(() => {
    if (product && !openedPack.current) {
      openedPack.current = {
        unit: product.unit,
        unitsPerBox: product.unitsPerBox ?? null,
        packTenantUnitId: product.packTenantUnitId,
      };
    }
  }, [product]);

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

  const finalize = (
    payload: SubmitPayload,
    deactivateHolderIds?: string[],
    confirmCascade?: boolean,
  ) => {
    if (!id) return;
    const { reorderPoint, reorderQty, ...productDto } = payload;
    mut.mutate(
      {
        id,
        ...productDto,
        ...expectedPackFor(productDto.unit, openedPack.current),
        ...(deactivateHolderIds?.length ? { deactivateHolderIds } : {}),
        ...(confirmCascade ? { confirmCascade: true } : {}),
      },
      {
        onSuccess: () => {
          // Save reorder settings separately (PATCH /inventory/products/:id/reorder-settings)
          if (reorderPoint != null || reorderQty != null) {
            reorderMut.mutate({ productId: id, reorderPoint, reorderQty });
          }
          showToast("Saved");
          router.back();
        },
        onError: (e: unknown) => {
          // A family with active variants: ask once, then resend with confirmCascade (never auto-confirmed).
          const cascade = getFamilyCascadePrompt(e);
          if (cascade && !confirmCascade) {
            confirm(
              cascade.title,
              cascade.body,
              () => finalize(payload, deactivateHolderIds, true),
              {
                confirmText: cascade.confirmText,
                destructive: true,
              },
            );
            return;
          }
          // Fixed copy only: the server message is never shown.
          // Resolve (deactivate holders) only for a reactivation; an ordinary edit's clash is info only.
          const refusal = getProductConflictRefusal(e, {
            storedIsActive: product.isActive,
            payloadIsActive: payload.isActive,
          });
          if (refusal) return askReactivationResolve(refusal, payload);
          showToast(productSaveErrorCopy(e));
        },
      },
    );
  };

  /** A reactivation the server refused: name the holders, offer to deactivate them, re-send with their ids. */
  const askReactivationResolve = (refusal: ReactivationRefusal, payload: SubmitPayload) => {
    if (refusal.kind === "RETRY") {
      alertInfo("Products changed", "The conflicting products changed. Save again to continue.");
      return;
    }
    if (refusal.kind === "INFO") {
      alertInfo("Can't save", refusal.lines.join("\n\n"));
      return;
    }
    const lines = refusal.holders.map((h) => h.line).join("\n\n");
    if (!refusal.canResolve) {
      alertInfo("Can't reactivate", lines);
      return;
    }
    confirm("Can't reactivate yet", lines, () => finalize(payload, refusal.holderIds), {
      confirmText: reactivationResolveLabel(refusal.holders.map((h) => h.productName)),
      destructive: true,
    });
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
