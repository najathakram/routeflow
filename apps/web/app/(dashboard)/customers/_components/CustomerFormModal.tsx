"use client";

import * as React from "react";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { Modal, Input, Textarea, Select, Button, useToast } from "@routeflow/ui/web";
import { useCreateCustomer, useUpdateCustomer } from "@/lib/api/customers";

// ─── Schema ───────────────────────────────────────────────────────────────────

// Single unified schema — phone and address fields are optional in the Zod schema.
// Add-mode address requirements are enforced in onSubmit to avoid TypeScript
// resolver type conflicts that arise from using conditional schemas.
const customerSchema = z.object({
  businessName: z.string().min(1, "Required"),
  contactName: z.string().min(1, "Required"),
  phone: z
    .string()
    .min(7, "Enter a valid phone number")
    .optional()
    .or(z.literal("")),
  email: z.string().email("Enter a valid email"),
  creditTerms: z.enum(["Net 15", "Net 30", "Net 60", "COD"]),
  notes: z.string().optional(),
  street: z.string().optional(),
  city: z.string().optional(),
  zip: z.string().optional(),
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
    email?: string;
    user?: { email?: string };
    notes?: string;
    addresses?: { line1?: string; street?: string; city?: string; zip?: string }[];
  };
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function buildDefaultValues(initialData?: CustomerFormModalProps["initialData"]): CustomerFormValues {
  if (!initialData) {
    return {
      businessName: "",
      contactName: "",
      phone: "",
      email: "",
      creditTerms: "Net 30",
      notes: "",
      street: "",
      city: "",
      zip: "",
    };
  }
  return {
    businessName: initialData.businessName ?? "",
    contactName: initialData.contactName ?? "",
    phone: initialData.phone ?? "",
    email: initialData.email ?? initialData.user?.email ?? "",
    creditTerms: "Net 30",
    notes: initialData.notes ?? "",
    street: initialData.addresses?.[0]?.line1 ?? initialData.addresses?.[0]?.street ?? "",
    city: initialData.addresses?.[0]?.city ?? "",
    zip: initialData.addresses?.[0]?.zip ?? "",
  };
}

// ─── Component ────────────────────────────────────────────────────────────────

export function CustomerFormModal({
  isOpen,
  onClose,
  mode,
  initialData,
}: CustomerFormModalProps) {
  const { toast } = useToast();
  const createCustomer = useCreateCustomer();
  const updateCustomer = useUpdateCustomer();

  // Manual address-field errors for add mode
  const [streetError, setStreetError] = React.useState("");
  const [cityError, setCityError] = React.useState("");
  const [zipError, setZipError] = React.useState("");

  const {
    register,
    handleSubmit,
    reset,
    formState: { errors },
  } = useForm<CustomerFormValues>({
    resolver: zodResolver(customerSchema),
    defaultValues: buildDefaultValues(initialData),
  });

  // Reset form and clear mutation state whenever the modal opens or the customer changes
  React.useEffect(() => {
    if (isOpen) {
      createCustomer.reset();
      updateCustomer.reset();
      reset(buildDefaultValues(initialData));
      setStreetError("");
      setCityError("");
      setZipError("");
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isOpen, initialData]);

  const apiError = (createCustomer.error || updateCustomer.error) as Error | null;
  const isPending = createCustomer.isPending || updateCustomer.isPending;

  const onSubmit = (data: CustomerFormValues) => {
    if (mode === "add") {
      // Enforce address fields for new customers
      let hasAddressError = false;
      if (!data.street?.trim()) {
        setStreetError("Required");
        hasAddressError = true;
      } else setStreetError("");
      if (!data.city?.trim()) {
        setCityError("Required");
        hasAddressError = true;
      } else setCityError("");
      if (!data.zip?.trim() || !/^\d{5}(-\d{4})?$/.test(data.zip.trim())) {
        setZipError("Enter a valid ZIP code");
        hasAddressError = true;
      } else setZipError("");
      if (hasAddressError) return;

      const username =
        data.email.split("@")[0].replace(/[^a-z0-9]/gi, "") +
        "_" +
        Date.now().toString(36);

      createCustomer.mutate(
        {
          email: data.email,
          username,
          businessName: data.businessName,
          contactName: data.contactName,
          phone: data.phone || undefined,
          notes: data.notes,
          addresses: [
            {
              line1: data.street!,
              city: data.city!,
              state: "TX",
              zip: data.zip!,
              isDefault: true,
              label: "Main",
            },
          ],
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
          businessName: data.businessName,
          contactName: data.contactName,
          phone: data.phone || undefined,
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

          {/* Customer info */}
          <section className="space-y-3">
            <p className="text-xs font-semibold uppercase tracking-wider text-navy/40">
              Customer Info
            </p>
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
            <div className="grid grid-cols-2 gap-3">
              <Input
                label="Phone (optional)"
                type="tel"
                placeholder="(512) 555-0100"
                register={register("phone")}
                error={errors.phone?.message}
              />
              <Input
                label="Email"
                type="email"
                placeholder="contact@business.com"
                register={register("email")}
                error={errors.email?.message}
                disabled={mode === "edit"}
              />
            </div>
          </section>

          {/* Account */}
          <section className="space-y-3">
            <p className="text-xs font-semibold uppercase tracking-wider text-navy/40">
              Account
            </p>
            <Select
              label="Credit Terms"
              options={[
                { value: "Net 15", label: "Net 15" },
                { value: "Net 30", label: "Net 30" },
                { value: "Net 60", label: "Net 60" },
                { value: "COD", label: "Cash on Delivery (COD)" },
              ]}
              register={register("creditTerms")}
              error={errors.creditTerms?.message}
            />
          </section>

          {/* Primary delivery address */}
          <section className="space-y-3">
            <p className="text-xs font-semibold uppercase tracking-wider text-navy/40">
              Primary Delivery Address
              {mode === "edit" && (
                <span className="ml-1 font-normal normal-case text-navy/30">(optional)</span>
              )}
            </p>
            <Input
              label="Street"
              placeholder="123 Main St"
              register={register("street")}
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
              <div>
                <label className="mb-1 block text-sm font-medium text-navy">State</label>
                <div className="flex h-10 items-center rounded border border-surface-border bg-surface-raised px-3 text-sm text-navy/60">
                  TX
                </div>
              </div>
            </div>
            <Input
              label="ZIP Code"
              placeholder="78701"
              register={register("zip")}
              error={errors.zip?.message || zipError}
            />
          </section>

          {/* Notes */}
          <section className="space-y-2">
            <Textarea
              label="Notes"
              placeholder="Delivery instructions, special requirements…"
              register={register("notes")}
              error={errors.notes?.message}
            />
          </section>
        </div>
      </form>
    </Modal>
  );
}
