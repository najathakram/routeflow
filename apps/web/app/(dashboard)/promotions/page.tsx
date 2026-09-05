"use client";

import * as React from "react";
import { Plus, Pencil, Trash2, X as XIcon, Search, AlertTriangle } from "lucide-react";
import {
  PageHeader,
  Button,
  Badge,
  Modal,
  Select,
  cn,
  EmptyState,
  useToast,
} from "@routeflow/ui/web";
import { usePageTitle } from "@/lib/page-title-context";
import { useProducts, type ApiProduct } from "@/lib/api/products";
import {
  ruleCanZeroPrice,
  scanPromotionZeroPrice,
  zeroPriceWarning,
  type PromoScopeProduct,
  type PromotionRule,
  type ZeroPriceImpact,
} from "@routeflow/pricing";
import {
  usePromotions,
  useCreatePromotion,
  useUpdatePromotion,
  useSetPromotionActive,
  useDeletePromotion,
  promotionStatus,
  promotionRuleLabel,
  type Promotion,
  type PromotionInput,
  type PromotionType,
  type PromotionScope,
  type PromotionStatus,
} from "@/lib/api/promotions";

// ─── Date helpers (ISO ⇄ <input type="datetime-local">) ─────────────────────────

function toLocalInput(iso?: string): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(
    d.getMinutes(),
  )}`;
}

function fromLocalInput(local: string): string {
  // datetime-local is in the operator's local zone; store as UTC ISO.
  return new Date(local).toISOString();
}

function fmtWindow(startsAt: string, endsAt: string): string {
  const opts: Intl.DateTimeFormatOptions = { month: "short", day: "numeric", year: "numeric" };
  const s = new Date(startsAt).toLocaleDateString(undefined, opts);
  const e = new Date(endsAt).toLocaleDateString(undefined, opts);
  return `${s} → ${e}`;
}

/** "6th" from 6, "21st" from 21, etc. — for the BUY_N_GET_M live preview sentence. */
function ordinalSuffix(n: number): string {
  const j = n % 10;
  const k = n % 100;
  if (j === 1 && k !== 11) return `${n}st`;
  if (j === 2 && k !== 12) return `${n}nd`;
  if (j === 3 && k !== 13) return `${n}rd`;
  return `${n}th`;
}

const STATUS_BADGE: Record<
  PromotionStatus,
  { variant: "success" | "warning" | "neutral" | "info"; label: string }
> = {
  ACTIVE: { variant: "success", label: "Active" },
  SCHEDULED: { variant: "info", label: "Scheduled" },
  EXPIRED: { variant: "neutral", label: "Expired" },
  PAUSED: { variant: "warning", label: "Paused" },
};

const TYPE_OPTIONS: { value: PromotionType; label: string }[] = [
  { value: "PERCENT", label: "Percent off" },
  { value: "FIXED", label: "Fixed $ off / unit" },
  { value: "QTY_BREAK", label: "Quantity break (% at threshold)" },
  { value: "BUY_N_GET_M", label: "Buy N get M free" },
];

const SCOPE_OPTIONS: { value: PromotionScope; label: string }[] = [
  { value: "ALL", label: "Entire catalogue" },
  { value: "CATEGORY", label: "A category" },
  { value: "PRODUCTS", label: "Specific products" },
];

// ─── Zero-price blast radius ────────────────────────────────────────────────────
// A promoted net price is floored at $0.00, so a FIXED "$X off" rule sells EVERY
// in-scope product priced at or below $X for nothing — on the portal and on the
// invoice the order bills (2026-08-20: one ALL-scoped $35-off rule zeroed 699 of
// 1,767 products). The catalog is already loaded on this page, so the count is
// computed live from the form and the operator has to confirm it before saving.
// The scan itself lives in pricing.ts — the same helper the API refuses with.

/** Catalog rows in the shape the pricing scan wants (list price, active only). */
function toScopeProducts(products: ApiProduct[]): PromoScopeProduct[] {
  return products
    .filter((p) => p.isActive !== false)
    .map((p) => ({
      id: p.id,
      name: p.name,
      category: p.category ?? null,
      price: p.pricePerUnit,
    }));
}

/** The rule as currently typed, or null while the value is not yet a number. */
function draftRule(form: FormState): PromotionRule | null {
  const value = parseFloat(form.value);
  if (Number.isNaN(value)) return null;
  return {
    id: "draft",
    type: form.type,
    value,
    // Both QTY_BREAK (threshold) and BUY_N_GET_M (N) live in minQty — carry it for
    // either so the draft rule always mirrors what would be saved. The zero-price
    // scan ignores BUY_N_GET_M regardless (it has no net-price form).
    minQty:
      form.type === "QTY_BREAK" || form.type === "BUY_N_GET_M"
        ? parseInt(form.minQty, 10) || null
        : null,
    scope: form.scope,
    category: form.scope === "CATEGORY" ? form.category.trim() : null,
    productIds: form.scope === "PRODUCTS" ? form.productIds : [],
  };
}

/** The impact of a promotion (saved or in-progress) on a catalog — null when clean. */
function zeroPriceImpact(
  rule: PromotionRule | null,
  scopeProducts: PromoScopeProduct[],
): ZeroPriceImpact | null {
  if (!rule || !ruleCanZeroPrice(rule)) return null; // ordinary rules never scan
  const impact = scanPromotionZeroPrice(scopeProducts, rule);
  return impact.count > 0 ? impact : null;
}

/** A saved promotion in the pricing engine's rule shape. */
function promoToRule(p: Promotion): PromotionRule {
  return {
    id: p.id,
    type: p.type,
    value: Number(p.value),
    minQty: p.minQty ?? null,
    scope: p.scope,
    category: p.category ?? null,
    productIds: p.products?.map((pp) => pp.productId) ?? [],
  };
}

// ─── Multi-product picker ───────────────────────────────────────────────────────

function ProductMultiSelect({
  selected,
  onChange,
}: {
  selected: string[];
  onChange: (ids: string[]) => void;
}) {
  const [q, setQ] = React.useState("");
  const { data } = useProducts({ limit: 0 });
  const products: Array<{ id: string; name: string; sku?: string }> = React.useMemo(
    () => data?.data ?? [],
    [data],
  );
  const selectedSet = new Set(selected);

  const filtered = React.useMemo(() => {
    const term = q.trim().toLowerCase();
    const base = products.filter((p) => !selectedSet.has(p.id));
    if (!term) return base.slice(0, 50);
    return base
      .filter(
        (p) => p.name.toLowerCase().includes(term) || (p.sku ?? "").toLowerCase().includes(term),
      )
      .slice(0, 50);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [q, products, selected.join(",")]);

  const byId = React.useMemo(() => new Map(products.map((p) => [p.id, p])), [products]);

  return (
    <div>
      {/* Selected chips */}
      {selected.length > 0 && (
        <div className="mb-2 flex flex-wrap gap-1.5">
          {selected.map((id) => (
            <span
              key={id}
              className="inline-flex items-center gap-1 rounded-full bg-brand-50 px-2 py-0.5 text-xs font-medium text-brand-700 ring-1 ring-brand-200"
            >
              {byId.get(id)?.name ?? id}
              <button
                type="button"
                onClick={() => onChange(selected.filter((x) => x !== id))}
                className="text-brand-500 hover:text-danger"
                aria-label="Remove product"
              >
                <XIcon className="h-3 w-3" />
              </button>
            </span>
          ))}
        </div>
      )}
      <div className="relative">
        <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-navy/40" />
        <input
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="Search products by name or SKU…"
          className="w-full rounded border border-surface-border py-2 pl-8 pr-3 text-sm text-navy focus:outline-none focus:ring-2 focus:ring-brand-500"
        />
      </div>
      <div className="mt-2 max-h-40 overflow-y-auto rounded border border-surface-border">
        {filtered.length === 0 ? (
          <p className="px-3 py-2 text-xs text-navy/50">No matching products.</p>
        ) : (
          filtered.map((p) => (
            <button
              key={p.id}
              type="button"
              onClick={() => onChange([...selected, p.id])}
              className="flex w-full items-center justify-between px-3 py-1.5 text-left text-sm text-navy hover:bg-surface-raised"
            >
              <span className="truncate">{p.name}</span>
              {p.sku && <span className="ml-2 font-mono text-[11px] text-navy/40">{p.sku}</span>}
            </button>
          ))
        )}
      </div>
    </div>
  );
}

// ─── Create / edit modal ────────────────────────────────────────────────────────

interface FormState {
  name: string;
  bannerText: string;
  type: PromotionType;
  value: string;
  minQty: string;
  scope: PromotionScope;
  category: string;
  productIds: string[];
  startsAt: string;
  endsAt: string;
  isActive: boolean;
}

function emptyForm(): FormState {
  return {
    name: "",
    bannerText: "",
    type: "PERCENT",
    value: "",
    minQty: "",
    scope: "ALL",
    category: "",
    productIds: [],
    startsAt: "",
    endsAt: "",
    isActive: true,
  };
}

function promoToForm(p: Promotion): FormState {
  return {
    name: p.name,
    bannerText: p.bannerText ?? "",
    type: p.type,
    value: String(Number(p.value)),
    minQty: p.minQty != null ? String(p.minQty) : "",
    scope: p.scope,
    category: p.category ?? "",
    productIds: p.products?.map((pp) => pp.productId) ?? [],
    startsAt: toLocalInput(p.startsAt),
    endsAt: toLocalInput(p.endsAt),
    isActive: p.isActive,
  };
}

function PromotionFormModal({
  open,
  editing,
  categories,
  scopeProducts,
  onClose,
  onSubmit,
  isSaving,
}: {
  open: boolean;
  editing: Promotion | null;
  categories: string[];
  /** The active catalog, for the live $0.00 blast-radius count. */
  scopeProducts: PromoScopeProduct[];
  onClose: () => void;
  onSubmit: (input: PromotionInput) => Promise<void>;
  isSaving: boolean;
}) {
  const [form, setForm] = React.useState<FormState>(emptyForm());
  const [error, setError] = React.useState<string | null>(null);
  const [confirmZeroPrice, setConfirmZeroPrice] = React.useState(false);

  React.useEffect(() => {
    if (open) {
      setForm(editing ? promoToForm(editing) : emptyForm());
      setError(null);
      setConfirmZeroPrice(false);
    }
  }, [open, editing]);

  const set = <K extends keyof FormState>(k: K, v: FormState[K]) =>
    setForm((f) => ({ ...f, [k]: v }));

  // How many in-scope products this rule would sell for $0.00, recomputed as the
  // operator types. Null = the rule cannot zero anything (the common case).
  const productIdsKey = form.productIds.join(",");
  const zeroImpact = React.useMemo(
    () => zeroPriceImpact(draftRule(form), scopeProducts),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [scopeProducts, form.type, form.value, form.minQty, form.scope, form.category, productIdsKey],
  );

  // Any edit to the rule invalidates a prior confirmation — the count it was
  // given for no longer holds.
  React.useEffect(() => {
    setConfirmZeroPrice(false);
  }, [form.type, form.value, form.minQty, form.scope, form.category, productIdsKey]);

  const handleSubmit = async () => {
    setError(null);
    // Client-side guards mirroring the API's validateRule so the operator gets
    // an inline message instead of a 400 toast.
    if (!form.name.trim()) return setError("Name is required.");
    const value = parseFloat(form.value);
    if (Number.isNaN(value) || value < 0) return setError("Enter a valid value (≥ 0).");
    if (form.type === "PERCENT" || form.type === "QTY_BREAK") {
      if (value > 100) return setError("Percent value cannot exceed 100.");
    }
    if (form.type === "QTY_BREAK" && !(parseInt(form.minQty, 10) > 0)) {
      return setError("Quantity-break promotions need a minimum quantity ≥ 1.");
    }
    if (form.type === "BUY_N_GET_M") {
      const n = form.minQty.trim();
      const m = form.value.trim();
      if (!/^\d+$/.test(n) || parseInt(n, 10) < 1) {
        return setError("Buy quantity (N) must be a whole number ≥ 1.");
      }
      if (!/^\d+$/.test(m) || parseInt(m, 10) < 1) {
        return setError("Free quantity (M) must be a whole number ≥ 1.");
      }
    }
    if (form.scope === "CATEGORY" && !form.category.trim()) {
      return setError("Pick a category for a category-scoped promotion.");
    }
    if (form.scope === "PRODUCTS" && form.productIds.length === 0) {
      return setError("Select at least one product.");
    }
    if (!form.startsAt || !form.endsAt) return setError("Set a start and end date.");
    if (new Date(form.endsAt) <= new Date(form.startsAt)) {
      return setError("End must be after start.");
    }
    // Blocking $0.00 confirmation — the API refuses the same rule without the flag.
    if (zeroImpact && !confirmZeroPrice) {
      return setError(
        `${zeroPriceWarning(zeroImpact)} Lower the amount, narrow the scope, or tick the confirmation to run it anyway.`,
      );
    }

    const input: PromotionInput = {
      name: form.name.trim(),
      bannerText: form.bannerText.trim() || undefined,
      type: form.type,
      value,
      minQty:
        form.type === "QTY_BREAK" || form.type === "BUY_N_GET_M"
          ? parseInt(form.minQty, 10)
          : undefined,
      scope: form.scope,
      category: form.scope === "CATEGORY" ? form.category.trim() : undefined,
      // Always send the array so switching scope away from PRODUCTS clears the
      // stale join set (the API replaces the set whenever productIds is present).
      productIds: form.scope === "PRODUCTS" ? form.productIds : [],
      startsAt: fromLocalInput(form.startsAt),
      endsAt: fromLocalInput(form.endsAt),
      isActive: form.isActive,
      // Only ever sent alongside a count the operator was actually shown.
      allowZeroPrice: zeroImpact && confirmZeroPrice ? true : undefined,
    };
    try {
      await onSubmit(input);
    } catch (e: any) {
      setError(e?.response?.data?.message ?? e?.message ?? "Failed to save promotion.");
    }
  };

  const isPercentLike = form.type === "PERCENT" || form.type === "QTY_BREAK";
  const isBogo = form.type === "BUY_N_GET_M";
  const bogoN = parseInt(form.minQty, 10);
  const bogoM = parseInt(form.value, 10);
  const bogoPreview =
    Number.isInteger(bogoN) && bogoN >= 1 && Number.isInteger(bogoM) && bogoM >= 1
      ? `Buy ${bogoN}, get ${bogoM} free — every ${ordinalSuffix(bogoN + bogoM)} unit is free.`
      : "Enter a whole-number buy quantity and free quantity to preview the deal.";

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={editing ? "Edit promotion" : "New promotion"}
      description="Pricing applies at cart time. This defines the rule and its schedule."
      className="max-w-xl"
      footer={
        <>
          <Button variant="secondary" onClick={onClose} disabled={isSaving}>
            Cancel
          </Button>
          <Button onClick={handleSubmit} loading={isSaving}>
            {editing ? "Save changes" : "Create promotion"}
          </Button>
        </>
      }
    >
      <div className="max-h-[70vh] space-y-4 overflow-y-auto pr-1">
        {error && (
          <div className="rounded-lg border border-danger/30 bg-danger-bg px-3 py-2 text-sm text-danger">
            {error}
          </div>
        )}

        <div>
          <label className="mb-1 block text-sm font-medium text-navy">Name *</label>
          <input
            value={form.name}
            onChange={(e) => set("name", e.target.value)}
            placeholder='e.g. "Summer Restock Deal"'
            className="w-full rounded border border-surface-border px-3 py-2 text-sm text-navy focus:outline-none focus:ring-2 focus:ring-brand-500"
          />
        </div>

        <div>
          <label className="mb-1 block text-sm font-medium text-navy">
            Banner text <span className="font-normal text-navy/60">(shown to buyers)</span>
          </label>
          <input
            value={form.bannerText}
            onChange={(e) => set("bannerText", e.target.value)}
            maxLength={160}
            placeholder='e.g. "15% off all beverages this week"'
            className="w-full rounded border border-surface-border px-3 py-2 text-sm text-navy focus:outline-none focus:ring-2 focus:ring-brand-500"
          />
        </div>

        <div className={cn("grid gap-4", isBogo ? "grid-cols-1" : "grid-cols-2")}>
          <div>
            <label className="mb-1 block text-sm font-medium text-navy">Type *</label>
            <Select
              options={TYPE_OPTIONS}
              value={form.type}
              onChange={(e) => set("type", e.target.value as PromotionType)}
            />
          </div>
          {!isBogo && (
            <div>
              <label className="mb-1 block text-sm font-medium text-navy">
                {isPercentLike ? "Percent off *" : "Amount off / unit *"}
              </label>
              <div className="flex items-center">
                {!isPercentLike && (
                  <span className="flex h-[38px] items-center rounded-l border border-r-0 border-surface-border bg-surface-raised px-2.5 text-sm text-navy/70">
                    $
                  </span>
                )}
                <input
                  type="number"
                  min="0"
                  step={isPercentLike ? "1" : "0.01"}
                  max={isPercentLike ? "100" : undefined}
                  value={form.value}
                  onChange={(e) => set("value", e.target.value)}
                  className={cn(
                    "w-full border px-3 py-2 text-sm text-navy focus:outline-none focus:ring-2 focus:ring-brand-500 border-surface-border",
                    isPercentLike ? "rounded" : "rounded-r",
                  )}
                />
                {isPercentLike && <span className="ml-2 text-sm text-navy/60">%</span>}
              </div>
            </div>
          )}
        </div>

        {zeroImpact && (
          <div className="rounded-lg border border-warning/40 bg-warning-bg px-3 py-2.5">
            <p className="text-sm font-semibold text-navy">{zeroPriceWarning(zeroImpact)}</p>
            <p className="mt-1 text-xs text-navy/70">
              Buyers would see $0.00 with a “100% off” chip, and any order placed on those lines
              bills $0.00 on the invoice. {zeroImpact.count} of the {zeroImpact.inScope} product
              {zeroImpact.inScope === 1 ? "" : "s"} this promotion covers are priced at or below the
              discount — e.g. {zeroImpact.examples.join(", ")}
              {zeroImpact.count > zeroImpact.examples.length ? ", …" : ""}. Prices shown are
              catalogue list prices; a customer on a lower tier can be affected even when their
              product is not counted here.
            </p>
            <label className="mt-2 flex items-start gap-2 text-xs font-medium text-navy">
              <input
                type="checkbox"
                checked={confirmZeroPrice}
                onChange={(e) => setConfirmZeroPrice(e.target.checked)}
                className="mt-0.5 h-4 w-4 rounded border-navy/30 accent-warning"
              />
              I understand — sell {zeroImpact.count === 1 ? "this product" : "these products"} for
              $0.00.
            </label>
          </div>
        )}

        {form.type === "QTY_BREAK" && (
          <div>
            <label className="mb-1 block text-sm font-medium text-navy">Minimum quantity *</label>
            <input
              type="number"
              min="1"
              step="1"
              value={form.minQty}
              onChange={(e) => set("minQty", e.target.value)}
              placeholder="e.g. 10"
              className="w-40 rounded border border-surface-border px-3 py-2 text-sm text-navy focus:outline-none focus:ring-2 focus:ring-brand-500"
            />
            <p className="mt-0.5 text-xs text-navy/60">
              Discount applies only to lines at or above this piece count.
            </p>
          </div>
        )}

        {isBogo && (
          <div>
            <div className="grid grid-cols-2 gap-4">
              <div>
                <label className="mb-1 block text-sm font-medium text-navy">
                  Buy quantity (N) *
                </label>
                <input
                  type="number"
                  min="1"
                  step="1"
                  value={form.minQty}
                  onChange={(e) => set("minQty", e.target.value)}
                  placeholder="e.g. 5"
                  className="w-full rounded border border-surface-border px-3 py-2 text-sm text-navy focus:outline-none focus:ring-2 focus:ring-brand-500"
                />
              </div>
              <div>
                <label className="mb-1 block text-sm font-medium text-navy">
                  Free quantity (M) *
                </label>
                <input
                  type="number"
                  min="1"
                  step="1"
                  value={form.value}
                  onChange={(e) => set("value", e.target.value)}
                  placeholder="e.g. 1"
                  className="w-full rounded border border-surface-border px-3 py-2 text-sm text-navy focus:outline-none focus:ring-2 focus:ring-brand-500"
                />
              </div>
            </div>
            <p className="mt-2 rounded-lg border border-brand-100 bg-brand-50/60 px-3 py-2 text-xs text-navy/80">
              {bogoPreview}
            </p>
          </div>
        )}

        <div>
          <label className="mb-1 block text-sm font-medium text-navy">Applies to *</label>
          <Select
            options={SCOPE_OPTIONS}
            value={form.scope}
            onChange={(e) => set("scope", e.target.value as PromotionScope)}
          />
        </div>

        {form.scope === "CATEGORY" && (
          <div>
            <label className="mb-1 block text-sm font-medium text-navy">Category *</label>
            <input
              list="promo-category-options"
              value={form.category}
              onChange={(e) => set("category", e.target.value)}
              placeholder="Select or type a category"
              className="w-full rounded border border-surface-border px-3 py-2 text-sm text-navy focus:outline-none focus:ring-2 focus:ring-brand-500"
            />
            <datalist id="promo-category-options">
              {categories.map((c) => (
                <option key={c} value={c} />
              ))}
            </datalist>
          </div>
        )}

        {form.scope === "PRODUCTS" && (
          <div>
            <label className="mb-1 block text-sm font-medium text-navy">Products *</label>
            <ProductMultiSelect
              selected={form.productIds}
              onChange={(ids) => set("productIds", ids)}
            />
          </div>
        )}

        <div className="grid grid-cols-2 gap-4">
          <div>
            <label className="mb-1 block text-sm font-medium text-navy">Starts *</label>
            <input
              type="datetime-local"
              value={form.startsAt}
              onChange={(e) => set("startsAt", e.target.value)}
              className="w-full rounded border border-surface-border px-3 py-2 text-sm text-navy focus:outline-none focus:ring-2 focus:ring-brand-500"
            />
          </div>
          <div>
            <label className="mb-1 block text-sm font-medium text-navy">Ends *</label>
            <input
              type="datetime-local"
              value={form.endsAt}
              onChange={(e) => set("endsAt", e.target.value)}
              className="w-full rounded border border-surface-border px-3 py-2 text-sm text-navy focus:outline-none focus:ring-2 focus:ring-brand-500"
            />
          </div>
        </div>

        <label className="flex items-center gap-2 text-sm text-navy">
          <input
            type="checkbox"
            checked={form.isActive}
            onChange={(e) => set("isActive", e.target.checked)}
            className="h-4 w-4 rounded border-navy/30 accent-brand-500"
          />
          Active (buyers see it while in its date window)
        </label>
      </div>
    </Modal>
  );
}

// ─── Page ─────────────────────────────────────────────────────────────────────

const FILTERS: { value: "" | PromotionStatus; label: string }[] = [
  { value: "", label: "All" },
  { value: "ACTIVE", label: "Active" },
  { value: "SCHEDULED", label: "Scheduled" },
  { value: "PAUSED", label: "Paused" },
  { value: "EXPIRED", label: "Expired" },
];

export default function PromotionsPage() {
  const { setTitle } = usePageTitle();
  const { toast } = useToast();

  React.useEffect(() => {
    setTitle("Promotions");
  }, [setTitle]);

  const { data: promotions, isLoading, isError } = usePromotions();
  const { data: allProducts } = useProducts({ limit: 0 });

  const createPromo = useCreatePromotion();
  const updatePromo = useUpdatePromotion();
  const setActive = useSetPromotionActive();
  const deletePromo = useDeletePromotion();

  const [modalOpen, setModalOpen] = React.useState(false);
  const [editing, setEditing] = React.useState<Promotion | null>(null);
  const [statusFilter, setStatusFilter] = React.useState<"" | PromotionStatus>("");
  const [confirmDelete, setConfirmDelete] = React.useState<Promotion | null>(null);

  const catalog = React.useMemo(() => (allProducts?.data ?? []) as ApiProduct[], [allProducts]);

  const categories = React.useMemo(
    () => Array.from(new Set(catalog.map((p) => p.category).filter(Boolean))) as string[],
    [catalog],
  );

  /** The active catalog in the pricing scan's shape — the $0.00 guard's input. */
  const scopeProducts = React.useMemo(() => toScopeProducts(catalog), [catalog]);

  const list = React.useMemo(() => promotions ?? [], [promotions]);

  // Saved promotions that are ALREADY zeroing prices (rules created before this
  // guard existed, or confirmed deliberately) — surfaced on the row so a live
  // $0.00 promo cannot sit unnoticed the way the 2026-08-20 one did.
  const zeroByPromoId = React.useMemo(() => {
    const out = new Map<string, ZeroPriceImpact>();
    for (const p of list) {
      const impact = zeroPriceImpact(promoToRule(p), scopeProducts);
      if (impact) out.set(p.id, impact);
    }
    return out;
  }, [list, scopeProducts]);

  const filtered = statusFilter ? list.filter((p) => promotionStatus(p) === statusFilter) : list;

  const openCreate = () => {
    setEditing(null);
    setModalOpen(true);
  };
  const openEdit = (p: Promotion) => {
    setEditing(p);
    setModalOpen(true);
  };

  const handleSubmit = async (input: PromotionInput) => {
    if (editing) {
      await updatePromo.mutateAsync({ id: editing.id, ...input });
      toast({ title: "Promotion updated", variant: "success" });
    } else {
      await createPromo.mutateAsync(input);
      toast({ title: "Promotion created", variant: "success" });
    }
    setModalOpen(false);
    setEditing(null);
  };

  const handleToggleActive = async (p: Promotion) => {
    try {
      await setActive.mutateAsync({ id: p.id, isActive: !p.isActive });
      toast({ title: p.isActive ? "Promotion paused" : "Promotion resumed", variant: "success" });
    } catch {
      toast({ title: "Failed to update promotion", variant: "error" });
    }
  };

  const handleDelete = async () => {
    if (!confirmDelete) return;
    try {
      await deletePromo.mutateAsync(confirmDelete.id);
      toast({ title: "Promotion deleted", variant: "success" });
    } catch {
      toast({ title: "Failed to delete promotion", variant: "error" });
    } finally {
      setConfirmDelete(null);
    }
  };

  const scopeLabel = (p: Promotion) => {
    if (p.scope === "ALL") return "All products";
    if (p.scope === "CATEGORY") return p.category ?? "Category";
    return `${p.products?.length ?? 0} product${(p.products?.length ?? 0) !== 1 ? "s" : ""}`;
  };

  return (
    <div className="space-y-5 p-6">
      <PageHeader
        title="Promotions"
        subtitle={
          list.length > 0
            ? `${list.filter((p) => promotionStatus(p) === "ACTIVE").length} active · ${list.length} total`
            : "Run windowed merchandising deals across your catalogue"
        }
        action={
          <Button leftIcon={<Plus className="h-4 w-4" />} onClick={openCreate}>
            New promotion
          </Button>
        }
      />

      {/* Status filter chips */}
      <div className="flex flex-wrap items-center gap-2.5 rounded-lg border border-surface-border bg-white px-4 py-3 shadow-card">
        {FILTERS.map((f) => (
          <button
            key={f.value || "all"}
            onClick={() => setStatusFilter(f.value)}
            className={cn(
              "inline-flex h-7 items-center gap-1.5 rounded-full border px-3 text-xs font-medium whitespace-nowrap transition-colors",
              statusFilter === f.value
                ? "border-navy bg-navy text-white"
                : "border-surface-border bg-white text-navy hover:bg-surface-raised",
            )}
          >
            {f.label}
          </button>
        ))}
      </div>

      {/* Content */}
      {isLoading ? (
        <div className="space-y-2">
          {Array.from({ length: 4 }).map((_, i) => (
            <div
              key={i}
              className="h-16 animate-pulse rounded-lg border border-surface-border bg-surface-raised"
            />
          ))}
        </div>
      ) : isError ? (
        <div className="flex items-center gap-2 rounded-lg border border-danger/30 bg-danger-bg px-4 py-3">
          <span className="text-sm text-danger">Failed to load promotions. Please refresh.</span>
        </div>
      ) : filtered.length === 0 ? (
        <div className="rounded-lg border border-surface-border bg-white">
          <EmptyState
            variant="products"
            title={statusFilter ? "No promotions in this state" : "No promotions yet"}
            description={
              statusFilter
                ? "Try a different filter, or create a new promotion."
                : "Create a windowed deal — percent off, fixed amount, or a quantity break — scoped to your whole catalogue, a category, or specific products."
            }
            action={
              <Button size="sm" onClick={openCreate}>
                New promotion
              </Button>
            }
          />
        </div>
      ) : (
        <div className="overflow-hidden rounded-lg border border-surface-border bg-white shadow-card">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-surface-border bg-surface-raised/50 text-left text-xs font-medium uppercase tracking-wide text-navy/50">
                <th className="px-4 py-2.5">Promotion</th>
                <th className="px-4 py-2.5">Rule</th>
                <th className="px-4 py-2.5">Applies to</th>
                <th className="px-4 py-2.5">Window</th>
                <th className="px-4 py-2.5">Status</th>
                <th className="px-4 py-2.5 text-right">Actions</th>
              </tr>
            </thead>
            <tbody>
              {filtered.map((p) => {
                const status = promotionStatus(p);
                const badge = STATUS_BADGE[status];
                return (
                  <tr
                    key={p.id}
                    className="border-b border-surface-border last:border-0 hover:bg-surface-raised/40"
                  >
                    <td className="px-4 py-3">
                      <p className="font-semibold text-navy">{p.name}</p>
                      {p.bannerText && (
                        <p className="mt-0.5 max-w-xs truncate text-xs text-navy/60">
                          {p.bannerText}
                        </p>
                      )}
                    </td>
                    <td className="px-4 py-3 text-navy/80">
                      {promotionRuleLabel(p)}
                      {zeroByPromoId.has(p.id) && (
                        <span
                          className="mt-1 flex items-center gap-1 text-xs font-semibold text-danger"
                          title={zeroPriceWarning(zeroByPromoId.get(p.id)!)}
                        >
                          <AlertTriangle className="h-3.5 w-3.5 shrink-0" />
                          {zeroByPromoId.get(p.id)!.count} sell for $0.00
                        </span>
                      )}
                    </td>
                    <td className="px-4 py-3 text-navy/80">{scopeLabel(p)}</td>
                    <td className="px-4 py-3 text-xs text-navy/70">
                      {fmtWindow(p.startsAt, p.endsAt)}
                    </td>
                    <td className="px-4 py-3">
                      <Badge variant={badge.variant} label={badge.label} />
                    </td>
                    <td className="px-4 py-3">
                      <div className="flex items-center justify-end gap-1">
                        <Button
                          size="sm"
                          variant="secondary"
                          onClick={() => handleToggleActive(p)}
                          loading={setActive.isPending && setActive.variables?.id === p.id}
                        >
                          {p.isActive ? "Pause" : "Resume"}
                        </Button>
                        <button
                          onClick={() => openEdit(p)}
                          title="Edit"
                          className="rounded p-1.5 text-navy/70 hover:bg-surface-raised hover:text-navy transition-colors"
                        >
                          <Pencil className="h-4 w-4" />
                        </button>
                        <button
                          onClick={() => setConfirmDelete(p)}
                          title="Delete"
                          className="rounded p-1.5 text-navy/70 hover:bg-danger-bg hover:text-danger transition-colors"
                        >
                          <Trash2 className="h-4 w-4" />
                        </button>
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      <PromotionFormModal
        open={modalOpen}
        editing={editing}
        categories={categories}
        scopeProducts={scopeProducts}
        onClose={() => {
          setModalOpen(false);
          setEditing(null);
        }}
        onSubmit={handleSubmit}
        isSaving={createPromo.isPending || updatePromo.isPending}
      />

      {/* Delete confirmation */}
      <Modal
        open={!!confirmDelete}
        onClose={() => setConfirmDelete(null)}
        title="Delete promotion?"
        footer={
          <>
            <Button variant="secondary" onClick={() => setConfirmDelete(null)}>
              Cancel
            </Button>
            <Button variant="danger" onClick={handleDelete} loading={deletePromo.isPending}>
              Delete
            </Button>
          </>
        }
      >
        <p className="text-sm text-navy/80">
          <span className="font-medium text-navy">{confirmDelete?.name}</span> will be permanently
          removed. Buyers will no longer see it. This cannot be undone.
        </p>
      </Modal>
    </div>
  );
}
