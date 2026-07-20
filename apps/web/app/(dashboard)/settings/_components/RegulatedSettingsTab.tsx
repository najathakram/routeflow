"use client";

import * as React from "react";
import { Boxes, Check, Loader2, Pencil, Plus, Power, ShieldCheck, X } from "lucide-react";
import { Badge, Button, useToast } from "@routeflow/ui/web";
import {
  useTrackedCategories,
  useToggleTrackedCategory,
  useTrackedSubcategories,
  useCreateSubcategory,
  useUpdateSubcategory,
  useToggleSubcategory,
  type TrackedCategory,
  type TrackedSubcategory,
} from "@/lib/api/tracked-categories";
import { taxRuleLabel, treatmentLabel } from "@/lib/regulated-format";
import { CategoryFormModal } from "@/components/CategoryFormModal";
import { AssignProductsModal } from "@/components/AssignProductsModal";

/**
 * TENANT_ADMIN management home for regulated sections + subcategories (Phase 4 C).
 * Sections carry all compliance semantics (tax / license / invoice treatment);
 * subcategories are classification-only and managed inline per section.
 */
export function RegulatedSettingsTab() {
  const { toast } = useToast();
  const { data: sections = [], isLoading } = useTrackedCategories();
  const toggle = useToggleTrackedCategory();

  const [formOpen, setFormOpen] = React.useState(false);
  const [editing, setEditing] = React.useState<TrackedCategory | null>(null);
  const [assignFor, setAssignFor] = React.useState<TrackedCategory | null>(null);

  const openNew = () => {
    setEditing(null);
    setFormOpen(true);
  };
  const openEdit = (c: TrackedCategory) => {
    setEditing(c);
    setFormOpen(true);
  };
  const handleToggle = (c: TrackedCategory) =>
    toggle.mutate(c.id, {
      onSuccess: (updated) =>
        toast({
          title: updated.active ? `${c.name} activated` : `${c.name} deactivated`,
          variant: "success",
        }),
      onError: () => toast({ title: "Failed to update type", variant: "error" }),
    });

  return (
    <div className="space-y-5">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h2 className="text-lg font-semibold text-navy">Regulated types</h2>
          <p className="mt-0.5 text-sm text-navy/70">
            Separately-handled categories (tobacco, alcohol, deposits…) and their categories. Types
            drive tax, licensing and invoicing; categories are for reporting.
          </p>
        </div>
        <Button leftIcon={<Plus className="h-4 w-4" />} onClick={openNew}>
          New type
        </Button>
      </div>

      {isLoading ? (
        <div className="flex items-center justify-center py-10">
          <Loader2 className="h-6 w-6 animate-spin text-navy/50" />
        </div>
      ) : sections.length === 0 ? (
        <div className="rounded-xl border border-dashed border-surface-border bg-surface-raised/40 py-10 text-center text-sm text-navy/70">
          No regulated types yet.{" "}
          <button
            type="button"
            onClick={openNew}
            className="font-medium text-brand-600 hover:underline"
          >
            Create your first type
          </button>
          .
        </div>
      ) : (
        <div className="space-y-4">
          {sections.map((section) => (
            <SectionPanel
              key={section.id}
              section={section}
              onEdit={() => openEdit(section)}
              onAssign={() => setAssignFor(section)}
              onToggle={() => handleToggle(section)}
              toggling={toggle.isPending}
            />
          ))}
        </div>
      )}

      <CategoryFormModal isOpen={formOpen} onClose={() => setFormOpen(false)} category={editing} />
      <AssignProductsModal
        isOpen={!!assignFor}
        onClose={() => setAssignFor(null)}
        category={assignFor}
      />
    </div>
  );
}

function SectionPanel({
  section,
  onEdit,
  onAssign,
  onToggle,
  toggling,
}: {
  section: TrackedCategory;
  onEdit: () => void;
  onAssign: () => void;
  onToggle: () => void;
  toggling: boolean;
}) {
  const actionCls =
    "inline-flex items-center gap-1 rounded-md px-2 py-1 text-xs font-medium text-navy/70 hover:bg-surface-raised hover:text-navy disabled:opacity-50";

  return (
    <div
      className={`rounded-xl border border-surface-border bg-white p-4 ${section.active ? "" : "opacity-70"}`}
    >
      <div className="flex items-start justify-between gap-2">
        <div className="flex items-center gap-2">
          <ShieldCheck className="h-4 w-4 text-brand-600" />
          <span className="font-semibold text-navy">{section.name}</span>
        </div>
        <div className="flex items-center gap-1.5">
          {section.requiresLicense && <Badge variant="warning" label="License" />}
          <Badge
            variant={section.active ? "success" : "neutral"}
            label={section.active ? "Active" : "Off"}
          />
        </div>
      </div>

      <p className="mt-2 text-xs text-navy/60">
        {taxRuleLabel(section)} · {treatmentLabel(section.invoiceTreatment)} ·{" "}
        {section.productCount} {section.productCount === 1 ? "product" : "products"}
      </p>

      <div className="mt-2 flex items-center gap-1 border-t border-surface-border pt-2">
        <button type="button" onClick={onAssign} className={actionCls}>
          <Boxes className="h-3.5 w-3.5" /> Products
        </button>
        <button type="button" onClick={onEdit} className={actionCls}>
          <Pencil className="h-3.5 w-3.5" /> Edit
        </button>
        <button
          type="button"
          onClick={onToggle}
          disabled={toggling}
          className={`ml-auto ${actionCls}`}
        >
          <Power className="h-3.5 w-3.5" /> {section.active ? "Deactivate" : "Activate"}
        </button>
      </div>

      <SubcategoryManager section={section} />
    </div>
  );
}

function SubcategoryManager({ section }: { section: TrackedCategory }) {
  const { toast } = useToast();
  const { data: subs = [], isLoading } = useTrackedSubcategories(section.id);
  const create = useCreateSubcategory();
  const update = useUpdateSubcategory();
  const toggleSub = useToggleSubcategory();

  const [newName, setNewName] = React.useState("");
  const [renamingId, setRenamingId] = React.useState<string | null>(null);
  const [renameValue, setRenameValue] = React.useState("");

  const errMsg = (e: any, fallback: string) =>
    toast({
      title: e?.response?.data?.message ?? fallback,
      variant: "error",
    });

  const addSub = (e: React.FormEvent) => {
    e.preventDefault();
    const name = newName.trim();
    if (!name) return;
    create.mutate(
      { categoryId: section.id, name },
      {
        onSuccess: () => {
          setNewName("");
          toast({ title: `Category "${name}" added`, variant: "success" });
        },
        onError: (e) => errMsg(e, "Failed to add category"),
      },
    );
  };

  const startRename = (s: TrackedSubcategory) => {
    setRenamingId(s.id);
    setRenameValue(s.name);
  };
  const saveRename = (s: TrackedSubcategory) => {
    const name = renameValue.trim();
    if (!name || name === s.name) {
      setRenamingId(null);
      return;
    }
    update.mutate(
      { categoryId: section.id, subId: s.id, data: { name } },
      {
        onSuccess: () => {
          setRenamingId(null);
          toast({ title: "Category renamed", variant: "success" });
        },
        onError: (e) => errMsg(e, "Failed to rename category"),
      },
    );
  };

  const toggleActive = (s: TrackedSubcategory) =>
    toggleSub.mutate(
      { categoryId: section.id, subId: s.id },
      {
        onSuccess: (updated) =>
          toast({
            title: updated.active ? `${s.name} activated` : `${s.name} deactivated`,
            variant: "success",
          }),
        onError: (e) => errMsg(e, "Failed to update category"),
      },
    );

  return (
    <div className="mt-3 rounded-lg border border-surface-border bg-surface-raised/30 p-3">
      <p className="mb-2 text-[11px] font-semibold uppercase tracking-[0.08em] text-navy/60">
        Categories
      </p>

      {isLoading ? (
        <div className="flex items-center gap-2 py-2 text-xs text-navy/50">
          <Loader2 className="h-3.5 w-3.5 animate-spin" /> Loading…
        </div>
      ) : subs.length === 0 ? (
        <p className="mb-2 text-xs text-navy/50">
          None yet — add categories to classify products within this type.
        </p>
      ) : (
        <ul className="mb-2 space-y-1">
          {subs.map((s) => (
            <li
              key={s.id}
              className={`flex items-center gap-2 rounded-md px-2 py-1 text-sm ${s.active ? "text-navy" : "text-navy/50"}`}
            >
              {renamingId === s.id ? (
                <>
                  <input
                    autoFocus
                    value={renameValue}
                    onChange={(e) => setRenameValue(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") saveRename(s);
                      if (e.key === "Escape") setRenamingId(null);
                    }}
                    className="flex-1 rounded border border-surface-border px-2 py-0.5 text-sm text-navy focus:outline-none focus:ring-2 focus:ring-brand-500"
                  />
                  <button
                    type="button"
                    onClick={() => saveRename(s)}
                    disabled={update.isPending}
                    className="rounded p-1 text-brand-600 hover:bg-surface-raised disabled:opacity-50"
                    title="Save"
                  >
                    <Check className="h-3.5 w-3.5" />
                  </button>
                  <button
                    type="button"
                    onClick={() => setRenamingId(null)}
                    className="rounded p-1 text-navy/60 hover:bg-surface-raised"
                    title="Cancel"
                  >
                    <X className="h-3.5 w-3.5" />
                  </button>
                </>
              ) : (
                <>
                  <span className="flex-1 truncate">
                    {s.name}
                    {!s.active && <span className="ml-1 text-[11px]">(off)</span>}
                  </span>
                  <span className="text-[11px] text-navy/50">
                    {s.productCount} {s.productCount === 1 ? "product" : "products"}
                  </span>
                  <button
                    type="button"
                    onClick={() => startRename(s)}
                    className="rounded p-1 text-navy/60 hover:bg-surface-raised hover:text-navy"
                    title="Rename"
                  >
                    <Pencil className="h-3.5 w-3.5" />
                  </button>
                  <button
                    type="button"
                    onClick={() => toggleActive(s)}
                    disabled={toggleSub.isPending}
                    className="rounded p-1 text-navy/60 hover:bg-surface-raised hover:text-navy disabled:opacity-50"
                    title={s.active ? "Deactivate" : "Activate"}
                  >
                    <Power className="h-3.5 w-3.5" />
                  </button>
                </>
              )}
            </li>
          ))}
        </ul>
      )}

      <form onSubmit={addSub} className="flex items-center gap-2">
        <input
          value={newName}
          onChange={(e) => setNewName(e.target.value)}
          placeholder="Add a category…"
          className="flex-1 rounded border border-surface-border px-2 py-1 text-sm text-navy focus:outline-none focus:ring-2 focus:ring-brand-500"
        />
        <Button
          type="submit"
          variant="secondary"
          size="sm"
          loading={create.isPending}
          disabled={!newName.trim()}
        >
          Add
        </Button>
      </form>
    </div>
  );
}
