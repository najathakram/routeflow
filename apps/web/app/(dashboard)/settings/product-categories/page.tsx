"use client";

import * as React from "react";
import NextLink from "next/link";
import {
  ArrowLeft,
  Archive,
  ArchiveRestore,
  Ban,
  Check,
  Loader2,
  Pencil,
  Plus,
  X,
} from "lucide-react";
import { Badge, Button, useToast } from "@routeflow/ui/web";
import { usePageTitle } from "@/lib/page-title-context";
import { useAuth } from "@/lib/auth-context";
import { useReadOnlyGate } from "@/lib/read-only-gate";
import { LimitInPortalDialog } from "@/components/portal-limits/LimitInPortalDialog";
import {
  useCreateProductCategory,
  useProductCategories,
  useUpdateProductCategory,
  type LabelCategoryDto,
} from "@/lib/api/product-labels";

const actionCls =
  "inline-flex items-center gap-1 rounded-md px-2 py-1 text-xs font-medium text-navy/70 hover:bg-surface-raised hover:text-navy disabled:opacity-50";

// Errors are NOT toasted here: app/providers.tsx's global MutationCache handler already shows the
// server message once (a second toast here doubled it — B594 class).
const okToast = (title: string) => ({ title, variant: "success" as const });

/** Label manager: the restriction categories products are labelled with (TENANT_ADMIN writes). */
export default function ProductCategoriesPage() {
  const { setTitle } = usePageTitle();
  React.useEffect(() => {
    setTitle("Product labels");
  }, [setTitle]);
  const { user } = useAuth();
  const isAdmin = user?.role === "TENANT_ADMIN";
  // Owner ruling 10-07: operators are near-admins and may limit products in the portal (the server decides).
  const canLimit = isAdmin || user?.role === "OPERATOR";
  const readOnly = useReadOnlyGate().readOnly;
  const [limiting, setLimiting] = React.useState<LabelCategoryDto | null>(null);
  const { toast } = useToast();
  const [showArchived, setShowArchived] = React.useState(false);
  const { data: categories = [], isLoading, isError } = useProductCategories(showArchived);
  const create = useCreateProductCategory();
  const update = useUpdateProductCategory();

  const [newName, setNewName] = React.useState("");
  const [renamingId, setRenamingId] = React.useState<string | null>(null);
  const [renameValue, setRenameValue] = React.useState("");

  const add = (e: React.FormEvent) => {
    e.preventDefault();
    const name = newName.trim();
    if (!name) return;
    create.mutate(
      { name },
      {
        onSuccess: () => {
          setNewName("");
          toast(okToast(`Label "${name}" added`));
        },
      },
    );
  };

  const saveRename = (c: LabelCategoryDto) => {
    const name = renameValue.trim();
    if (!name || name === c.name) {
      setRenamingId(null);
      return;
    }
    update.mutate(
      { id: c.id, data: { name } },
      {
        onSuccess: () => {
          setRenamingId(null);
          toast(okToast("Label renamed"));
        },
      },
    );
  };

  const setArchived = (c: LabelCategoryDto, archived: boolean) =>
    update.mutate(
      { id: c.id, data: { archived } },
      {
        onSuccess: () => toast(okToast(archived ? `${c.name} archived` : `${c.name} restored`)),
      },
    );

  return (
    <div className="mx-auto max-w-3xl p-6">
      <NextLink
        href="/settings"
        className="mb-4 inline-flex items-center gap-1.5 text-sm font-medium text-navy/60 transition-colors hover:text-brand-600"
      >
        <ArrowLeft className="h-4 w-4" /> All settings
      </NextLink>
      <h2 className="text-2xl font-bold text-navy">Product labels</h2>
      <p className="mb-5 mt-1 text-sm text-navy/70">
        Labels group products for selling restrictions. Apply them on each product&apos;s page.
        {!isAdmin && " Only a workspace admin can change labels."}
      </p>

      {isAdmin && (
        <form onSubmit={add} className="mb-4 flex items-center gap-2">
          <input
            value={newName}
            onChange={(e) => setNewName(e.target.value)}
            maxLength={80}
            aria-label="New label name"
            placeholder="New label, e.g. Alcohol"
            className="h-10 flex-1 rounded border border-surface-border px-3 text-sm text-navy focus:outline-none focus:ring-2 focus:ring-brand-500"
          />
          <Button
            type="submit"
            leftIcon={<Plus className="h-4 w-4" />}
            loading={create.isPending}
            disabled={!newName.trim()}
          >
            Add label
          </Button>
        </form>
      )}

      <label className="mb-3 flex items-center gap-2 text-sm text-navy/70">
        <input
          type="checkbox"
          checked={showArchived}
          onChange={(e) => setShowArchived(e.target.checked)}
        />
        Show archived
      </label>

      {isLoading ? (
        <Loader2 className="mx-auto my-10 h-6 w-6 animate-spin text-navy/50" aria-label="Loading" />
      ) : isError ? (
        <div className="rounded-xl border border-danger/30 bg-danger/5 py-8 text-center text-sm text-danger">
          Couldn&apos;t load labels. Refresh to try again.
        </div>
      ) : categories.length === 0 ? (
        <div className="rounded-xl border border-dashed border-surface-border bg-surface-raised/40 py-10 text-center text-sm text-navy/70">
          No labels yet.{isAdmin ? " Add your first one above." : ""}
        </div>
      ) : (
        <ul className="divide-y divide-surface-border rounded-xl border border-surface-border bg-white">
          {categories.map((c) => (
            <li
              key={c.id}
              className={`flex flex-wrap items-center gap-x-3 gap-y-1 px-4 py-3 ${c.archivedAt ? "opacity-60" : ""}`}
            >
              {renamingId === c.id ? (
                <>
                  <input
                    autoFocus
                    value={renameValue}
                    maxLength={80}
                    aria-label={`Rename ${c.name}`}
                    onChange={(e) => setRenameValue(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") saveRename(c);
                      if (e.key === "Escape") setRenamingId(null);
                    }}
                    className="min-w-0 flex-1 rounded border border-surface-border px-2 py-1 text-sm text-navy focus:outline-none focus:ring-2 focus:ring-brand-500"
                  />
                  <IconBtn
                    title="Save"
                    aria-label="Save name"
                    disabled={update.isPending}
                    onClick={() => saveRename(c)}
                  >
                    <Check className="h-4 w-4 text-brand-600" />
                  </IconBtn>
                  <IconBtn
                    title="Cancel"
                    aria-label="Cancel rename"
                    onClick={() => setRenamingId(null)}
                  >
                    <X className="h-4 w-4" />
                  </IconBtn>
                </>
              ) : (
                <>
                  <span className="min-w-0 flex-1 truncate font-medium text-navy">{c.name}</span>
                  {c.archivedAt && <Badge variant="neutral" label="Archived" />}
                  {c.activeRestrictionCount > 0 && (
                    <Badge
                      variant="warning"
                      label={`${c.activeRestrictionCount} active ${c.activeRestrictionCount === 1 ? "rule" : "rules"}`}
                    />
                  )}
                  <span className="text-xs text-navy/60">
                    {c.productCount} {c.productCount === 1 ? "product" : "products"}
                  </span>
                  {canLimit && !c.archivedAt && (
                    <button
                      type="button"
                      className={actionCls}
                      data-testid="category-limit-in-portal"
                      disabled={readOnly}
                      onClick={() => setLimiting(c)}
                    >
                      <Ban className="h-3.5 w-3.5" /> Limit in portal…
                    </button>
                  )}
                  {isAdmin && (
                    <span className="flex items-center gap-1">
                      <button
                        type="button"
                        className={actionCls}
                        onClick={() => {
                          setRenamingId(c.id);
                          setRenameValue(c.name);
                        }}
                      >
                        <Pencil className="h-3.5 w-3.5" /> Rename
                      </button>
                      <button
                        type="button"
                        className={actionCls}
                        disabled={update.isPending}
                        onClick={() => setArchived(c, !c.archivedAt)}
                      >
                        {c.archivedAt ? (
                          <ArchiveRestore className="h-3.5 w-3.5" />
                        ) : (
                          <Archive className="h-3.5 w-3.5" />
                        )}
                        {c.archivedAt ? "Restore" : "Archive"}
                      </button>
                    </span>
                  )}
                </>
              )}
            </li>
          ))}
        </ul>
      )}
      {limiting && (
        <LimitInPortalDialog
          open
          scope={{
            kind: "category",
            categoryId: limiting.id,
            categoryName: limiting.name,
            productCount: limiting.productCount,
          }}
          onClose={() => setLimiting(null)}
        />
      )}
    </div>
  );
}

function IconBtn(props: React.ButtonHTMLAttributes<HTMLButtonElement>) {
  return (
    <button
      type="button"
      {...props}
      className="rounded p-1 text-navy/60 hover:bg-surface-raised disabled:opacity-50"
    />
  );
}
