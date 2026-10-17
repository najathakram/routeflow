import { useOptionalAuth } from "@/lib/auth-context";
import { useUnitsEnabled } from "@/lib/api/product-units";

/** A product the unit ladder cannot be edited on: a family, a recipe, or a variant priced by its family. */
export const unitStructureGoverned = (p: {
  kind?: string | null;
  parentProductId?: string | null;
}): boolean => p.kind === "FAMILY" || p.kind === "RECIPE" || !!p.parentProductId;

/**
 * K10d: may the v2 shell show Add a unit / Remove / Reset to Auto? The same gate as the old Units card (an
 * operator-side role and `flag.units_v1`, because the unit writes are plan-gated on the server) plus the editing
 * rules: never on a family, recipe or variant. Fails CLOSED: with no signed-in user or an unknown flag it is false,
 * and the billing request is not even fired for a role that could not use it.
 */
export function useUnitStructureAllowed(product: {
  kind?: string | null;
  parentProductId?: string | null;
}): boolean {
  const role = useOptionalAuth()?.user?.role;
  const canManage = role === "OPERATOR" || role === "TENANT_ADMIN";
  const unitsOn = useUnitsEnabled({ enabled: canManage });
  return canManage && unitsOn && !unitStructureGoverned(product);
}

/**
 * Has the v2 shell mounted its Add a unit? It waits for the price grid (the "of" choices and the base unit's name come
 * from it), so until a grid with rows has loaded the old Units card keeps its own Add form and Remove buttons.
 */
export const shellHasUnitControls = (
  grid: { rows: readonly unknown[] } | null | undefined,
): boolean => !!grid && grid.rows.length > 0;

/** Does the shell give this unit its own Remove? Only the grid's editable `unit` rows (never Case or Piece). */
export const shellRemovesUnit = (
  grid: { rows: readonly { ref: string; kind: string; editable: boolean }[] } | null | undefined,
  unitId: string,
): boolean => !!grid && grid.rows.some((r) => r.ref === unitId && r.kind === "unit" && r.editable);
