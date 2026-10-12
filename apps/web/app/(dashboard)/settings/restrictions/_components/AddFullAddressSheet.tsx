"use client";

import * as React from "react";
import { US_STATES } from "@routeflow/types";
import { Button, Modal, useToast } from "@routeflow/ui/web";
import { useAddCustomerAddress } from "@/lib/api/customers";
import { SAVE_FAILED } from "@/lib/unknown-state";

const field =
  "mt-1 h-10 w-full rounded border border-surface-border bg-white px-3 text-sm font-normal text-navy focus:outline-none focus:ring-2 focus:ring-brand-500";

/**
 * "Add full address" (Addendum D): the customer's address form in a side sheet, so the admin never leaves the page.
 * It adds a billing address through the same endpoint the customer page uses; a failure keeps the form.
 */
export function AddFullAddressSheet({
  customer,
  onClose,
  onSaved,
}: {
  customer: { id: string; name: string } | null;
  onClose: () => void;
  onSaved: () => void;
}) {
  const { toast } = useToast();
  const add = useAddCustomerAddress({ localErrorToast: true });
  const [v, setV] = React.useState({ line1: "", line2: "", city: "", state: "", zip: "" });
  const [failed, setFailed] = React.useState(false);
  React.useEffect(() => {
    setV({ line1: "", line2: "", city: "", state: "", zip: "" });
    setFailed(false);
  }, [customer?.id]);
  const set = (k: keyof typeof v) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) =>
    setV((p) => ({ ...p, [k]: e.target.value }));
  const valid = v.line1.trim() && v.city.trim() && v.state && v.zip.trim();

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!customer || !valid || add.isPending) return;
    setFailed(false);
    add.mutate(
      { id: customer.id, label: "Billing", addressType: "BILLING", ...v },
      {
        onSuccess: () => {
          toast({ title: "Address added", variant: "success" });
          onSaved();
        },
        onError: () => setFailed(true),
      },
    );
  };

  return (
    <Modal
      open={customer !== null}
      onClose={onClose}
      title={customer ? `Add address for ${customer.name}` : "Add address"}
      scroll
      className="left-auto right-0 top-0 h-full max-h-full w-full max-w-md translate-x-0 translate-y-0 rounded-none data-[state=closed]:slide-out-to-right data-[state=open]:slide-in-from-right data-[state=closed]:zoom-out-100 data-[state=open]:zoom-in-100"
    >
      <form onSubmit={submit} noValidate className="space-y-3" data-testid="add-full-address-sheet">
        <label className="block text-sm font-medium text-navy">
          Address line 1
          <input className={field} value={v.line1} onChange={set("line1")} />
        </label>
        <label className="block text-sm font-medium text-navy">
          Address line 2 (optional)
          <input className={field} value={v.line2} onChange={set("line2")} />
        </label>
        <label className="block text-sm font-medium text-navy">
          City
          <input className={field} value={v.city} onChange={set("city")} />
        </label>
        <div className="grid grid-cols-2 gap-3">
          <label className="block text-sm font-medium text-navy">
            State
            <select className={field} value={v.state} onChange={set("state")}>
              <option value="">State…</option>
              {US_STATES.map((s) => (
                <option key={s.code} value={s.code}>
                  {s.code} — {s.name}
                </option>
              ))}
            </select>
          </label>
          <label className="block text-sm font-medium text-navy">
            ZIP
            <input className={field} value={v.zip} onChange={set("zip")} inputMode="numeric" />
          </label>
        </div>
        {failed && (
          <p role="alert" className="text-sm text-navy">
            {SAVE_FAILED}
          </p>
        )}
        <div className="flex justify-end gap-3 border-t border-surface-border pt-4">
          <Button type="button" variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" disabled={!valid} loading={add.isPending}>
            Save address
          </Button>
        </div>
      </form>
    </Modal>
  );
}
