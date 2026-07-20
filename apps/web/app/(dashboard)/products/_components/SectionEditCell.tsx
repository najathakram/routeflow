"use client";

import * as React from "react";
import type { TrackedCategory } from "@/lib/api/tracked-categories";
import { sectionPickerOptions } from "@/lib/regulated-format";
import { SubcategoryCombobox } from "@/components/SubcategoryCombobox";

const selectCls =
  "h-7 w-36 rounded border border-surface-border bg-white px-1.5 text-xs text-navy focus:outline-none focus:ring-1 focus:ring-brand-500";

interface SectionEditCellProps {
  productId: string;
  trackedCategoryId: string | null;
  trackedSubcategoryId: string | null;
  activeSections: TrackedCategory[];
  /**
   * Resolves a section id → name for sections OUTSIDE `activeSections` (i.e. the
   * product's own current tag when that section was since deactivated) — feeds
   * `sectionPickerOptions`'s current-value escape so a deactivated section still
   * shows a real label instead of dropping off the list silently.
   */
  sectionNameById?: Map<string, string>;
  onSave: (patch: {
    trackedCategoryId: string | null;
    trackedSubcategoryId: string | null;
  }) => void;
  disabled?: boolean;
}

/**
 * Inline Quick-Edit cell for a product's regulated type + category —
 * two dependent, save-on-change selects (no draft state; each change fires
 * immediately). Changing the type ALWAYS clears the category in the same
 * save, mirroring the product detail page's dependent selects — the server
 * independently validates category-parent === type either way.
 */
export function SectionEditCell({
  productId,
  trackedCategoryId,
  trackedSubcategoryId,
  activeSections,
  sectionNameById,
  onSave,
  disabled,
}: SectionEditCellProps) {
  const current = trackedCategoryId
    ? {
        id: trackedCategoryId,
        name: sectionNameById?.get(trackedCategoryId) ?? trackedCategoryId,
      }
    : null;
  const sectionOptions = sectionPickerOptions(activeSections, current);

  return (
    <div className="flex flex-col gap-1">
      <select
        aria-label={`Regulated type for product ${productId}`}
        value={trackedCategoryId ?? ""}
        disabled={disabled}
        onChange={(e) =>
          onSave({ trackedCategoryId: e.target.value || null, trackedSubcategoryId: null })
        }
        className={selectCls}
      >
        <option value="">None (not regulated)</option>
        {sectionOptions.map((s) => (
          <option key={s.id} value={s.id}>
            {s.name}
            {s.inactive ? " (inactive)" : ""}
          </option>
        ))}
      </select>
      {trackedCategoryId && (
        <SubcategoryCombobox
          sectionId={trackedCategoryId}
          value={trackedSubcategoryId ?? ""}
          onChange={(id) => onSave({ trackedCategoryId, trackedSubcategoryId: id || null })}
          disabled={disabled}
          compact
        />
      )}
    </div>
  );
}
