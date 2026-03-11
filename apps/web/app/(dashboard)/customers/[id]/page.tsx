"use client";

import * as React from "react";
import Link from "next/link";
import * as Tabs from "@radix-ui/react-tabs";
import type { ColumnDef } from "@tanstack/react-table";
import {
  ArrowLeft,
  Star,
  MapPin,
  Plus,
  Mail,
  Phone,
  FileText,
  Route,
} from "lucide-react";
import {
  Badge,
  Button,
  Card,
  Table,
  Select,
  Modal,
  Input,
  cn,
  type BadgeStatus,
} from "@routeflow/ui/web";
import { usePageTitle } from "@/lib/page-title-context";
import { CustomerFormModal } from "../_components/CustomerFormModal";
import {
  useCustomer,
  useCustomerOrders,
  useCustomerRoutes,
  useUpdateCustomerStatus,
  useAddCustomerAddress,
} from "@/lib/api/customers";
import { useRoutes, useAddStopToRoute } from "@/lib/api/routes";
import { ConfirmDialog } from "@/components/ConfirmDialog";

// ─── Types ────────────────────────────────────────────────────────────────────

interface ApiOrder {
  id: string;
  orderNumber?: string;
  status: string;
  createdAt: string;
  [key: string]: unknown;
}

// ─── Order table columns (stable outside component) ──────────────────────────

const orderColumns: ColumnDef<ApiOrder, unknown>[] = [
  {
    accessorKey: "orderNumber",
    header: "Order #",
    cell: ({ row }) => (
      <span className="font-mono text-xs font-semibold text-navy">
        {row.original.orderNumber ?? row.original.id}
      </span>
    ),
  },
  {
    accessorKey: "status",
    header: "Status",
    enableSorting: false,
    cell: ({ row }) => <Badge status={row.original.status as BadgeStatus} />,
  },
  {
    accessorKey: "createdAt",
    header: "Date",
    enableSorting: false,
    cell: ({ row }) => (
      <span className="text-navy/60">
        {new Date(row.original.createdAt).toLocaleDateString()}
      </span>
    ),
  },
];

// ─── Tab trigger ──────────────────────────────────────────────────────────────

function TabTrigger({ value, children }: { value: string; children: React.ReactNode }) {
  return (
    <Tabs.Trigger
      value={value}
      className={cn(
        "-mb-px border-b-2 px-4 py-3 text-sm font-medium transition-colors",
        "border-transparent text-navy/60 hover:text-navy",
        "data-[state=active]:border-brand-500 data-[state=active]:text-navy",
      )}
    >
      {children}
    </Tabs.Trigger>
  );
}

// ─── Info row ─────────────────────────────────────────────────────────────────

function InfoRow({
  icon: Icon,
  label,
  value,
}: {
  icon: React.ElementType;
  label: string;
  value: string;
}) {
  return (
    <div className="flex items-start gap-3">
      <Icon className="mt-0.5 h-4 w-4 shrink-0 text-navy/40" />
      <div>
        <p className="text-xs text-navy/50">{label}</p>
        <p className="mt-0.5 text-sm font-medium text-navy">{value}</p>
      </div>
    </div>
  );
}

// ─── Add Address Modal ────────────────────────────────────────────────────────

interface AddAddressFormValues {
  label: string;
  line1: string;
  line2?: string;
  city: string;
  state: string;
  zip: string;
  isDefault?: boolean;
}

function AddAddressModal({
  isOpen,
  onClose,
  onSave,
  isSaving,
}: {
  isOpen: boolean;
  onClose: () => void;
  onSave: (values: AddAddressFormValues) => void;
  isSaving: boolean;
}) {
  const [form, setForm] = React.useState<AddAddressFormValues>({
    label: "",
    line1: "",
    city: "",
    state: "",
    zip: "",
  });

  const handleChange = (field: keyof AddAddressFormValues) => (
    e: React.ChangeEvent<HTMLInputElement>,
  ) => setForm((prev) => ({ ...prev, [field]: e.target.value }));

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    onSave(form);
  };

  return (
    <Modal
      open={isOpen}
      onClose={onClose}
      title="Add Delivery Address"
      footer={
        <>
          <Button variant="secondary" type="button" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" form="add-address-form" loading={isSaving}>
            Save Address
          </Button>
        </>
      }
    >
      <form id="add-address-form" onSubmit={handleSubmit} noValidate>
        <div className="space-y-3">
          <div className="grid grid-cols-2 gap-3">
            <Input
              label="Address Label"
              placeholder="Warehouse, Kitchen…"
              value={form.label}
              onChange={handleChange("label")}
            />
            <div />
          </div>
          <Input
            label="Street"
            placeholder="123 Main St"
            value={form.line1}
            onChange={handleChange("line1")}
          />
          <div className="grid grid-cols-3 gap-3">
            <div className="col-span-2">
              <Input
                label="City"
                placeholder="Austin"
                value={form.city}
                onChange={handleChange("city")}
              />
            </div>
            <div>
              <label className="mb-1 block text-sm font-medium text-navy">State</label>
              <Input
                placeholder="TX"
                value={form.state}
                onChange={handleChange("state")}
              />
            </div>
          </div>
          <Input
            label="ZIP Code"
            placeholder="78701"
            value={form.zip}
            onChange={handleChange("zip")}
          />
        </div>
      </form>
    </Modal>
  );
}

// ─── Assign Route Modal ───────────────────────────────────────────────────────

function AssignRouteModal({
  isOpen,
  onClose,
  customerId,
  addresses,
}: {
  isOpen: boolean;
  onClose: () => void;
  customerId: string;
  addresses: { id: string; label: string; line1: string; city: string }[];
}) {
  const { data: routesData, isLoading: routesLoading } = useRoutes({ isActive: true, page: 1 });
  const addStop = useAddStopToRoute();
  const [routeId, setRouteId] = React.useState("");
  const [addressId, setAddressId] = React.useState("");
  const [notes, setNotes] = React.useState("");
  const [error, setError] = React.useState<string | null>(null);

  // Reset state when modal opens
  React.useEffect(() => {
    if (isOpen) {
      setRouteId("");
      setAddressId(addresses[0]?.id ?? "");
      setNotes("");
      setError(null);
    }
  }, [isOpen, addresses]);

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!routeId) { setError("Please select a route."); return; }
    setError(null);
    addStop.mutate(
      { routeId, customerId, customerAddressId: addressId || undefined, notes: notes || undefined },
      {
        onSuccess: () => onClose(),
        onError: (err: any) => setError(err?.response?.data?.message ?? err.message ?? "Failed to assign route."),
      },
    );
  };

  const routeOptions = routesData?.data ?? [];

  return (
    <Modal
      open={isOpen}
      onClose={onClose}
      title="Assign to Route"
      description="Add this customer as a stop on a route."
      footer={
        <>
          <Button variant="secondary" type="button" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" form="assign-route-form" loading={addStop.isPending}>
            Assign
          </Button>
        </>
      }
    >
      <form id="assign-route-form" onSubmit={handleSubmit} noValidate>
        <div className="space-y-4">
          {routesLoading ? (
            <p className="text-sm text-navy/40">Loading routes…</p>
          ) : (
            <div>
              <label className="mb-1 block text-sm font-medium text-navy">Route</label>
              <select
                value={routeId}
                onChange={(e) => setRouteId(e.target.value)}
                className="h-10 w-full rounded border border-surface-border bg-white px-3 text-sm text-navy focus:border-transparent focus:outline-none focus:ring-2 focus:ring-brand-500"
              >
                <option value="">Select a route…</option>
                {routeOptions.map((r) => (
                  <option key={r.id} value={r.id}>{r.name}</option>
                ))}
              </select>
            </div>
          )}
          {addresses.length > 0 && (
            <div>
              <label className="mb-1 block text-sm font-medium text-navy">Delivery Address</label>
              <select
                value={addressId}
                onChange={(e) => setAddressId(e.target.value)}
                className="h-10 w-full rounded border border-surface-border bg-white px-3 text-sm text-navy focus:border-transparent focus:outline-none focus:ring-2 focus:ring-brand-500"
              >
                <option value="">No specific address</option>
                {addresses.map((a) => (
                  <option key={a.id} value={a.id}>{a.label} — {a.line1}, {a.city}</option>
                ))}
              </select>
            </div>
          )}
          <div>
            <label className="mb-1 block text-sm font-medium text-navy">
              Stop Notes <span className="text-navy/40 font-normal">(optional)</span>
            </label>
            <input
              type="text"
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              placeholder="e.g. Leave at back door"
              className="h-10 w-full rounded border border-surface-border bg-white px-3 text-sm text-navy focus:border-transparent focus:outline-none focus:ring-2 focus:ring-brand-500"
            />
          </div>
          {error && <p className="text-sm text-danger">{error}</p>}
        </div>
      </form>
    </Modal>
  );
}

// ─── Page ─────────────────────────────────────────────────────────────────────

const STATUS_CYCLE = ["ACTIVE", "INACTIVE", "SUSPENDED"] as const;
type CustomerStatus = (typeof STATUS_CYCLE)[number];

export default function CustomerDetailPage({
  params,
}: {
  params: { id: string };
}) {
  const { setTitle } = usePageTitle();

  const { data: customer, isLoading } = useCustomer(params.id);
  const { data: ordersResult } = useCustomerOrders(params.id);
  const { data: customerRoutes } = useCustomerRoutes(params.id);
  const updateStatus = useUpdateCustomerStatus();
  const addAddress = useAddCustomerAddress();

  const allOrders: ApiOrder[] = ordersResult?.data ?? [];
  const addresses = customer?.addresses ?? [];
  const currentStatus: CustomerStatus =
    (customer?.user?.status as CustomerStatus) ?? "ACTIVE";

  React.useEffect(() => {
    setTitle(customer?.businessName ?? "Customer");
  }, [setTitle, customer?.businessName]);

  const [isEditOpen, setIsEditOpen] = React.useState(false);
  const [isAddAddressOpen, setIsAddAddressOpen] = React.useState(false);
  const [isAssignRouteOpen, setIsAssignRouteOpen] = React.useState(false);
  const [orderStatusFilter, setOrderStatusFilter] = React.useState("");
  const [pendingStatus, setPendingStatus] = React.useState<CustomerStatus | null>(null);

  if (isLoading) {
    return <div className="p-12 text-center text-navy/40">Loading...</div>;
  }

  if (!customer) {
    return (
      <div className="flex flex-col items-center gap-4 p-12 text-center">
        <p className="text-base font-medium text-navy">Customer not found.</p>
        <Button variant="secondary" href="/customers">
          Back to Customers
        </Button>
      </div>
    );
  }

  const filteredOrders = orderStatusFilter
    ? allOrders.filter((o) => o.status === orderStatusFilter)
    : allOrders;

  const handleStatusChange = (s: CustomerStatus) => {
    if (s === "INACTIVE" || s === "SUSPENDED") {
      // Confirm before deactivating
      setPendingStatus(s);
    } else {
      // Re-activating — no confirmation needed
      updateStatus.mutate({ id: params.id, status: s });
    }
  };

  const confirmStatusChange = () => {
    if (!pendingStatus) return;
    updateStatus.mutate({ id: params.id, status: pendingStatus }, {
      onSuccess: () => setPendingStatus(null),
    });
  };

  const handleSaveAddress = (values: AddAddressFormValues) => {
    addAddress.mutate(
      { id: params.id, ...values },
      { onSuccess: () => setIsAddAddressOpen(false) },
    );
  };

  return (
    <div className="space-y-5 p-6">
      {/* Back + header row */}
      <div className="flex items-start gap-4">
        <Link
          href="/customers"
          className="mt-0.5 flex items-center gap-1.5 text-sm text-navy/60 hover:text-navy transition-colors"
        >
          <ArrowLeft className="h-4 w-4" />
          Customers
        </Link>
      </div>

      <div className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold text-navy">{customer.businessName}</h1>
          <p className="mt-1 text-sm text-navy/60">{customer.contactName}</p>
        </div>
        <div className="flex items-center gap-3">
          <Badge status={currentStatus} />
          <Button variant="secondary" size="sm" onClick={() => setIsEditOpen(true)}>
            Edit
          </Button>
        </div>
      </div>

      {/* Tabs */}
      <Tabs.Root defaultValue="profile" className="flex flex-col">
        <Tabs.List className="flex border-b border-surface-border">
          <TabTrigger value="profile">Profile</TabTrigger>
          <TabTrigger value="orders">
            Orders{allOrders.length > 0 ? ` (${allOrders.length})` : ""}
          </TabTrigger>
          <TabTrigger value="addresses">
            Delivery Addresses ({addresses.length})
          </TabTrigger>
        </Tabs.List>

        {/* ── Profile tab ──────────────────────────────────────────────── */}
        <Tabs.Content value="profile" className="mt-5 focus:outline-none">
          <div className="grid grid-cols-1 gap-5 lg:grid-cols-3">
            {/* Contact + account details */}
            <div className="lg:col-span-2 space-y-5">
              <Card title="Contact Information">
                <div className="grid grid-cols-2 gap-4">
                  <InfoRow
                    icon={Phone}
                    label="Phone"
                    value={customer.phone ?? "—"}
                  />
                  <InfoRow
                    icon={Mail}
                    label="Email"
                    value={customer.user?.email ?? "—"}
                  />
                  <InfoRow
                    icon={FileText}
                    label="Customer Since"
                    value={
                      customer.createdAt
                        ? new Date(customer.createdAt).toLocaleDateString()
                        : "—"
                    }
                  />
                </div>
              </Card>

              {/* Assigned routes */}
              <Card title="Assigned Routes">
                <div className="space-y-3">
                  {(customerRoutes ?? []).length === 0 ? (
                    <p className="text-sm text-navy/40">Not assigned to any routes yet.</p>
                  ) : (
                    <ul className="divide-y divide-surface-border -mx-6">
                      {(customerRoutes as any[]).map((r) => (
                        <li key={r.id} className="flex items-center gap-3 px-6 py-3">
                          <Route className="h-4 w-4 shrink-0 text-navy/40" />
                          <div className="flex-1 min-w-0">
                            <p className="text-sm font-medium text-navy">{r.name}</p>
                            {r.driverName && (
                              <p className="text-xs text-navy/50">Driver: {r.driverName}</p>
                            )}
                          </div>
                          <span className={cn(
                            "shrink-0 rounded-full px-2 py-0.5 text-xs font-medium",
                            r.isActive
                              ? "bg-success-bg text-success"
                              : "bg-surface-raised text-navy/50",
                          )}>
                            {r.isActive ? "Active" : "Inactive"}
                          </span>
                        </li>
                      ))}
                    </ul>
                  )}
                  <Button
                    size="sm"
                    variant="secondary"
                    leftIcon={<Plus className="h-4 w-4" />}
                    onClick={() => setIsAssignRouteOpen(true)}
                  >
                    Assign to Route
                  </Button>
                </div>
              </Card>
            </div>

            {/* Account status */}
            <div>
              <Card title="Account Status">
                <div className="flex flex-col gap-4">
                  <div className="flex items-center justify-between">
                    <p className="text-sm text-navy/60">Current status</p>
                    <Badge status={currentStatus} />
                  </div>
                  <div className="space-y-2">
                    {STATUS_CYCLE.map((s) => (
                      <button
                        key={s}
                        onClick={() => handleStatusChange(s)}
                        disabled={updateStatus.isPending}
                        className={cn(
                          "flex w-full items-center gap-2 rounded-lg border px-3 py-2 text-sm font-medium transition-colors",
                          currentStatus === s
                            ? "border-brand-500 bg-brand-50 text-brand-700"
                            : "border-surface-border text-navy/60 hover:border-navy/30 hover:text-navy",
                        )}
                      >
                        <span
                          className={cn(
                            "h-2 w-2 rounded-full",
                            s === "ACTIVE"
                              ? "bg-success"
                              : s === "INACTIVE"
                              ? "bg-navy/30"
                              : "bg-danger",
                          )}
                        />
                        {s.charAt(0) + s.slice(1).toLowerCase()}
                      </button>
                    ))}
                  </div>
                </div>
              </Card>
            </div>
          </div>
        </Tabs.Content>

        {/* ── Orders tab ───────────────────────────────────────────────── */}
        <Tabs.Content value="orders" className="mt-5 focus:outline-none">
          <Card>
            <div className="mb-4 flex items-center justify-between gap-3">
              <h3 className="text-base font-semibold text-navy">Order History</h3>
              <div className="w-48">
                <Select
                  options={[
                    { value: "", label: "All Statuses" },
                    { value: "PENDING", label: "Pending" },
                    { value: "CONFIRMED", label: "Confirmed" },
                    { value: "OUT_FOR_DELIVERY", label: "Out for Delivery" },
                    { value: "COMPLETED", label: "Completed" },
                    { value: "CANCELLED", label: "Cancelled" },
                  ]}
                  value={orderStatusFilter}
                  onChange={(e) => setOrderStatusFilter(e.target.value)}
                />
              </div>
            </div>
            <div className="-mx-6 -mb-6">
              <Table
                data={filteredOrders}
                columns={orderColumns}
                emptyState="No orders match the selected filter."
              />
            </div>
          </Card>
        </Tabs.Content>

        {/* ── Delivery addresses tab ───────────────────────────────────── */}
        <Tabs.Content value="addresses" className="mt-5 focus:outline-none">
          <Card>
            <div className="mb-4 flex items-center justify-between">
              <h3 className="text-base font-semibold text-navy">Delivery Addresses</h3>
              <Button
                size="sm"
                leftIcon={<Plus className="h-4 w-4" />}
                onClick={() => setIsAddAddressOpen(true)}
              >
                Add Address
              </Button>
            </div>
            {addresses.length === 0 ? (
              <p className="text-sm text-navy/40">No addresses on file.</p>
            ) : (
              <ul className="-mx-6 -mb-6 divide-y divide-surface-border">
                {addresses.map((addr: any) => (
                  <li key={addr.id} className="flex items-start gap-3 px-6 py-4">
                    <MapPin className="mt-0.5 h-4 w-4 shrink-0 text-navy/40" />
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2">
                        <p className="text-sm font-medium text-navy">{addr.label}</p>
                        {addr.isDefault && (
                          <Star className="h-3.5 w-3.5 fill-warning text-warning" />
                        )}
                      </div>
                      <p className="mt-0.5 text-sm text-navy/60">
                        {addr.line1}
                        {addr.line2 ? `, ${addr.line2}` : ""}, {addr.city},{" "}
                        {addr.state} {addr.zip}
                      </p>
                    </div>
                    {addr.isDefault && (
                      <span className="shrink-0 rounded-full bg-brand-100 px-2 py-0.5 text-xs font-medium text-brand-700">
                        Primary
                      </span>
                    )}
                  </li>
                ))}
              </ul>
            )}
          </Card>
        </Tabs.Content>
      </Tabs.Root>

      {/* Modals */}
      <CustomerFormModal
        isOpen={isEditOpen}
        onClose={() => setIsEditOpen(false)}
        mode="edit"
        initialData={customer}
      />
      <AddAddressModal
        isOpen={isAddAddressOpen}
        onClose={() => setIsAddAddressOpen(false)}
        onSave={handleSaveAddress}
        isSaving={addAddress.isPending}
      />
      <AssignRouteModal
        isOpen={isAssignRouteOpen}
        onClose={() => setIsAssignRouteOpen(false)}
        customerId={params.id}
        addresses={addresses.map((a: any) => ({
          id: a.id,
          label: a.label ?? "Address",
          line1: a.line1,
          city: a.city,
        }))}
      />

      {/* Status change confirmation (INACTIVE / SUSPENDED) */}
      <ConfirmDialog
        open={pendingStatus !== null}
        onClose={() => setPendingStatus(null)}
        onConfirm={confirmStatusChange}
        title={pendingStatus === "SUSPENDED" ? "Suspend this customer?" : "Deactivate this customer?"}
        description={
          pendingStatus === "SUSPENDED"
            ? `${customer.businessName} will be suspended and will lose access to the platform.`
            : `${customer.businessName} will be marked as inactive.`
        }
        confirmLabel={pendingStatus === "SUSPENDED" ? "Yes, suspend" : "Yes, deactivate"}
        variant={pendingStatus === "SUSPENDED" ? "danger" : "secondary"}
        loading={updateStatus.isPending}
      />
    </div>
  );
}
