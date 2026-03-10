"use client";

import * as React from "react";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { Plus, X, GripVertical } from "lucide-react";
import { Modal, Input, Select, Button, cn } from "@routeflow/ui/web";
import { customers } from "@/mocks/customers";
import { drivers } from "@/mocks/drivers";

// ─── Schema ───────────────────────────────────────────────────────────────────

const schema = z.object({
  name: z.string().min(1, "Route name is required"),
  defaultDriverId: z.string().min(1, "Select a driver"),
});

type FormValues = z.infer<typeof schema>;

// ─── Types ────────────────────────────────────────────────────────────────────

interface StopEntry {
  id: string;
  customerId: string;
  customerName: string;
  address: string;
}

// ─── Component ────────────────────────────────────────────────────────────────

export interface CreateRouteModalProps {
  isOpen: boolean;
  onClose: () => void;
}

export function CreateRouteModal({ isOpen, onClose }: CreateRouteModalProps) {
  const [stops, setStops] = React.useState<StopEntry[]>([]);
  const [customerSearch, setCustomerSearch] = React.useState("");

  const {
    register,
    handleSubmit,
    reset,
    formState: { errors, isSubmitting },
  } = useForm<FormValues>({
    resolver: zodResolver(schema),
  });

  React.useEffect(() => {
    if (isOpen) {
      reset();
      setStops([]);
      setCustomerSearch("");
    }
  }, [isOpen, reset]);

  const filteredCustomers = React.useMemo(() => {
    const q = customerSearch.toLowerCase();
    return !q
      ? []
      : customers
          .filter(
            (c) =>
              c.businessName.toLowerCase().includes(q) ||
              c.contactName.toLowerCase().includes(q),
          )
          .slice(0, 5);
  }, [customerSearch]);

  const addStop = (c: (typeof customers)[number]) => {
    if (stops.some((s) => s.customerId === c.id)) return;
    const addr = c.addresses.find((a) => a.isPrimary) ?? c.addresses[0];
    setStops((prev) => [
      ...prev,
      {
        id: `${c.id}-${Date.now()}`,
        customerId: c.id,
        customerName: c.businessName,
        address: addr ? `${addr.street}, ${addr.city}, ${addr.state}` : "—",
      },
    ]);
    setCustomerSearch("");
  };

  const removeStop = (id: string) => {
    setStops((prev) => prev.filter((s) => s.id !== id));
  };

  const onSubmit = async (_data: FormValues) => {
    await new Promise((r) => setTimeout(r, 700));
    onClose();
  };

  return (
    <Modal
      open={isOpen}
      onClose={onClose}
      title="Create Route"
      description="Define a new route template with an ordered list of stops."
      className="max-w-2xl"
      footer={
        <>
          <Button variant="secondary" type="button" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" form="create-route-form" loading={isSubmitting}>
            Create Route
          </Button>
        </>
      }
    >
      <form
        id="create-route-form"
        onSubmit={handleSubmit(onSubmit)}
        noValidate
        className="max-h-[65vh] overflow-y-auto pr-1"
      >
        <div className="space-y-5">
          {/* Name + driver */}
          <div className="grid grid-cols-2 gap-3">
            <Input
              label="Route Name"
              placeholder="North Austin Loop"
              register={register("name")}
              error={errors.name?.message}
            />
            <Select
              label="Default Driver"
              placeholder="Select driver"
              options={drivers.map((d) => ({ value: d.id, label: d.name }))}
              register={register("defaultDriverId")}
              error={errors.defaultDriverId?.message}
            />
          </div>

          {/* Stop builder */}
          <section className="space-y-2">
            <p className="text-xs font-semibold uppercase tracking-wider text-navy/40">
              Stops
            </p>

            {/* Customer search */}
            <div className="relative">
              <input
                type="search"
                placeholder="Search customers to add a stop…"
                value={customerSearch}
                onChange={(e) => setCustomerSearch(e.target.value)}
                className="h-10 w-full rounded border border-surface-border bg-white px-3 text-sm text-navy placeholder:text-navy/40 focus:border-transparent focus:outline-none focus:ring-2 focus:ring-brand-500"
              />
              {filteredCustomers.length > 0 && (
                <ul className="absolute left-0 right-0 top-full z-10 mt-1 overflow-hidden rounded-lg border border-surface-border bg-white shadow-dropdown">
                  {filteredCustomers.map((c) => (
                    <li key={c.id}>
                      <button
                        type="button"
                        onClick={() => addStop(c)}
                        disabled={stops.some((s) => s.customerId === c.id)}
                        className={cn(
                          "flex w-full items-center gap-2 px-3 py-2.5 text-left text-sm transition-colors",
                          stops.some((s) => s.customerId === c.id)
                            ? "cursor-not-allowed text-navy/30"
                            : "text-navy hover:bg-surface-raised",
                        )}
                      >
                        <Plus className="h-3.5 w-3.5 shrink-0" />
                        <span>
                          <span className="font-medium">{c.businessName}</span>
                          <span className="ml-1.5 text-xs text-navy/50">{c.contactName}</span>
                        </span>
                        {stops.some((s) => s.customerId === c.id) && (
                          <span className="ml-auto text-xs text-navy/30">Added</span>
                        )}
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </div>

            {/* Ordered stop list */}
            {stops.length > 0 ? (
              <ul className="divide-y divide-surface-border overflow-hidden rounded-lg border border-surface-border bg-white">
                {stops.map((stop, idx) => (
                  <li key={stop.id} className="flex items-center gap-3 px-3 py-2.5">
                    <GripVertical className="h-4 w-4 shrink-0 cursor-grab text-navy/20" title="Drag to reorder (Phase 7)" />
                    <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-brand-100 text-xs font-bold text-brand-700">
                      {idx + 1}
                    </span>
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-sm font-medium text-navy">
                        {stop.customerName}
                      </p>
                      <p className="truncate text-xs text-navy/50">{stop.address}</p>
                    </div>
                    <button
                      type="button"
                      onClick={() => removeStop(stop.id)}
                      className="shrink-0 rounded p-1 text-navy/30 hover:bg-surface-raised hover:text-danger transition-colors"
                      title="Remove stop"
                    >
                      <X className="h-3.5 w-3.5" />
                    </button>
                  </li>
                ))}
              </ul>
            ) : (
              <div className="rounded-lg border border-dashed border-surface-border bg-surface-raised py-8 text-center">
                <p className="text-sm text-navy/40">
                  Search for customers above to add stops.
                </p>
              </div>
            )}
          </section>
        </div>
      </form>
    </Modal>
  );
}
