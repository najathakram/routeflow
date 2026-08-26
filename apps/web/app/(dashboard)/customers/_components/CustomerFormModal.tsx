"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { useQueryClient } from "@tanstack/react-query";
import { Modal, Input, Textarea, Select, Button, useToast, cn } from "@routeflow/ui/web";
import { useCreateCustomer, useUpdateCustomer } from "@/lib/api/customers";
import { AddressAutocomplete } from "@/components/AddressAutocomplete";
import { isInternalEmail } from "@/lib/formatting";
import { useHasAddon } from "@/lib/api/tobacco";
import { SALES_AGENTS_ADDON } from "@/lib/api/addons";
import { useSalesAgents } from "@/lib/api/sales-agents";
import { AgentFormModal } from "../../sales-agents/_components/AgentFormModal";

// ─── Schema ───────────────────────────────────────────────────────────────────

const customerSchema = z
  .object({
    customerType: z.enum(["BUSINESS", "INDIVIDUAL"]),
    // Default fulfillment for orders created for this customer — ROUTE (delivery
    // route) vs SHIP (supplier/carrier-shipped, excluded from trip/route dispatch).
    // Orders still get their own per-order override in CreateOrderModal.
    fulfillPath: z.enum(["ROUTE", "SHIP"]).optional(),
    // Business-specific
    businessName: z.string().optional().or(z.literal("")),
    contactName: z.string().optional().or(z.literal("")),
    // Individual-specific
    salutation: z.string().optional(),
    firstName: z.string().optional().or(z.literal("")),
    lastName: z.string().optional().or(z.literal("")),
    // Shared contact
    phone: z.string().min(7, "Enter a valid phone number").optional().or(z.literal("")),
    mobile: z.string().optional().or(z.literal("")),
    email: z.string().email("Enter a valid email").optional().or(z.literal("")),
    // Account
    currency: z.string().optional(),
    creditLimit: z.string().optional().or(z.literal("")),
    taxId: z.string().optional().or(z.literal("")),
    isTaxExempt: z.boolean().optional(),
    notes: z.string().optional(),
    // Address
    street: z.string().optional(),
    city: z.string().optional(),
    state: z.string().optional(),
    zip: z.string().optional(),
    addressType: z.enum(["BILLING", "SHIPPING"]).optional(),
  })
  .superRefine((data, ctx) => {
    if (data.customerType === "BUSINESS") {
      if (!data.businessName?.trim()) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["businessName"],
          message: "Business name is required",
        });
      }
      if (!data.contactName?.trim()) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["contactName"],
          message: "Contact name is required",
        });
      }
    } else {
      if (!data.firstName?.trim()) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["firstName"],
          message: "First name is required",
        });
      }
      if (!data.lastName?.trim()) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["lastName"],
          message: "Last name is required",
        });
      }
    }
  });

type CustomerFormValues = z.infer<typeof customerSchema>;

// ─── Props ────────────────────────────────────────────────────────────────────

export interface CustomerFormModalProps {
  isOpen: boolean;
  onClose: () => void;
  mode: "add" | "edit";
  initialData?: {
    id?: string;
    businessName: string;
    contactName: string;
    phone?: string;
    mobile?: string;
    email?: string;
    customerType?: string;
    displayName?: string;
    salutation?: string;
    firstName?: string;
    lastName?: string;
    taxId?: string;
    isTaxExempt?: boolean;
    creditLimit?: number;
    currency?: string;
    /** ROUTE (default) or SHIP — this customer's own fulfillment default. */
    fulfillPath?: string;
    user?: { email?: string };
    notes?: string;
    addresses?: {
      line1?: string;
      street?: string;
      city?: string;
      zip?: string;
      addressType?: string;
    }[];
  };
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function buildDefaultValues(
  initialData?: CustomerFormModalProps["initialData"],
): CustomerFormValues {
  if (!initialData) {
    return {
      customerType: "BUSINESS",
      fulfillPath: "ROUTE",
      businessName: "",
      contactName: "",
      salutation: "",
      firstName: "",
      lastName: "",
      phone: "",
      mobile: "",
      email: "",
      currency: "USD",
      creditLimit: "",
      taxId: "",
      isTaxExempt: false,
      notes: "",
      street: "",
      city: "",
      state: "",
      zip: "",
      addressType: "BILLING",
    };
  }
  return {
    customerType: (initialData.customerType as "BUSINESS" | "INDIVIDUAL") ?? "BUSINESS",
    fulfillPath: initialData.fulfillPath === "SHIP" ? "SHIP" : "ROUTE",
    businessName: initialData.businessName ?? "",
    contactName: initialData.contactName ?? "",
    salutation: initialData.salutation ?? "",
    firstName: initialData.firstName ?? "",
    lastName: initialData.lastName ?? "",
    phone: initialData.phone ?? "",
    mobile: initialData.mobile ?? "",
    // Don't surface the internal sentinel minted for emailless/CSV-imported customers —
    // from EITHER source: CSV import writes `<name>@imported.local` onto Customer.email
    // itself, not just the linked User. (Saving with the field left blank then scrubs
    // the stored sentinel — the update payload sends "" which the API clears to null.)
    email: [initialData.email, initialData.user?.email].find((e) => e && !isInternalEmail(e)) ?? "",
    currency: initialData.currency ?? "USD",
    creditLimit: initialData.creditLimit ? String(initialData.creditLimit) : "",
    taxId: initialData.taxId ?? "",
    isTaxExempt: initialData.isTaxExempt ?? false,
    notes: initialData.notes ?? "",
    street: initialData.addresses?.[0]?.line1 ?? initialData.addresses?.[0]?.street ?? "",
    city: initialData.addresses?.[0]?.city ?? "",
    state: "",
    zip: initialData.addresses?.[0]?.zip ?? "",
    addressType: (initialData.addresses?.[0]?.addressType as "BILLING" | "SHIPPING") ?? "BILLING",
  };
}

// ─── Component ────────────────────────────────────────────────────────────────

export function CustomerFormModal({ isOpen, onClose, mode, initialData }: CustomerFormModalProps) {
  const { toast } = useToast();
  const router = useRouter();
  const qc = useQueryClient();
  const createCustomer = useCreateCustomer();
  const updateCustomer = useUpdateCustomer();

  const [streetError, setStreetError] = React.useState("");
  const [cityError, setCityError] = React.useState("");
  const [zipError, setZipError] = React.useState("");

  // Add-mode-only: optional sales agent assignment at creation. Edit mode has
  // no reassignment path here — that lives in the customer page's agent box
  // (the PATCH customer route has no agent field; assignment-open lives
  // inside the engine's create() only).
  const hasSalesAgents = useHasAddon(SALES_AGENTS_ADDON);
  const [salesAgentId, setSalesAgentId] = React.useState("");
  const [isAgentModalOpen, setIsAgentModalOpen] = React.useState(false);
  const { data: salesAgents } = useSalesAgents(
    { status: "ACTIVE" },
    { enabled: isOpen && hasSalesAgents && mode === "add" },
  );

  const {
    register,
    handleSubmit,
    reset,
    watch,
    setValue,
    formState: { errors },
  } = useForm<CustomerFormValues>({
    resolver: zodResolver(customerSchema),
    defaultValues: buildDefaultValues(initialData),
  });

  const customerType = watch("customerType");
  const isBusiness = customerType === "BUSINESS";

  // Reset form whenever the modal opens or the customer changes
  React.useEffect(() => {
    if (isOpen) {
      createCustomer.reset();
      updateCustomer.reset();
      reset(buildDefaultValues(initialData));
      setStreetError("");
      setCityError("");
      setZipError("");
      setSalesAgentId("");
      setIsAgentModalOpen(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isOpen, initialData]);

  const apiError = (createCustomer.error || updateCustomer.error) as Error | null;
  const isPending = createCustomer.isPending || updateCustomer.isPending;

  const onSubmit = (data: CustomerFormValues) => {
    // Derive business-model fields for individual customers
    const fullName = `${data.firstName ?? ""} ${data.lastName ?? ""}`.trim();
    const resolvedBusinessName = isBusiness ? (data.businessName ?? "") : fullName;
    const resolvedContactName = isBusiness ? (data.contactName ?? "") : fullName;
    const resolvedDisplayName = isBusiness ? (data.businessName ?? "") : fullName;

    if (mode === "add") {
      let hasAddressError = false;
      if (!data.street?.trim()) {
        setStreetError("Required");
        hasAddressError = true;
      } else setStreetError("");
      if (!data.city?.trim()) {
        setCityError("Required");
        hasAddressError = true;
      } else setCityError("");
      if (!data.zip?.trim()) {
        setZipError("Required");
        hasAddressError = true;
      } else setZipError("");
      if (hasAddressError) return;

      // Username no longer depends on email (which is now optional) — derive it
      // from the email local-part when present, else from the business/contact name.
      const usernameBase =
        (data.email ? data.email.split("@")[0] : resolvedBusinessName || resolvedContactName || "")
          .replace(/[^a-z0-9]/gi, "")
          .toLowerCase()
          .slice(0, 24) || "customer";
      const username = `${usernameBase}_${Date.now().toString(36)}`;

      createCustomer.mutate(
        {
          email: data.email || undefined,
          username,
          businessName: resolvedBusinessName,
          contactName: resolvedContactName,
          phone: data.phone || undefined,
          mobile: data.mobile || undefined,
          customerType: data.customerType,
          displayName: resolvedDisplayName,
          salutation: data.salutation || undefined,
          firstName: data.firstName || undefined,
          lastName: data.lastName || undefined,
          taxId: data.taxId || undefined,
          isTaxExempt: data.isTaxExempt || false,
          creditLimit: data.creditLimit ? parseFloat(data.creditLimit) : undefined,
          currency: data.currency || "USD",
          fulfillPath: data.fulfillPath || "ROUTE",
          notes: data.notes,
          addresses: [
            {
              line1: data.street!,
              city: data.city!,
              state: data.state?.trim() || "TX",
              zip: data.zip!,
              isDefault: true,
              label: "Main",
              addressType: data.addressType || "BILLING",
            },
          ],
          ...(salesAgentId ? { salesAgentId } : {}),
        },
        {
          onSuccess: () => {
            toast({ title: "Customer added", variant: "success" });
            onClose();
          },
        },
      );
    } else {
      if (!initialData?.id) return;

      updateCustomer.mutate(
        {
          id: initialData.id,
          // Always send email — "" clears the stored address server-side (emptyToNull).
          // `|| undefined` here made an emptied field a silent no-op, so a bad or
          // sentinel email could never be removed.
          email: data.email ?? "",
          businessName: resolvedBusinessName,
          contactName: resolvedContactName,
          phone: data.phone || undefined,
          mobile: data.mobile || undefined,
          customerType: data.customerType,
          displayName: resolvedDisplayName,
          salutation: data.salutation || undefined,
          firstName: data.firstName || undefined,
          lastName: data.lastName || undefined,
          taxId: data.taxId || undefined,
          isTaxExempt: data.isTaxExempt || false,
          creditLimit: data.creditLimit ? parseFloat(data.creditLimit) : undefined,
          currency: data.currency || "USD",
          fulfillPath: data.fulfillPath || "ROUTE",
          notes: data.notes,
        },
        {
          onSuccess: () => {
            toast({ title: "Customer updated", variant: "success" });
            onClose();
          },
        },
      );
    }
  };

  return (
    <Modal
      open={isOpen}
      onClose={onClose}
      title={mode === "add" ? "Add Customer" : "Edit Customer"}
      description={
        mode === "add"
          ? "Fill in the details to create a new customer account."
          : "Update the customer's information below."
      }
      className="max-w-2xl"
      footer={
        <>
          <Button variant="secondary" type="button" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" form="customer-form" loading={isPending}>
            {mode === "add" ? "Create Customer" : "Save Changes"}
          </Button>
        </>
      }
    >
      <form
        id="customer-form"
        onSubmit={handleSubmit(onSubmit)}
        noValidate
        className="max-h-[60vh] overflow-y-auto pr-1"
      >
        <div className="space-y-5">
          {/* API error banner */}
          {apiError && (
            <div className="rounded-md bg-red-50 px-3 py-2 text-sm text-red-700 ring-1 ring-red-200">
              {apiError.message ?? "Something went wrong. Please try again."}
            </div>
          )}

          {/* ── Customer Type Toggle ─────────────────────────────────────────── */}
          <section className="space-y-3">
            <p className="text-xs font-semibold uppercase tracking-wider text-navy/70">
              Customer Type
            </p>
            <div className="flex gap-2">
              {(["BUSINESS", "INDIVIDUAL"] as const).map((t) => (
                <button
                  key={t}
                  type="button"
                  onClick={() => setValue("customerType", t, { shouldValidate: false })}
                  className={cn(
                    "flex-1 rounded-lg border px-4 py-2.5 text-sm font-medium transition-colors",
                    customerType === t
                      ? "border-brand-500 bg-brand-50 text-brand-600"
                      : "border-surface-border bg-white text-navy/70 hover:border-brand-300",
                  )}
                >
                  {t === "BUSINESS" ? "🏢 Business" : "👤 Individual"}
                </button>
              ))}
            </div>
          </section>

          {/* ── Name Fields (type-specific) ──────────────────────────────────── */}
          <section className="space-y-3">
            <p className="text-xs font-semibold uppercase tracking-wider text-navy/70">
              {isBusiness ? "Business Info" : "Personal Info"}
            </p>

            {isBusiness ? (
              /* Business: company name + primary contact person */
              <div className="grid grid-cols-2 gap-3">
                <Input
                  label="Business Name"
                  placeholder="Acme Co."
                  register={register("businessName")}
                  error={errors.businessName?.message}
                />
                <Input
                  label="Contact Name"
                  placeholder="Jane Doe"
                  register={register("contactName")}
                  error={errors.contactName?.message}
                />
              </div>
            ) : (
              /* Individual: salutation + first + last */
              <div className="grid grid-cols-8 gap-3">
                <div className="col-span-2">
                  <Select
                    label="Salutation"
                    options={[
                      { value: "", label: "—" },
                      { value: "Mr.", label: "Mr." },
                      { value: "Mrs.", label: "Mrs." },
                      { value: "Ms.", label: "Ms." },
                      { value: "Dr.", label: "Dr." },
                    ]}
                    register={register("salutation")}
                  />
                </div>
                <div className="col-span-3">
                  <Input
                    label="First Name"
                    placeholder="Jane"
                    register={register("firstName")}
                    error={errors.firstName?.message}
                  />
                </div>
                <div className="col-span-3">
                  <Input
                    label="Last Name"
                    placeholder="Doe"
                    register={register("lastName")}
                    error={errors.lastName?.message}
                  />
                </div>
              </div>
            )}
          </section>

          {/* ── Sales agent (add mode only, flag-gated) ──────────────────────── */}
          {hasSalesAgents && mode === "add" && (
            <section className="space-y-3">
              <p className="text-xs font-semibold uppercase tracking-wider text-navy/70">
                Sales Agent
              </p>
              <div className="flex items-end gap-2">
                <div className="flex-1">
                  <Select
                    label="Sales agent (optional)"
                    value={salesAgentId}
                    onChange={(e) => setSalesAgentId(e.target.value)}
                    options={[
                      // A real selectable option, not `placeholder` — the shared Select
                      // renders a placeholder as a DISABLED option, which would make a
                      // picked agent impossible to un-pick.
                      { value: "", label: "No agent" },
                      ...(salesAgents ?? []).map((a) => ({ value: a.id, label: a.name })),
                    ]}
                  />
                </div>
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  onClick={() => setIsAgentModalOpen(true)}
                >
                  + New agent
                </Button>
              </div>
            </section>
          )}

          {/* ── Contact Details (shared) ─────────────────────────────────────── */}
          <section className="space-y-3">
            <p className="text-xs font-semibold uppercase tracking-wider text-navy/70">
              Contact Details
            </p>
            <div className="grid grid-cols-2 gap-3">
              <Input
                label="Phone (optional)"
                type="tel"
                placeholder="(512) 555-0100"
                register={register("phone")}
                error={errors.phone?.message}
              />
              <Input
                label="Mobile (optional)"
                type="tel"
                placeholder="(512) 555-0200"
                register={register("mobile")}
              />
            </div>
            <Input
              label="Email (optional)"
              type="email"
              placeholder={isBusiness ? "billing@acmeco.com" : "jane.doe@email.com"}
              register={register("email")}
              error={errors.email?.message}
            />
          </section>

          {/* ── Account ─────────────────────────────────────────────────────── */}
          <section className="space-y-3">
            <p className="text-xs font-semibold uppercase tracking-wider text-navy/70">Account</p>
            <div className="grid grid-cols-2 gap-3">
              <Select
                label="Currency"
                options={[
                  { value: "USD", label: "USD ($)" },
                  { value: "EUR", label: "EUR (€)" },
                  { value: "GBP", label: "GBP (£)" },
                  { value: "CAD", label: "CAD (C$)" },
                ]}
                register={register("currency")}
              />
              <Input
                label="Credit Limit (optional)"
                type="number"
                placeholder="0.00"
                register={register("creditLimit")}
              />
            </div>
            <div className="grid grid-cols-2 gap-3">
              <Input
                label="Tax ID (optional)"
                placeholder={isBusiness ? "XX-XXXXXXX" : "SSN / ITIN"}
                register={register("taxId")}
              />
              <div className="flex items-end pb-2">
                <label className="flex items-center gap-2 text-sm text-navy cursor-pointer">
                  <input
                    type="checkbox"
                    {...register("isTaxExempt")}
                    className="h-4 w-4 rounded border-navy/30 accent-brand-500"
                  />
                  Tax Exempt
                </label>
              </div>
            </div>
            <div className="space-y-1">
              <Select
                label="Default fulfillment"
                options={[
                  { value: "ROUTE", label: "Delivery route" },
                  { value: "SHIP", label: "Ship via carrier" },
                ]}
                register={register("fulfillPath")}
              />
              {watch("fulfillPath") === "SHIP" && (
                <p className="text-[11px] leading-snug text-navy/70">
                  Ships via carrier — won&apos;t appear on delivery routes.
                </p>
              )}
            </div>
          </section>

          {/* ── Primary Delivery Address (add mode only) ─────────────────────── */}
          {/* Edit mode used to prefill from addresses[0] only and the submit payload
              omitted address fields entirely — a silent discard of anything typed
              here. Addresses are now a full CRUD surface on the customer's own
              Addresses tab (mobile's CustomerForm already excludes them the same
              way in edit mode), so edit mode gets an honest link there instead. */}
          {mode === "add" ? (
            <section className="space-y-3">
              <p className="text-xs font-semibold uppercase tracking-wider text-navy/70">
                Primary Delivery Address
              </p>
              <div className="flex gap-2">
                {(["BILLING", "SHIPPING"] as const).map((t) => (
                  <button
                    key={t}
                    type="button"
                    onClick={() => setValue("addressType", t)}
                    className={cn(
                      "rounded-lg border px-3 py-1.5 text-xs font-medium transition-colors",
                      watch("addressType") === t
                        ? "border-brand-500 bg-brand-50 text-brand-600"
                        : "border-surface-border bg-white text-navy/70 hover:border-brand-300",
                    )}
                  >
                    {t === "BILLING" ? "Billing" : "Shipping"}
                  </button>
                ))}
              </div>
              <AddressAutocomplete
                label="Street"
                placeholder="123 Main St — start typing for suggestions"
                value={watch("street") ?? ""}
                onChange={(v) => setValue("street", v, { shouldDirty: true })}
                onAddressSelect={({ street, city, state, zip }) => {
                  setValue("street", street, { shouldDirty: true });
                  setValue("city", city, { shouldDirty: true });
                  setValue("state", state, { shouldDirty: true });
                  setValue("zip", zip, { shouldDirty: true });
                  setStreetError("");
                  setCityError("");
                  setZipError("");
                }}
                error={errors.street?.message || streetError}
              />
              <div className="grid grid-cols-3 gap-3">
                <div className="col-span-2">
                  <Input
                    label="City"
                    placeholder="Austin"
                    register={register("city")}
                    error={errors.city?.message || cityError}
                  />
                </div>
                <Input
                  label="State"
                  placeholder="TX"
                  register={register("state")}
                  error={errors.state?.message}
                />
              </div>
              <Input
                label="ZIP Code"
                placeholder="78701"
                register={register("zip")}
                error={errors.zip?.message || zipError}
              />
            </section>
          ) : (
            <div className="rounded-lg border border-dashed border-surface-border bg-surface-raised px-4 py-3">
              <p className="text-sm text-navy/70">
                Addresses are managed on the customer&apos;s{" "}
                <button
                  type="button"
                  onClick={() => {
                    onClose();
                    if (initialData?.id) {
                      router.push(`/customers/${initialData.id}?tab=addresses`);
                    }
                  }}
                  className="font-medium text-brand-500 hover:underline"
                >
                  Addresses tab
                </button>
                .
              </p>
            </div>
          )}

          {/* ── Notes ───────────────────────────────────────────────────────── */}
          <section className="space-y-2">
            <Textarea
              label="Notes (optional)"
              placeholder="Delivery instructions, special requirements…"
              register={register("notes")}
              error={errors.notes?.message}
            />
          </section>
        </div>
      </form>

      {/* Sales-agent quick-create — an agent not yet in the system shouldn't force
          leaving this form. Reuses the list page's create-only modal as-is. */}
      <AgentFormModal
        isOpen={isAgentModalOpen}
        onClose={() => setIsAgentModalOpen(false)}
        onCreated={(id) => {
          qc.invalidateQueries({ queryKey: ["sales-agents"] });
          setSalesAgentId(id);
        }}
      />
    </Modal>
  );
}
