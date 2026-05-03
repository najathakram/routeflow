"use client";

import * as React from "react";
import { Loader2, Save, X } from "lucide-react";
import { Button, useToast } from "@routeflow/ui/web";
import { useUpdateRouteRun } from "@/lib/api/routes";
import { useDrivers } from "@/lib/api/drivers";

export interface EditableRun {
  id: string;
  driverId?: string | null;
  scheduledDate: string;
  notes?: string | null;
}

export function EditRunModal({
  run,
  onClose,
}: {
  run: EditableRun;
  onClose: () => void;
}) {
  const { toast } = useToast();
  const { data: driversData } = useDrivers({ limit: 100 });
  const updateRun = useUpdateRouteRun();

  const [driverId, setDriverId] = React.useState(run.driverId ?? "");
  const [date, setDate] = React.useState(
    new Date(run.scheduledDate).toISOString().slice(0, 10),
  );
  const [notes, setNotes] = React.useState(run.notes ?? "");

  const drivers = driversData?.data ?? [];

  const handleSave = () => {
    updateRun.mutate(
      { id: run.id, driverId: driverId || null, scheduledDate: date, notes },
      {
        onSuccess: () => {
          toast({ title: "Run updated", variant: "success" });
          onClose();
        },
        onError: (err) =>
          toast({ title: "Update failed", description: err.message, variant: "error" }),
      },
    );
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40">
      <div className="w-full max-w-md rounded-xl bg-white p-6 shadow-xl">
        <div className="mb-5 flex items-center justify-between">
          <h2 className="text-base font-semibold text-navy">Edit Route Run</h2>
          <button onClick={onClose} className="text-navy/40 hover:text-navy">
            <X className="h-5 w-5" />
          </button>
        </div>

        <div className="space-y-4">
          <div>
            <label className="mb-1 block text-xs font-medium text-navy/60">Driver</label>
            <select
              value={driverId}
              onChange={(e) => setDriverId(e.target.value)}
              className="h-9 w-full rounded border border-surface-border bg-white px-3 text-sm text-navy focus:outline-none focus:ring-2 focus:ring-brand-500"
            >
              <option value="">No driver assigned</option>
              {drivers.map((d) => (
                <option key={d.id} value={d.id}>
                  {d.contactName}
                </option>
              ))}
            </select>
          </div>

          <div>
            <label className="mb-1 block text-xs font-medium text-navy/60">Scheduled Date</label>
            <input
              type="date"
              value={date}
              onChange={(e) => setDate(e.target.value)}
              className="h-9 w-full rounded border border-surface-border bg-white px-3 text-sm text-navy focus:outline-none focus:ring-2 focus:ring-brand-500"
            />
          </div>

          <div>
            <label className="mb-1 block text-xs font-medium text-navy/60">Notes</label>
            <textarea
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              rows={3}
              placeholder="Optional notes for driver..."
              className="w-full rounded border border-surface-border bg-white px-3 py-2 text-sm text-navy placeholder:text-navy/30 focus:outline-none focus:ring-2 focus:ring-brand-500 resize-none"
            />
          </div>
        </div>

        <div className="mt-6 flex justify-end gap-2">
          <Button variant="secondary" size="sm" onClick={onClose}>
            Cancel
          </Button>
          <Button size="sm" onClick={handleSave} disabled={updateRun.isPending}>
            {updateRun.isPending ? (
              <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />
            ) : (
              <Save className="mr-1.5 h-3.5 w-3.5" />
            )}
            Save changes
          </Button>
        </div>
      </div>
    </div>
  );
}
