import { priceGrid, type FamilyCell, type LadderView, type TierRules } from "@routeflow/pricing";
import type { ProductPriceGridDto, ProductPriceGridRowDto } from "@routeflow/types";

/** The grid DTO as a pricing LadderView: a positive Set cell is Set, anything else Auto. */
export function viewFromGrid(g: ProductPriceGridDto): LadderView {
  const rows = [...g.rows]
    .sort((a, b) => b.factor - a.factor)
    .map((r) => ({
      ref: r.ref,
      label: r.label,
      factor: r.factor,
      kind: r.kind,
      set: [1, 2, 3, 4, 5].map((t) => {
        const c = r.cells.find((x) => x.tier === t);
        return c && c.source === "set" && c.value > 0 ? c.value : null;
      }),
    }));
  return { rows, anchor: g.anchor, tierAnchors: g.tierAnchors };
}

/** The tenant's tier rules as the server served them. */
export const rulesFromGrid = (g: ProductPriceGridDto): TierRules => g.tierRules;

/** SA-1082: a variant's five pack cells against its family, as the server served them; null when it follows none. */
export function familyCellsFromGrid(g: ProductPriceGridDto): FamilyCell[] | null {
  const cells = g.rows.find((r) => r.ref === "pack")?.cells ?? [];
  const family = [1, 2, 3, 4, 5].map((t) => cells.find((c) => c.tier === t)?.family);
  return family.every(Boolean) ? (family as FamilyCell[]) : null;
}

/** The same comparison for the draft's numbers, so the word changes as the person types. */
function familyWordOf(
  served: ProductPriceGridRowDto | undefined,
  cells: readonly { tier: number; source: string; value: number }[],
  cell: { tier: number; source: string; value: number },
): { family: FamilyCell } | Record<string, never> {
  const of = (tier: number) => served?.cells.find((c) => c.tier === tier);
  const was = of(cell.tier);
  const family = was?.family;
  const retail = cells.find((c) => c.tier === 1)?.value;
  if (!family) return {};
  const retailFollows = retail != null && retail === of(1)?.family?.value;
  // An untouched cell keeps the server's answer: a blank tier's rule value isn't what the family compares.
  const untouched = was?.source === cell.source && was?.value === cell.value;
  const tierFollows =
    cell.tier === 1 ||
    (untouched && family.follows) ||
    cell.value === (family.value ?? retail) ||
    (family.value == null && cell.source === "auto");
  return { family: { value: family.value, follows: retailFollows && tierFollows } };
}

/** The draft view as grid rows (barcodes kept), so Auto placeholders show the draft values. */
export function previewRows(
  view: LadderView,
  rules: TierRules,
  g: ProductPriceGridDto,
): ProductPriceGridRowDto[] {
  return priceGrid(view, rules).map((r) => ({
    ref: r.ref,
    label: r.label,
    factor: r.factor,
    kind: r.kind,
    code: g.rows.find((x) => x.ref === r.ref)?.code ?? null,
    cells: r.cells.map((c) => ({
      tier: c.tier,
      source: c.source,
      value: c.value,
      ...familyWordOf(
        g.rows.find((x) => x.ref === r.ref),
        r.cells,
        c,
      ),
    })),
    // the row's editability is the server's; the preview keeps it
    ...editability(g.rows.find((x) => x.ref === r.ref) as ProductPriceGridRowDto),
  }));
}

function editability(row: ProductPriceGridRowDto) {
  return {
    editable: row.editable,
    ...(row.notEditableReason ? { notEditableReason: row.notEditableReason } : {}),
    ...(row.unbacked ? { unbacked: true } : {}),
  };
}
