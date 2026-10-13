"use client";

import * as React from "react";
import NextLink from "next/link";
import { Button, Input, Modal, Select, Textarea, useToast } from "@routeflow/ui/web";
import { useAuth } from "@/lib/auth-context";
import { useProducts } from "@/lib/api/products";
import { useProductCategories } from "@/lib/api/product-labels";
import { useCreateRestriction } from "@/lib/api/restrictions-admin-write";
import {
  REASON_MAX,
  emptyRuleForm,
  ruleFormSchema,
  toCreateRequest,
  type RuleFormValues,
} from "@/lib/restriction-rule-form";
import { StatePicker } from "./StatePicker";

const PRODUCT_LIMIT = 8;
type Errors = Partial<Record<keyof RuleFormValues, string>>;

const Legend = ({ children }: { children: React.ReactNode }) => (
  <legend className="mb-1 text-sm font-medium text-navy">{children}</legend>
);

/** Search-and-pick for a single product; the picked one shows by name with a Change button. */
function ProductPick({
  pickedName,
  onPick,
  error,
}: {
  pickedName: string;
  onPick: (id: string, name: string) => void;
  error?: string;
}) {
  const [q, setQ] = React.useState("");
  const [term, setTerm] = React.useState("");
  React.useEffect(() => {
    const t = setTimeout(() => setTerm(q.trim()), 300);
    return () => clearTimeout(t);
  }, [q]);
  const { data } = useProducts(
    { search: term || undefined, isActive: true, limit: PRODUCT_LIMIT },
    { enabled: !!term },
  );
  const results: { id: string; name: string; sku?: string | null }[] = term
    ? (data?.data ?? [])
    : [];

  if (pickedName) {
    return (
      <div className="flex items-center justify-between gap-3 rounded border border-surface-border px-3 py-2">
        <span className="min-w-0 break-words font-medium text-navy">{pickedName}</span>
        <Button type="button" size="sm" variant="secondary" onClick={() => onPick("", "")}>
          Change
        </Button>
      </div>
    );
  }
  return (
    <div className="space-y-2">
      <Input
        aria-label="Search products"
        placeholder="Search products by name or SKU"
        value={q}
        onChange={(e) => setQ(e.target.value)}
        onKeyDown={(e) => e.key === "Enter" && e.preventDefault()}
        error={error}
      />
      {results.length > 0 && (
        <ul
          className="max-h-40 overflow-y-auto rounded border border-surface-border"
          aria-label="Matching products"
        >
          {results.map((p) => (
            <li key={p.id}>
              <button
                type="button"
                onClick={() => onPick(p.id, p.name)}
                className="flex min-h-[40px] w-full items-center gap-2 px-3 text-left text-sm hover:bg-surface-raised"
              >
                <span className="min-w-0 break-words">{p.name}</span>
                {p.sku && <span className="ml-auto text-xs text-navy/60">{p.sku}</span>}
              </button>
            </li>
          ))}
        </ul>
      )}
      {results.length === PRODUCT_LIMIT && (
        <p className="text-xs text-navy/60">
          Showing the first {PRODUCT_LIMIT}. Refine your search.
        </p>
      )}
      {term && results.length === 0 && data && (
        <p className="text-xs text-navy/60">No matching products</p>
      )}
    </div>
  );
}

/**
 * New-rule dialog (Lane R step 5b-2b-i). Validates with the shared form schema, then posts through
 * `useCreateRestriction`. A server refusal ("category is archived…") reaches the user through the
 * app's one global toast — this dialog adds no second message and stays open so the form is kept.
 */
export function RuleFormDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { toast } = useToast();
  const create = useCreateRestriction();
  const categories = useProductCategories(false);
  // Same rule as the Product labels page: only the account admin manages labels.
  const canManageLabels = useAuth().user?.role === "TENANT_ADMIN";
  const noLabels = categories.isSuccess && (categories.data ?? []).length === 0;
  const [v, setV] = React.useState<RuleFormValues>(emptyRuleForm);
  const [productName, setProductName] = React.useState("");
  const [errors, setErrors] = React.useState<Errors>({});
  // The page mounts this only while open, so Radix has no trigger to return focus to: remember
  // who had focus and give it back on close (the BlockedLinesDialog pattern).
  const returnFocusTo = React.useRef<HTMLElement | null>(null);
  const set = <K extends keyof RuleFormValues>(k: K, val: RuleFormValues[K]) => {
    setV((p) => ({ ...p, [k]: val }));
    setErrors((e) => (e[k] ? { ...e, [k]: undefined } : e));
  };

  React.useEffect(() => {
    if (open) {
      setV(emptyRuleForm);
      setProductName("");
      setErrors({});
    }
  }, [open]);

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    const parsed = ruleFormSchema.safeParse(v);
    if (!parsed.success) {
      const next: Errors = {};
      for (const i of parsed.error.issues) next[i.path[0] as keyof RuleFormValues] ??= i.message;
      setErrors(next);
      return;
    }
    setErrors({});
    create.mutate(toCreateRequest(v), {
      onSuccess: () => {
        toast({ title: "Rule added", variant: "success" });
        onClose();
      },
    });
  };

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="New selling restriction"
      description="Stop a category or product being sold where it is banned."
      className="max-h-[92vh] overflow-y-auto"
      onOpenAutoFocus={() => {
        returnFocusTo.current = document.activeElement as HTMLElement | null;
      }}
      onCloseAutoFocus={(e) => {
        const el = returnFocusTo.current;
        returnFocusTo.current = null;
        if (el && el.isConnected && el !== document.body) {
          e.preventDefault();
          el.focus();
        }
      }}
    >
      <form onSubmit={submit} noValidate className="space-y-4">
        <fieldset>
          <Legend>Applies to</Legend>
          <div className="flex gap-4">
            {(["CATEGORY", "PRODUCT"] as const).map((k) => (
              <label key={k} className="flex items-center gap-2">
                <input
                  type="radio"
                  name="targetKind"
                  checked={v.targetKind === k}
                  onChange={() => set("targetKind", k)}
                />
                {k === "CATEGORY" ? "A category" : "One product"}
              </label>
            ))}
          </div>
        </fieldset>

        {v.targetKind === "CATEGORY" && noLabels ? (
          <div>
            <p className="mb-1 text-sm font-medium text-navy">Category</p>
            <p className="text-sm text-navy/70">No product labels yet</p>
            {canManageLabels ? (
              <NextLink
                href="/settings/product-categories"
                className="text-sm font-medium text-navy underline"
              >
                Add product labels
              </NextLink>
            ) : (
              <p className="text-sm text-navy/70">Ask an account admin to add product labels.</p>
            )}
            {errors.categoryId && (
              <p role="alert" className="mt-1 text-xs text-red-600">
                {errors.categoryId}
              </p>
            )}
          </div>
        ) : v.targetKind === "CATEGORY" ? (
          <Select
            label="Category"
            placeholder="Select a category"
            value={v.categoryId}
            onChange={(e) => set("categoryId", e.target.value)}
            options={(categories.data ?? []).map((c) => ({ value: c.id, label: c.name }))}
            error={errors.categoryId}
          />
        ) : (
          <div>
            <p className="mb-1 text-sm font-medium text-navy">Product</p>
            <ProductPick
              pickedName={productName}
              error={errors.productId}
              onPick={(id, name) => {
                set("productId", id);
                setProductName(name);
              }}
            />
          </div>
        )}

        <fieldset>
          <Legend>Where</Legend>
          <div className="flex gap-4">
            {(["STATE", "FEDERAL"] as const).map((j) => (
              <label key={j} className="flex items-center gap-2">
                <input
                  type="radio"
                  name="jurisdiction"
                  checked={v.jurisdiction === j}
                  onChange={() => set("jurisdiction", j)}
                />
                {j === "STATE" ? "Specific states" : "Everywhere (federal)"}
              </label>
            ))}
          </div>
        </fieldset>
        {v.jurisdiction === "STATE" && (
          <StatePicker value={v.states} onChange={(s) => set("states", s)} error={errors.states} />
        )}

        <Select
          label="Sold through"
          value={v.surface}
          onChange={(e) => set("surface", e.target.value as RuleFormValues["surface"])}
          options={[
            { value: "ALL", label: "Every order (staff and buyers)" },
            { value: "BUYER_PORTAL", label: "Buyer portal only" },
          ]}
        />

        <div className="grid gap-3 sm:grid-cols-2">
          <Input
            label="Starts on (blank = now)"
            type="date"
            value={v.startsOn}
            onChange={(e) => set("startsOn", e.target.value)}
          />
          <Input
            label="Ends on (blank = no end)"
            type="date"
            value={v.endsOn}
            onChange={(e) => set("endsOn", e.target.value)}
            error={errors.endsOn}
          />
        </div>

        <Textarea
          label="Reason"
          rows={3}
          maxLength={REASON_MAX + 50}
          value={v.reason}
          onChange={(e) => set("reason", e.target.value)}
          error={errors.reason}
        />

        <div className="flex justify-end gap-3 border-t border-surface-border pt-4">
          <Button type="button" variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" loading={create.isPending}>
            Add rule
          </Button>
        </div>
      </form>
    </Modal>
  );
}
