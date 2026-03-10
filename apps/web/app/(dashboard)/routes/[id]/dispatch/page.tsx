"use client";

import * as React from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import {
  ArrowLeft,
  UserCheck,
  Plus,
  XCircle,
  Package,
  AlertTriangle,
} from "lucide-react";
import { Badge, Button, Card, Select, Modal, cn } from "@routeflow/ui/web";
import { usePageTitle } from "@/lib/page-title-context";
import { getRouteRun, getTemplate, type RouteRun } from "@/mocks/routes";
import { drivers } from "@/mocks/drivers";
import { customers } from "@/mocks/customers";

// ─── Reassign driver schema ────────────────────────────────────────────────────

const reassignSchema = z.object({
  driverId: z.string().min(1, "Select a driver"),
});
type ReassignFormValues = z.infer<typeof reassignSchema>;

// ─── Add Stop schema ──────────────────────────────────────────────────────────

const addStopSchema = z.object({
  customerId: z.string().min(1, "Select a customer"),
});
type AddStopFormValues = z.infer<typeof addStopSchema>;

// ─── Stop order card ──────────────────────────────────────────────────────────

function StopOrderCard({ run }: { run: RouteRun }) {
  return (
    <Card title="Pending Stops">
      {run.stops.filter((s) => s.status !== "COMPLETED").length === 0 ? (
        <p className="text-sm text-navy/40">All stops completed.</p>
      ) : (
        <ul className="-mx-6 -mb-6 divide-y divide-surface-border">
          {run.stops
            .filter((s) => s.status !== "COMPLETED")
            .map((stop) => (
              <li key={stop.id} className="flex items-start gap-3 px-6 py-4">
                <span
                  className={cn(
                    "flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-xs font-bold",
                    stop.status === "CURRENT"
                      ? "bg-brand-500 text-white"
                      : stop.status === "SKIPPED"
                      ? "bg-danger-bg text-danger"
                      : "bg-surface-raised text-navy/50",
                  )}
                >
                  {stop.order}
                </span>
                <div className="min-w-0 flex-1">
                  <p className="text-sm font-medium text-navy">{stop.customerName}</p>
                  <p className="mt-0.5 text-xs text-navy/50">{stop.address}</p>
                  <ul className="mt-1 space-y-0.5">
                    {stop.items.map((item, i) => (
                      <li key={i} className="flex items-center gap-1.5 text-xs text-navy/60">
                        <Package className="h-3 w-3 shrink-0 text-navy/30" />
                        {item.name} × {item.qty}
                      </li>
                    ))}
                  </ul>
                </div>
                {stop.status === "CURRENT" && (
                  <span className="shrink-0 rounded-full bg-brand-100 px-2 py-0.5 text-[10px] font-bold text-brand-700">
                    IN PROGRESS
                  </span>
                )}
                {stop.status === "SKIPPED" && (
                  <span className="shrink-0 rounded-full bg-danger-bg px-2 py-0.5 text-[10px] font-bold text-danger">
                    SKIPPED
                  </span>
                )}
              </li>
            ))}
        </ul>
      )}
    </Card>
  );
}

// ─── Page ─────────────────────────────────────────────────────────────────────

export default function DispatchPage({ params }: { params: { id: string } }) {
  const router = useRouter();
  const { setTitle } = usePageTitle();

  const run = getRouteRun(params.id);
  const template = !run ? getTemplate(params.id) : undefined;
  const routeName = run?.routeName ?? template?.name ?? "Dispatch";

  React.useEffect(() => { setTitle(`Dispatch — ${routeName}`); }, [setTitle, routeName]);

  const [currentDriver, setCurrentDriver] = React.useState(
    run?.driverName ?? template?.defaultDriverName ?? "—",
  );
  const [isCancelled, setIsCancelled] = React.useState(false);
  const [isReassignOpen, setIsReassignOpen] = React.useState(false);
  const [isAddStopOpen, setIsAddStopOpen] = React.useState(false);
  const [isCancelConfirmOpen, setIsCancelConfirmOpen] = React.useState(false);

  const reassignForm = useForm<ReassignFormValues>({
    resolver: zodResolver(reassignSchema),
    defaultValues: { driverId: run?.driverId ?? template?.defaultDriverId ?? "" },
  });

  const addStopForm = useForm<AddStopFormValues>({
    resolver: zodResolver(addStopSchema),
  });

  if (!run && !template) {
    return (
      <div className="flex flex-col items-center gap-4 p-12 text-center">
        <p className="text-base font-medium text-navy">Route not found.</p>
        <Button variant="secondary" href="/routes">Back to Routes</Button>
      </div>
    );
  }

  const handleReassign = async (data: ReassignFormValues) => {
    const driver = drivers.find((d) => d.id === data.driverId);
    if (driver) setCurrentDriver(driver.name);
    setIsReassignOpen(false);
  };

  const handleAddStop = async (_data: AddStopFormValues) => {
    setIsAddStopOpen(false);
    addStopForm.reset();
  };

  const handleCancelRun = () => {
    setIsCancelled(true);
    setIsCancelConfirmOpen(false);
  };

  const status = isCancelled
    ? "CANCELLED"
    : run?.status ?? "SCHEDULED";

  return (
    <div className="space-y-5 p-6">
      {/* Back */}
      <div className="flex items-center gap-3">
        <Link
          href={`/routes/${params.id}`}
          className="flex items-center gap-1.5 text-sm text-navy/60 hover:text-navy transition-colors"
        >
          <ArrowLeft className="h-4 w-4" />
          Route Detail
        </Link>
      </div>

      {/* Header */}
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold text-navy">{routeName}</h1>
          <p className="mt-1 text-sm text-navy/60">Driver: {currentDriver}</p>
        </div>
        <div className="flex items-center gap-2">
          <Badge
            status={
              status === "IN_PROGRESS"
                ? "IN_PROGRESS"
                : status === "COMPLETED"
                ? "COMPLETED"
                : status === "CANCELLED"
                ? "CANCELLED"
                : "SCHEDULED"
            }
          />
          {!isCancelled && (
            <Button
              variant="danger"
              size="sm"
              leftIcon={<XCircle className="h-4 w-4" />}
              onClick={() => setIsCancelConfirmOpen(true)}
            >
              Cancel Run
            </Button>
          )}
        </div>
      </div>

      {/* Cancelled banner */}
      {isCancelled && (
        <div className="flex items-center gap-3 rounded-lg border border-danger/30 bg-danger-bg px-4 py-3">
          <XCircle className="h-5 w-5 shrink-0 text-danger" />
          <p className="text-sm font-semibold text-danger">
            This route run has been cancelled.
          </p>
        </div>
      )}

      {/* Action cards */}
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {/* Reassign driver */}
        <Card title="Driver Assignment">
          <div className="flex flex-col gap-3">
            <div className="flex items-center gap-2 rounded-lg bg-surface-raised p-3">
              <UserCheck className="h-4 w-4 text-navy/40" />
              <div>
                <p className="text-xs text-navy/50">Assigned driver</p>
                <p className="text-sm font-semibold text-navy">{currentDriver}</p>
              </div>
            </div>
            <Button
              variant="secondary"
              size="sm"
              disabled={isCancelled}
              onClick={() => setIsReassignOpen(true)}
            >
              Change Driver
            </Button>
          </div>
        </Card>

        {/* Add stop */}
        <Card title="Add Stop">
          <div className="flex flex-col gap-3">
            <p className="text-sm text-navy/60">
              Add an unplanned stop to this run. It will be appended to the end of the route.
            </p>
            <Button
              variant="secondary"
              size="sm"
              leftIcon={<Plus className="h-4 w-4" />}
              disabled={isCancelled}
              onClick={() => setIsAddStopOpen(true)}
            >
              Add Stop
            </Button>
          </div>
        </Card>

        {/* Run summary */}
        {run && (
          <Card title="Run Summary">
            <dl className="space-y-2 text-sm">
              <div className="flex justify-between">
                <dt className="text-navy/60">Total stops</dt>
                <dd className="font-medium text-navy">{run.stops.length}</dd>
              </div>
              <div className="flex justify-between">
                <dt className="text-navy/60">Completed</dt>
                <dd className="font-medium text-success">
                  {run.stops.filter((s) => s.status === "COMPLETED").length}
                </dd>
              </div>
              <div className="flex justify-between">
                <dt className="text-navy/60">Pending</dt>
                <dd className="font-medium text-navy">
                  {run.stops.filter((s) => s.status === "UPCOMING" || s.status === "CURRENT").length}
                </dd>
              </div>
              <div className="flex justify-between">
                <dt className="text-navy/60">Skipped</dt>
                <dd className="font-medium text-danger">
                  {run.stops.filter((s) => s.status === "SKIPPED").length}
                </dd>
              </div>
              <div className="flex justify-between border-t border-surface-border pt-2">
                <dt className="text-navy/60">Start time</dt>
                <dd className="font-medium text-navy">{run.startTime}</dd>
              </div>
            </dl>
          </Card>
        )}
      </div>

      {/* Pending orders */}
      {run && <StopOrderCard run={run} />}

      {/* ── Reassign driver modal ── */}
      <Modal
        open={isReassignOpen}
        onClose={() => setIsReassignOpen(false)}
        title="Change Driver"
        description="Select a different driver for this route run."
        footer={
          <>
            <Button variant="secondary" onClick={() => setIsReassignOpen(false)}>
              Cancel
            </Button>
            <Button
              type="submit"
              form="reassign-form"
              loading={reassignForm.formState.isSubmitting}
            >
              Reassign
            </Button>
          </>
        }
      >
        <form
          id="reassign-form"
          onSubmit={reassignForm.handleSubmit(handleReassign)}
          className="space-y-3"
        >
          <Select
            label="Driver"
            options={drivers.map((d) => ({ value: d.id, label: d.name }))}
            register={reassignForm.register("driverId")}
            error={reassignForm.formState.errors.driverId?.message}
          />
        </form>
      </Modal>

      {/* ── Add stop modal ── */}
      <Modal
        open={isAddStopOpen}
        onClose={() => setIsAddStopOpen(false)}
        title="Add Stop"
        description="Choose a customer to add as a new stop at the end of this run."
        footer={
          <>
            <Button variant="secondary" onClick={() => setIsAddStopOpen(false)}>
              Cancel
            </Button>
            <Button
              type="submit"
              form="add-stop-form"
              loading={addStopForm.formState.isSubmitting}
            >
              Add Stop
            </Button>
          </>
        }
      >
        <form
          id="add-stop-form"
          onSubmit={addStopForm.handleSubmit(handleAddStop)}
          className="space-y-3"
        >
          <Select
            label="Customer"
            placeholder="Select customer"
            options={customers
              .filter((c) => c.status === "ACTIVE")
              .map((c) => ({ value: c.id, label: c.businessName }))}
            register={addStopForm.register("customerId")}
            error={addStopForm.formState.errors.customerId?.message}
          />
        </form>
      </Modal>

      {/* ── Cancel confirm modal ── */}
      <Modal
        open={isCancelConfirmOpen}
        onClose={() => setIsCancelConfirmOpen(false)}
        title="Cancel Route Run?"
        description="This will mark the entire run as cancelled. This action cannot be undone."
        footer={
          <>
            <Button variant="secondary" onClick={() => setIsCancelConfirmOpen(false)}>
              Keep Run
            </Button>
            <Button variant="danger" onClick={handleCancelRun}>
              Yes, Cancel Run
            </Button>
          </>
        }
      >
        <div className="flex items-center gap-3 rounded-lg border border-warning/30 bg-warning-bg p-3">
          <AlertTriangle className="h-5 w-5 shrink-0 text-warning" />
          <p className="text-sm text-navy/80">
            {run
              ? `${run.stops.filter((s) => s.status === "UPCOMING" || s.status === "CURRENT").length} pending stops will not be delivered.`
              : "The route run will be cancelled."}
          </p>
        </div>
      </Modal>
    </div>
  );
}
