"use client";

import * as React from "react";
import type { PriceTier } from "@routeflow/pricing";
import { usePriceGrid } from "@/lib/api/usePriceGrid";
import { useTierLabels } from "@/lib/api/tier-labels";
import { tierLabel } from "@/lib/tier-label";
import { ProductPricesGrid } from "../../ProductPricesGrid";
import type { UnitsCardProduct } from "../../ProductUnitsCard";
import { AlsoUpdateSlot } from "./contract-stubs";
import { EDIT_TESTIDS as E } from "./edit-testids";
import { EditBar, SkipToSave } from "./EditBar";
import { OrderUnitDraft } from "./OrderUnitDraft";
import { useGridEdit } from "./useGridEdit";

const BTN =
  "h-9 rounded-md border border-surface-border bg-white px-3 text-sm font-medium text-navy hover:bg-surface-muted";

/**
 * The units v2 prices section with edit mode (S12a). V08: Change prices and a secondary Edit live in the
 * section's own actions; each price is a button that enters edit mode on its input. Every price
 * consequence comes from @routeflow/pricing via useGridEdit (no money math in this folder).
 */
export function EditablePricing({
  product,
  onOpenChangePrices,
  changePricesOpen = false,
}: {
  product: UnitsCardProduct & { msrp?: number | string | null };
  onOpenChangePrices?: () => void;
  changePricesOpen?: boolean;
}) {
  const grid = usePriceGrid(product.id);
  const labels = useTierLabels().data;
  const tierName = React.useCallback(
    (t: PriceTier) => (t === 1 ? "Retail" : tierLabel(labels, t)),
    [labels],
  );
  const edit = useGridEdit(product.id, grid.data, tierName);
  const { editing } = edit.api;

  return (
    <div className="relative">
      {editing && <SkipToSave />}
      <div className="mb-2 flex flex-wrap items-center justify-end gap-2">
        <button
          type="button"
          data-testid={E.changeOpen}
          aria-expanded={changePricesOpen}
          aria-controls="units-v2-change-panel"
          className={BTN}
          onClick={() => onOpenChangePrices?.()}
        >
          Change prices
        </button>
        {!editing && (
          <button
            type="button"
            data-testid={E.editOpen}
            className={BTN}
            onClick={() => edit.api.begin()}
          >
            Edit
          </button>
        )}
      </div>
      <ProductPricesGrid product={product} edit={edit.api} />
      {editing && grid.data && <OrderUnitDraft data={grid.data} edit={edit} tierName={tierName} />}
      <AlsoUpdateSlot hasEdits={(edit.plan?.patches.length ?? 0) > 0} />
      {editing && (
        <EditBar
          count={edit.count}
          problems={edit.plan?.problems ?? []}
          canSave={edit.canSave}
          pending={edit.pending}
          onSave={edit.save}
          onCancel={edit.cancel}
        />
      )}
    </div>
  );
}
