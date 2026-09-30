"use client";

import * as React from "react";
import { X } from "lucide-react";
import { Modal, Button, cn, useToast } from "@routeflow/ui/web";
import { useProducts } from "@/lib/api/products";
import {
  useCreateOrderTemplate,
  useUpdateOrderTemplate,
  type OrderTemplate,
} from "@/lib/api/order-templates";

// ─── Day of week config ───────────────────────────────────────────────────────

const DAYS = [
  { iso: 1, label: "Mon" },
  { iso: 2, label: "Tue" },
  { iso: 3, label: "Wed" },
  { iso: 4, label: "Thu" },
  { iso: 5, label: "Fri" },
  { iso: 6, label: "Sat" },
  { iso: 7, label: "Sun" },
];

// ─── Types ────────────────────────────────────────────────────────────────────

interface LineItem {
  tempId: string;
  productId: string;
  productName: string;
  unit: string;
  qty: number;
  notes?: string;
}

/**
 * Order-free canonical form of an item list: the modal's own rows and the loaded
 * template's items compare equal when they carry the same products, quantities and
 * notes, whatever order they are in (a remove + re-add of the same product is not a
 * change). Used to decide whether the edit PATCH needs to carry `items` at all.
 */
const itemSignature = (items: { productId: string; qty: number; notes?: string }[]) =>
  items
    .map((i) => `${i.productId}:${i.qty}:${i.notes ?? ""}`)
    .sort()
    .join("|");

// ─── Component ────────────────────────────────────────────────────────────────

export interface StandingOrderModalProps {
  isOpen: boolean;
  onClose: () => void;
  customerId: string;
  /** Pre-fill for edit mode */
  template?: OrderTemplate | null;
}

export function StandingOrderModal({
  isOpen,
  onClose,
  customerId,
  template,
}: StandingOrderModalProps) {
  const { toast } = useToast();
  const createTemplate = useCreateOrderTemplate();
  const updateTemplate = useUpdateOrderTemplate();

  const isEditing = !!template;

  // Form state
  const [name, setName] = React.useState("");
  const [selectedDays, setSelectedDays] = React.useState<number[]>([]);
  const [notes, setNotes] = React.useState("");

  // Product search state
  const [productSearch, setProductSearch] = React.useState("");
  const [debouncedProductSearch, setDebouncedProductSearch] = React.useState("");
  const [lineItems, setLineItems] = React.useState<LineItem[]>([]);
  const [nameError, setNameError] = React.useState("");
  const [daysError, setDaysError] = React.useState("");
  const [itemsError, setItemsError] = React.useState("");

  // Debounce product search
  React.useEffect(() => {
    const t = setTimeout(() => setDebouncedProductSearch(productSearch), 300);
    return () => clearTimeout(t);
  }, [productSearch]);

  const { data: productsData } = useProducts({
    search: debouncedProductSearch || undefined,
    isActive: true,
  });

  const filteredProducts = React.useMemo(() => {
    if (!debouncedProductSearch) return [];
    return (productsData?.data ?? [])
      .filter((p: { id: string }) => !lineItems.some((li) => li.productId === p.id))
      .slice(0, 8);
  }, [productsData, debouncedProductSearch, lineItems]);

  // Reset / pre-fill when modal opens
  React.useEffect(() => {
    if (isOpen) {
      if (template) {
        setName(template.name);
        setSelectedDays(template.daysOfWeek);
        setNotes(template.notes ?? "");
        setLineItems(
          template.items.map((item) => ({
            tempId: item.id,
            productId: item.productId,
            productName: item.product?.name ?? item.productId,
            unit: item.product?.unit ?? "each",
            qty: item.qty,
            notes: item.notes,
          })),
        );
      } else {
        setName("");
        setSelectedDays([]);
        setNotes("");
        setLineItems([]);
      }
      setProductSearch("");
      setDebouncedProductSearch("");
      setNameError("");
      setDaysError("");
      setItemsError("");
      createTemplate.reset();
      updateTemplate.reset();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isOpen]);

  // ── Item management ────────────────────────────────────────────────────────

  const addLineItem = (product: any) => {
    if (lineItems.some((li) => li.productId === product.id)) return;
    setLineItems((prev) => [
      ...prev,
      {
        tempId: product.id + "-" + Date.now(),
        productId: product.id,
        productName: product.name,
        unit: product.unit ?? "each",
        qty: 1,
      },
    ]);
    setProductSearch("");
    setDebouncedProductSearch("");
    setItemsError("");
  };

  const removeLineItem = (tempId: string) => {
    setLineItems((prev) => prev.filter((li) => li.tempId !== tempId));
  };

  const updateQty = (tempId: string, delta: number) => {
    setLineItems((prev) =>
      prev.map((li) => {
        if (li.tempId !== tempId) return li;
        return { ...li, qty: Math.max(1, li.qty + delta) };
      }),
    );
  };

  const toggleDay = (iso: number) => {
    setSelectedDays((prev) =>
      prev.includes(iso) ? prev.filter((d) => d !== iso) : [...prev, iso],
    );
    setDaysError("");
  };

  // ── Submit ────────────────────────────────────────────────────────────────

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    let hasErrors = false;
    if (!name.trim()) {
      setNameError("Name is required");
      hasErrors = true;
    }
    if (selectedDays.length === 0) {
      setDaysError("Select at least one day");
      hasErrors = true;
    }
    if (lineItems.length === 0) {
      setItemsError("Add at least one product");
      hasErrors = true;
    }
    if (hasErrors) return;

    if (isEditing && template) {
      // REG-B09: the modal shows the full item list in edit mode, so it saves the full
      // list — adds, removes and qty changes included (PATCH replaces items). Item notes
      // are not editable here and are carried through unchanged.
      // `items` is sent ONLY when the list actually differs from the loaded template, for
      // two reasons: (1) an edit that did not touch the items must not churn their rows
      // (the API replaces items by delete + re-create, minting new item ids); (2) a
      // name/day/notes-only edit then stays a scalar-only PATCH, which is exactly the
      // shape the pre-F13 API accepts — the global ValidationPipe runs
      // `forbidNonWhitelisted`, so an unknown `items` key is a 400, not an ignored field,
      // and api/web deploy as independent Railway services. An item change still needs
      // the new API (irreducible — that is the feature), but every other edit keeps
      // working through the deploy window and behind a rollback.
      const itemsChanged = itemSignature(lineItems) !== itemSignature(template.items);
      updateTemplate.mutate(
        {
          id: template.id,
          name: name.trim(),
          daysOfWeek: selectedDays,
          notes: notes.trim() || undefined,
          ...(itemsChanged
            ? {
                items: lineItems.map((li) => ({
                  productId: li.productId,
                  qty: li.qty,
                  notes: li.notes,
                })),
              }
            : {}),
        },
        {
          onSuccess: () => {
            toast({ title: "Standing order updated", variant: "success" });
            onClose();
          },
        },
      );
    } else {
      createTemplate.mutate(
        {
          customerId,
          name: name.trim(),
          daysOfWeek: selectedDays,
          notes: notes.trim() || undefined,
          items: lineItems.map((li) => ({ productId: li.productId, qty: li.qty })),
        },
        {
          onSuccess: () => {
            toast({ title: "Standing order created", variant: "success" });
            onClose();
          },
        },
      );
    }
  };

  const isPending = createTemplate.isPending || updateTemplate.isPending;
  const apiError = (() => {
    const err = (createTemplate.error ?? updateTemplate.error) as {
      response?: { data?: { message?: string } };
      message?: string;
    } | null;
    if (!err) return null;
    return err.response?.data?.message || err.message || "Something went wrong.";
  })();

  return (
    <Modal
      open={isOpen}
      onClose={onClose}
      title={isEditing ? "Edit Standing Order" : "Add Standing Order"}
      description="Create a recurring order template that auto-generates orders on selected days."
      className="max-w-2xl"
      footer={
        <>
          <Button variant="secondary" type="button" onClick={onClose} disabled={isPending}>
            Cancel
          </Button>
          <Button type="submit" form="standing-order-form" loading={isPending}>
            {isEditing ? "Save Changes" : "Create Standing Order"}
          </Button>
        </>
      }
    >
      <form
        id="standing-order-form"
        onSubmit={handleSubmit}
        noValidate
        className="max-h-[65vh] overflow-y-auto pr-1"
      >
        <div className="space-y-5">
          {apiError && (
            <div className="rounded-md bg-red-50 px-3 py-2 text-sm text-red-700 ring-1 ring-red-200">
              {apiError}
            </div>
          )}

          {/* ── Name ── */}
          <div className="space-y-1">
            <label className="block text-xs font-medium text-navy/70">
              Template Name <span className="text-danger">*</span>
            </label>
            <input
              type="text"
              value={name}
              onChange={(e) => {
                setName(e.target.value);
                setNameError("");
              }}
              placeholder="e.g. Weekly Produce Order"
              className={cn(
                "h-10 w-full rounded border bg-white px-3 text-sm text-navy placeholder:text-navy/70 focus:outline-none focus:ring-2 focus:ring-brand-500",
                nameError ? "border-danger" : "border-surface-border",
              )}
            />
            {nameError && <p className="text-xs text-danger">{nameError}</p>}
          </div>

          {/* ── Days of week ── */}
          <div className="space-y-2">
            <p className="text-xs font-semibold uppercase tracking-wider text-navy/70">
              Repeat on <span className="text-danger">*</span>
            </p>
            <div className="flex gap-2 flex-wrap">
              {DAYS.map(({ iso, label }) => (
                <button
                  key={iso}
                  type="button"
                  onClick={() => toggleDay(iso)}
                  className={cn(
                    "rounded-full border px-3 py-1 text-xs font-medium transition-colors",
                    selectedDays.includes(iso)
                      ? "border-brand-500 bg-brand-500 text-white"
                      : "border-surface-border bg-white text-navy/70 hover:border-navy/40 hover:text-navy",
                  )}
                >
                  {label}
                </button>
              ))}
            </div>
            {daysError && <p className="text-xs text-danger">{daysError}</p>}
          </div>

          {/* ── Products / Line Items ── */}
          <section className="space-y-2">
            <p className="text-xs font-semibold uppercase tracking-wider text-navy/70">
              Products <span className="text-danger">*</span>
            </p>

            <div className="relative">
              <input
                type="search"
                placeholder="Search products to add…"
                value={productSearch}
                onChange={(e) => {
                  setProductSearch(e.target.value);
                  setItemsError("");
                }}
                className={cn(
                  "h-10 w-full rounded border bg-white px-3 text-sm text-navy placeholder:text-navy/70 focus:outline-none focus:ring-2 focus:ring-brand-500",
                  itemsError && lineItems.length === 0 ? "border-danger" : "border-surface-border",
                )}
              />
              {filteredProducts.length > 0 && productSearch && (
                <ul className="absolute left-0 right-0 top-full z-10 mt-1 overflow-hidden rounded-lg border border-surface-border bg-white shadow-dropdown">
                  {filteredProducts.map((p: any) => (
                    <li key={p.id}>
                      <button
                        type="button"
                        onClick={() => addLineItem(p)}
                        className="flex w-full items-center justify-between px-3 py-2.5 text-left text-sm text-navy hover:bg-surface-raised"
                      >
                        <div>
                          <span className="font-medium">{p.name}</span>
                          <span className="ml-2 text-xs text-navy/70">{p.unit}</span>
                        </div>
                        <span className="text-xs font-medium text-navy/70">
                          ${Number(p.pricePerUnit ?? 0).toFixed(2)}
                        </span>
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </div>

            {itemsError && lineItems.length === 0 && (
              <p className="text-xs text-danger">{itemsError}</p>
            )}

            {lineItems.length > 0 ? (
              <ul className="divide-y divide-surface-border overflow-hidden rounded-lg border border-surface-border">
                {lineItems.map((li) => (
                  <li key={li.tempId} className="flex items-center gap-3 px-3 py-2.5">
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-sm font-medium text-navy">{li.productName}</p>
                      <p className="text-xs text-navy/70">{li.unit}</p>
                    </div>
                    <div className="flex items-center gap-1">
                      <button
                        type="button"
                        onClick={() => updateQty(li.tempId, -1)}
                        disabled={li.qty <= 1}
                        className="flex h-6 w-6 items-center justify-center rounded border border-surface-border text-sm text-navy/70 hover:bg-surface-raised disabled:cursor-not-allowed disabled:opacity-30 transition-colors"
                      >
                        −
                      </button>
                      <span className="w-8 text-center text-sm font-semibold text-navy">
                        {li.qty}
                      </span>
                      <button
                        type="button"
                        onClick={() => updateQty(li.tempId, 1)}
                        className="flex h-6 w-6 items-center justify-center rounded border border-surface-border text-sm text-navy/70 hover:bg-surface-raised transition-colors"
                      >
                        +
                      </button>
                    </div>
                    <button
                      type="button"
                      onClick={() => removeLineItem(li.tempId)}
                      className="shrink-0 rounded p-1 text-navy/30 hover:bg-surface-raised hover:text-danger transition-colors"
                      title="Remove"
                    >
                      <X className="h-3.5 w-3.5" />
                    </button>
                  </li>
                ))}
              </ul>
            ) : (
              <div className="rounded-lg border border-dashed border-surface-border bg-surface-raised py-6 text-center">
                <p className="text-sm text-navy/70">Search for products above to add line items.</p>
              </div>
            )}
          </section>

          {/* ── Notes ── */}
          <div className="space-y-1">
            <label className="block text-xs font-medium text-navy/70">
              Notes <span className="text-navy/30 font-normal">(optional)</span>
            </label>
            <textarea
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              placeholder="Any recurring instructions..."
              rows={2}
              className="w-full resize-none rounded border border-surface-border bg-white px-3 py-2 text-sm text-navy placeholder:text-navy/70 focus:outline-none focus:ring-2 focus:ring-brand-500"
            />
          </div>
        </div>
      </form>
    </Modal>
  );
}
