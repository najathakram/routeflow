"use client";

import * as React from "react";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { Modal, Input, Textarea, Select, Button } from "@routeflow/ui/web";
import { availableRoutes, type Customer } from "@/mocks/customers";

// ─── Schema ───────────────────────────────────────────────────────────────────

const customerSchema = z.object({
  businessName: z.string().min(1, "Required"),
  contactName: z.string().min(1, "Required"),
  phone: z.string().min(7, "Enter a valid phone number"),
  email: z.string().email("Enter a valid email"),
  creditTerms: z.enum(["Net 15", "Net 30", "Net 60", "COD"]),
  routes: z.array(z.string()).optional(),
  street: z.string().min(1, "Required"),
  city: z.string().min(1, "Required"),
  zip: z.string().regex(/^\d{5}(-\d{4})?$/, "Enter a valid ZIP code"),
  notes: z.string().optional(),
});

type CustomerFormValues = z.infer<typeof customerSchema>;

// ─── Props ────────────────────────────────────────────────────────────────────

export interface CustomerFormModalProps {
  isOpen: boolean;
  onClose: () => void;
  mode: "add" | "edit";
  initialData?: Customer;
}

// ─── Component ────────────────────────────────────────────────────────────────

export function CustomerFormModal({
  isOpen,
  onClose,
  mode,
  initialData,
}: CustomerFormModalProps) {
  const {
    register,
    handleSubmit,
    reset,
    formState: { errors, isSubmitting },
  } = useForm<CustomerFormValues>({
    resolver: zodResolver(customerSchema),
    defaultValues: initialData
      ? {
          businessName: initialData.businessName,
          contactName: initialData.contactName,
          phone: initialData.phone,
          email: initialData.email,
          creditTerms: initialData.creditTerms,
          routes: initialData.assignedRoutes,
          street: initialData.addresses[0]?.street ?? "",
          city: initialData.addresses[0]?.city ?? "",
          zip: initialData.addresses[0]?.zip ?? "",
          notes: initialData.notes,
        }
      : { creditTerms: "Net 30" },
  });

  // Reset form when modal opens / customer changes
  React.useEffect(() => {
    if (isOpen) {
      reset(
        initialData
          ? {
              businessName: initialData.businessName,
              contactName: initialData.contactName,
              phone: initialData.phone,
              email: initialData.email,
              creditTerms: initialData.creditTerms,
              routes: initialData.assignedRoutes,
              street: initialData.addresses[0]?.street ?? "",
              city: initialData.addresses[0]?.city ?? "",
              zip: initialData.addresses[0]?.zip ?? "",
              notes: initialData.notes,
            }
          : { creditTerms: "Net 30", routes: [] },
      );
    }
  }, [isOpen, initialData, reset]);

  const onSubmit = async (_data: CustomerFormValues) => {
    // Mock save — simulate brief delay then close
    await new Promise((r) => setTimeout(r, 600));
    onClose();
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
          <Button
            type="submit"
            form="customer-form"
            loading={isSubmitting}
          >
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
                label="Phone"
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

          {/* Routes */}
          <section className="space-y-2">
            <p className="text-xs font-semibold uppercase tracking-wider text-navy/40">
              Assign Routes
            </p>
            <div className="rounded border border-surface-border bg-white p-3">
              <div className="grid grid-cols-2 gap-2">
                {availableRoutes.map((route) => (
                  <label
                    key={route.id}
                    className="flex cursor-pointer items-center gap-2 text-sm text-navy"
                  >
                    <input
                      type="checkbox"
                      value={route.id}
                      {...register("routes")}
                      className="h-4 w-4 accent-brand-500"
                    />
                    {route.name}
                  </label>
                ))}
              </div>
            </div>
          </section>

          {/* Primary delivery address */}
          <section className="space-y-3">
            <p className="text-xs font-semibold uppercase tracking-wider text-navy/40">
              Primary Delivery Address
            </p>
            <Input
              label="Street"
              placeholder="123 Main St"
              register={register("street")}
              error={errors.street?.message}
            />
            <div className="grid grid-cols-3 gap-3">
              <div className="col-span-2">
                <Input
                  label="City"
                  placeholder="Austin"
                  register={register("city")}
                  error={errors.city?.message}
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
              error={errors.zip?.message}
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
