"use client";

import * as React from "react";
import { Heart, Lock } from "lucide-react";
import type { BuyerCatalogCounts, LockedCategory } from "@/lib/api/buyer";

export type RailSelection =
  | { kind: "all" }
  | { kind: "collection"; collection: "usuals" | "favorites" | "new" | "deals" }
  | { kind: "category"; name: string }
  | { kind: "locked"; id: string };

export interface CategoryRailProps {
  counts: BuyerCatalogCounts | undefined;
  selection: RailSelection;
  onSelect: (s: RailSelection) => void;
}

function isSelected(selection: RailSelection, candidate: RailSelection): boolean {
  if (selection.kind !== candidate.kind) return false;
  if (selection.kind === "collection" && candidate.kind === "collection") {
    return selection.collection === candidate.collection;
  }
  if (selection.kind === "category" && candidate.kind === "category") {
    return selection.name === candidate.name;
  }
  if (selection.kind === "locked" && candidate.kind === "locked") {
    return selection.id === candidate.id;
  }
  return selection.kind === "all";
}

function RailRow({
  label,
  count,
  active,
  icon,
  onClick,
}: {
  label: string;
  count: number;
  active: boolean;
  icon?: React.ReactNode;
  onClick: () => void;
}) {
  return (
    <button
      onClick={onClick}
      className={`flex w-full items-center justify-between rounded-lg px-2.5 py-2 text-left text-sm transition-colors ${
        active ? "bg-buyer-50 text-buyer-700 font-semibold" : "text-navy/80 hover:bg-surface-raised"
      }`}
    >
      <span className="flex items-center gap-2 truncate">
        {icon}
        <span className="truncate">{label}</span>
      </span>
      <span className="ml-2 shrink-0 font-mono text-xs text-navy/50">{count}</span>
    </button>
  );
}

function LockedRow({
  category,
  active,
  onClick,
}: {
  category: LockedCategory;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <button
      onClick={onClick}
      className={`flex w-full items-center justify-between rounded-lg px-2.5 py-2 text-left text-sm text-navy/40 transition-colors ${
        active ? "bg-buyer-50 text-buyer-700 font-semibold" : "hover:bg-surface-raised"
      }`}
    >
      <span className="flex items-center gap-2 truncate">
        <Lock className="h-3.5 w-3.5 shrink-0" />
        <span className="truncate">{category.name}</span>
      </span>
      <span className="ml-2 shrink-0 text-xs italic text-navy/40">locked</span>
    </button>
  );
}

/** Category rail: All / smart collections / per-category counts / locked categories. */
export function CategoryRail({ counts, selection, onSelect }: CategoryRailProps) {
  if (!counts) {
    return (
      <div className="flex flex-col gap-1 rounded-card border border-surface-border bg-white p-2">
        {Array.from({ length: 6 }).map((_, i) => (
          <div key={i} className="h-8 animate-pulse rounded-lg bg-surface-raised" />
        ))}
      </div>
    );
  }

  const { total, categories, collections, lockedCategories } = counts;

  return (
    <div className="flex flex-col gap-1 rounded-card border border-surface-border bg-white p-2">
      <RailRow
        label="All products"
        count={total}
        active={isSelected(selection, { kind: "all" })}
        onClick={() => onSelect({ kind: "all" })}
      />

      {collections.usuals > 0 && (
        <RailRow
          label="Your usuals"
          count={collections.usuals}
          active={isSelected(selection, { kind: "collection", collection: "usuals" })}
          onClick={() => onSelect({ kind: "collection", collection: "usuals" })}
        />
      )}

      {/* Favorites is always visible, even at zero, per spec. */}
      <RailRow
        label="Favorites"
        count={collections.favorites}
        icon={<Heart className="h-3.5 w-3.5 shrink-0" />}
        active={isSelected(selection, { kind: "collection", collection: "favorites" })}
        onClick={() => onSelect({ kind: "collection", collection: "favorites" })}
      />

      {collections.new > 0 && (
        <RailRow
          label="New this month"
          count={collections.new}
          active={isSelected(selection, { kind: "collection", collection: "new" })}
          onClick={() => onSelect({ kind: "collection", collection: "new" })}
        />
      )}

      {collections.deals > 0 && (
        <RailRow
          label="Deals"
          count={collections.deals}
          active={isSelected(selection, { kind: "collection", collection: "deals" })}
          onClick={() => onSelect({ kind: "collection", collection: "deals" })}
        />
      )}

      {(categories.length > 0 || lockedCategories.length > 0) && (
        <div className="my-1 border-t border-surface-border" />
      )}

      {categories.map((c) => (
        <RailRow
          key={c.name}
          label={c.name}
          count={c.count}
          active={isSelected(selection, { kind: "category", name: c.name })}
          onClick={() => onSelect({ kind: "category", name: c.name })}
        />
      ))}

      {lockedCategories.map((c) => (
        <LockedRow
          key={c.id}
          category={c}
          active={isSelected(selection, { kind: "locked", id: c.id })}
          onClick={() => onSelect({ kind: "locked", id: c.id })}
        />
      ))}
    </div>
  );
}

export default CategoryRail;
