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
  Clock,
  Pencil,
  Trash2,
  Zap,
  TrendingDown,
  CheckCircle2,
  DollarSign,
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
  useUpdateCustomer,
  useUpdateCustomerStatus,
  useAddCustomerAddress,
  useCustomerStatement,
  useCustomerAdvancePayments,
  useCreateAdvancePayment,
  type AdvancePayment,
} from "@/lib/api/customers";
import { useRoutes, useAddStopToRoute } from "@/lib/api/routes";
import {
  useOrderTemplates,
  useUpdateOrderTemplate,
  useDeleteOrderTemplate,
  useGenerateTemplateOrder,
  type OrderTemplate,
} from "@/lib/api/order-templates";
import { StandingOrderModal } from "./StandingOrderModal";
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
  const { data: orderTemplates } = useOrderTemplates(params.id);
  const updateStatus = useUpdateCustomerStatus();
  const updateCustomer = useUpdateCustomer();
  const addAddress = useAddCustomerAddress();
  const updateTemplate = useUpdateOrderTemplate();
  const deleteTemplate = useDeleteOrderTemplate();
  const generateOrder = useGenerateTemplateOrder();

  const { data: statement } = useCustomerStatement(params.id);
  const { data: advancePayments } = useCustomerAdvancePayments(params.id);
  const createAdvance = useCreateAdvancePayment();

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

  // Delivery time window
  const [windowStart, setWindowStart] = React.useState(customer?.deliveryWindowStart ?? "");
  const [windowEnd, setWindowEnd] = React.useState(customer?.deliveryWindowEnd ?? "");
  const [anyTime, setAnyTime] = React.useState(!customer?.deliveryWindowStart && !customer?.deliveryWindowEnd);

  React.useEffect(() => {
    if (customer) {
      setWindowStart(customer.deliveryWindowStart ?? "");
      setWindowEnd(customer.deliveryWindowEnd ?? "");
      setAnyTime(!customer.deliveryWindowStart && !customer.deliveryWindowEnd);
    }
  }, [customer?.deliveryWindowStart, customer?.deliveryWindowEnd]);

  const handleAnyTimeToggle = (checked: boolean) => {
    setAnyTime(checked);
    if (checked) {
      setWindowStart("");
      setWindowEnd("");
      updateCustomer.mutate({ id: params.id, deliveryWindowStart: "", deliveryWindowEnd: "" });
    }
  };

  // Advance payment
  const [isAdvanceOpen, setIsAdvanceOpen] = React.useState(false);
  const [advanceForm, setAdvanceForm] = React.useState({ method: "ACH", amount: "", reference: "", notes: "" });

  // Standing orders
  const [isStandingOrderOpen, setIsStandingOrderOpen] = React.useState(false);
  const [editingTemplate, setEditingTemplate] = React.useState<OrderTemplate | null>(null);
  const [deletingTemplateId, setDeletingTemplateId] = React.useState<string | null>(null);

  const templates = orderTemplates ?? [];

  const handleTimeWindowBlur = () => {
    updateCustomer.mutate({
      id: params.id,
      deliveryWindowStart: windowStart || undefined,
      deliveryWindowEnd: windowEnd || undefined,
    });
  };

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
          <TabTrigger value="standing-orders">
            Standing Orders{templates.length > 0 ? ` (${templates.length})` : ""}
          </TabTrigger>
          <TabTrigger value="billing">Billing</TabTrigger>
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

              {/* Delivery time window */}
              <Card title="Delivery Time Window">
                <div className="space-y-3">
                  <p className="text-sm text-navy/60">
                    Set the customer's accepted delivery hours. The route optimizer will schedule
                    this stop within the window.
                  </p>
                  {/* Any time toggle */}
                  <label className="flex cursor-pointer items-center gap-2">
                    <input
                      type="checkbox"
                      checked={anyTime}
                      onChange={(e) => handleAnyTimeToggle(e.target.checked)}
                      className="h-4 w-4 rounded border-surface-border text-brand-500 focus:ring-brand-500"
                    />
                    <span className="text-sm font-medium text-navy">Any time (24/7 — no window restriction)</span>
                  </label>
                  <div className={`grid grid-cols-2 gap-4 transition-opacity ${anyTime ? "pointer-events-none opacity-40" : ""}`}>
                    <div className="space-y-1">
                      <label className="flex items-center gap-1.5 text-xs font-medium text-navy/60">
                        <Clock className="h-3.5 w-3.5" />
                        Window Start
                      </label>
                      <input
                        type="time"
                        value={windowStart}
                        onChange={(e) => setWindowStart(e.target.value)}
                        onBlur={handleTimeWindowBlur}
                        disabled={anyTime}
                        className="h-10 w-full rounded border border-surface-border bg-white px-3 text-sm text-navy focus:border-transparent focus:outline-none focus:ring-2 focus:ring-brand-500 disabled:bg-surface-raised"
                        placeholder="08:00"
                      />
                    </div>
                    <div className="space-y-1">
                      <label className="flex items-center gap-1.5 text-xs font-medium text-navy/60">
                        <Clock className="h-3.5 w-3.5" />
                        Window End
                      </label>
                      <input
                        type="time"
                        value={windowEnd}
                        onChange={(e) => setWindowEnd(e.target.value)}
                        onBlur={handleTimeWindowBlur}
                        disabled={anyTime}
                        className="h-10 w-full rounded border border-surface-border bg-white px-3 text-sm text-navy focus:border-transparent focus:outline-none focus:ring-2 focus:ring-brand-500 disabled:bg-surface-raised"
                        placeholder="17:00"
                      />
                    </div>
                  </div>
                  {!anyTime && windowStart && windowEnd && (
                    <p className="text-xs text-success font-medium">
                      Window: {windowStart} – {windowEnd}
                    </p>
                  )}
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
        {/* ── Standing Orders tab ──────────────────────────────────────── */}
        <Tabs.Content value="standing-orders" className="mt-5 focus:outline-none">
          <Card>
            <div className="mb-4 flex items-center justify-between">
              <div>
                <h3 className="text-base font-semibold text-navy">Standing Orders</h3>
                <p className="text-xs text-navy/50 mt-0.5">
                  Auto-generated orders based on recurring schedules.
                </p>
              </div>
              <Button
                size="sm"
                leftIcon={<Plus className="h-4 w-4" />}
                onClick={() => { setEditingTemplate(null); setIsStandingOrderOpen(true); }}
              >
                Add Standing Order
              </Button>
            </div>

            {templates.length === 0 ? (
              <div className="rounded-lg border border-dashed border-surface-border bg-surface-raised py-10 text-center">
                <p className="text-sm text-navy/40">No standing orders yet.</p>
                <button
                  className="mt-2 text-sm text-brand-500 hover:underline"
                  onClick={() => { setEditingTemplate(null); setIsStandingOrderOpen(true); }}
                >
                  Add the first one →
                </button>
              </div>
            ) : (
              <ul className="-mx-6 -mb-6 divide-y divide-surface-border">
                {templates.map((tmpl) => (
                  <li key={tmpl.id} className="px-6 py-4">
                    <div className="flex items-start justify-between gap-4">
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2">
                          <p className="text-sm font-semibold text-navy">{tmpl.name}</p>
                          <span
                            className={cn(
                              "rounded-full px-2 py-0.5 text-xs font-medium",
                              tmpl.isActive
                                ? "bg-success-bg text-success"
                                : "bg-surface-raised text-navy/40",
                            )}
                          >
                            {tmpl.isActive ? "Active" : "Paused"}
                          </span>
                        </div>
                        {/* Days pills */}
                        <div className="mt-1.5 flex flex-wrap gap-1">
                          {[1, 2, 3, 4, 5, 6, 7].map((iso) => {
                            const labels = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
                            return tmpl.daysOfWeek.includes(iso) ? (
                              <span
                                key={iso}
                                className="rounded-full bg-brand-50 px-2 py-0.5 text-xs font-medium text-brand-700"
                              >
                                {labels[iso - 1]}
                              </span>
                            ) : null;
                          })}
                        </div>
                        <p className="mt-1 text-xs text-navy/50">
                          {tmpl.items.length} item{tmpl.items.length !== 1 ? "s" : ""}
                          {tmpl.notes && ` · ${tmpl.notes}`}
                        </p>
                      </div>

                      {/* Actions */}
                      <div className="flex items-center gap-1 shrink-0">
                        {/* Toggle active */}
                        <button
                          title={tmpl.isActive ? "Pause template" : "Activate template"}
                          className="rounded p-1.5 text-navy/40 hover:bg-surface-raised hover:text-navy transition-colors"
                          onClick={() =>
                            updateTemplate.mutate({ id: tmpl.id, isActive: !tmpl.isActive })
                          }
                        >
                          <span className={cn("h-4 w-4 block", tmpl.isActive ? "text-success" : "text-navy/30")}>
                            {tmpl.isActive ? "⏸" : "▶"}
                          </span>
                        </button>
                        {/* Generate now */}
                        <button
                          title="Generate order now"
                          className="rounded p-1.5 text-navy/40 hover:bg-brand-50 hover:text-brand-600 transition-colors"
                          onClick={() =>
                            generateOrder.mutate(tmpl.id, {
                              onSuccess: () =>
                                window.alert(`Order generated for "${tmpl.name}"!`),
                            })
                          }
                        >
                          <Zap className="h-4 w-4" />
                        </button>
                        {/* Edit */}
                        <button
                          title="Edit template"
                          className="rounded p-1.5 text-navy/40 hover:bg-surface-raised hover:text-navy transition-colors"
                          onClick={() => { setEditingTemplate(tmpl); setIsStandingOrderOpen(true); }}
                        >
                          <Pencil className="h-4 w-4" />
                        </button>
                        {/* Delete */}
                        <button
                          title="Delete template"
                          className="rounded p-1.5 text-navy/40 hover:bg-danger-bg hover:text-danger transition-colors"
                          onClick={() => setDeletingTemplateId(tmpl.id)}
                        >
                          <Trash2 className="h-4 w-4" />
                        </button>
                      </div>
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </Card>
        </Tabs.Content>

        {/* ── Billing tab ──────────────────────────────────────────────── */}
        <Tabs.Content value="billing" className="mt-5 focus:outline-none">
          <div className="grid grid-cols-1 gap-5 lg:grid-cols-3">
            {/* Balance cards */}
            <div className="lg:col-span-1 space-y-4">
              <Card>
                <div className="space-y-3">
                  <div className="flex items-center justify-between">
                    <p className="text-xs font-semibold uppercase tracking-wider text-navy/40">Open Balance</p>
                    <TrendingDown className="h-4 w-4 text-danger" />
                  </div>
                  <p className={`text-2xl font-bold ${(statement?.outstandingAmount ?? 0) > 0 ? "text-danger" : "text-success"}`}>
                    {new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(statement?.outstandingAmount ?? 0)}
                  </p>
                  <p className="text-xs text-navy/50">Amount currently owed on invoices</p>
                </div>
              </Card>
              <Card>
                <div className="space-y-3">
                  <div className="flex items-center justify-between">
                    <p className="text-xs font-semibold uppercase tracking-wider text-navy/40">Advance Balance</p>
                    <DollarSign className="h-4 w-4 text-success" />
                  </div>
                  <p className="text-2xl font-bold text-success">
                    {new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(statement?.advanceBalance ?? 0)}
                  </p>
                  <p className="text-xs text-navy/50">Pre-paid credit available to apply</p>
                  <Button
                    size="sm"
                    variant="secondary"
                    className="w-full"
                    leftIcon={<Plus className="h-4 w-4" />}
                    onClick={() => { setAdvanceForm({ method: "ACH", amount: "", reference: "", notes: "" }); setIsAdvanceOpen(true); }}
                  >
                    Record Advance Payment
                  </Button>
                </div>
              </Card>

              {/* Advance payments list */}
              {(advancePayments ?? []).length > 0 && (
                <Card title="Advance Payments">
                  <ul className="-mx-6 -mb-6 divide-y divide-surface-border">
                    {(advancePayments ?? []).map((ap: AdvancePayment) => (
                      <li key={ap.id} className="px-6 py-3">
                        <div className="flex items-center justify-between">
                          <span className="text-sm font-semibold text-navy">
                            {new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(Number(ap.amount))}
                          </span>
                          <span className={`text-xs font-medium ${Number(ap.balance) > 0 ? "text-success" : "text-navy/40"}`}>
                            {new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(Number(ap.balance))} left
                          </span>
                        </div>
                        <p className="mt-0.5 text-xs text-navy/50">
                          {ap.method}{ap.reference ? ` · ${ap.reference}` : ""} · {new Date(ap.createdAt).toLocaleDateString()}
                        </p>
                      </li>
                    ))}
                  </ul>
                </Card>
              )}
            </div>

            {/* Statement — Zoho-style rendered document */}
            <div className="lg:col-span-2 space-y-4">
              {/* Statement header & controls */}
              <div className="flex flex-wrap items-center justify-between gap-3">
                <h3 className="text-base font-semibold text-navy">Statement of Accounts</h3>
                <div className="flex items-center gap-2">
                  <button
                    onClick={() => window.print()}
                    className="flex items-center gap-1.5 rounded border border-surface-border bg-white px-3 py-1.5 text-sm font-medium text-navy/70 transition-colors hover:bg-surface-raised"
                  >
                    Print
                  </button>
                </div>
              </div>

              {/* Rendered statement document */}
              <div className="rounded-xl border border-surface-border bg-white p-8 shadow-[0_2px_12px_0_rgb(0,0,0,0.06)]">
                {/* Document header */}
                <div className="mb-6 flex items-start justify-between">
                  <div>
                    <div className="flex items-center gap-2">
                      <div className="flex h-7 w-7 items-center justify-center rounded-lg bg-brand-500 text-xs font-bold text-white">
                        RF
                      </div>
                      <span className="text-base font-bold text-navy">RouteFlow</span>
                    </div>
                    <p className="mt-0.5 text-xs text-navy/50">Austin, TX · routeflow.io</p>
                  </div>
                  <div className="text-right">
                    <p className="text-lg font-bold uppercase tracking-wide text-navy">Statement of Accounts</p>
                    <p className="mt-0.5 text-xs text-navy/50">
                      As of {new Date().toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric" })}
                    </p>
                  </div>
                </div>

                {/* To block */}
                <div className="mb-6 border-t border-surface-border pt-4">
                  <p className="text-xs font-semibold uppercase tracking-wider text-navy/40">To</p>
                  <p className="mt-1 text-sm font-semibold text-navy">{customer.businessName}</p>
                  {customer.contactName && (
                    <p className="text-sm text-navy/60">{customer.contactName}</p>
                  )}
                  {customer.address && (
                    <p className="mt-0.5 text-xs text-navy/50 whitespace-pre-line">{customer.address}</p>
                  )}
                </div>

                {/* Account summary box */}
                <div className="mb-6 grid grid-cols-4 gap-px overflow-hidden rounded-lg border border-surface-border bg-surface-border">
                  {[
                    {
                      label: "Opening Balance",
                      value: new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(0),
                      valueClass: "text-navy",
                    },
                    {
                      label: "Invoiced Amount",
                      value: new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(
                        statement?.transactions
                          .filter((tx) => tx.type === "invoice")
                          .reduce((s, tx) => s + Math.abs(tx.amount), 0) ?? 0
                      ),
                      valueClass: "text-navy",
                    },
                    {
                      label: "Amount Received",
                      value: new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(
                        statement?.transactions
                          .filter((tx) => tx.type === "payment" || tx.type === "advance")
                          .reduce((s, tx) => s + Math.abs(tx.amount), 0) ?? 0
                      ),
                      valueClass: "text-success",
                    },
                    {
                      label: "Balance Due",
                      value: new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(statement?.outstandingAmount ?? 0),
                      valueClass: (statement?.outstandingAmount ?? 0) > 0 ? "text-danger" : "text-success",
                    },
                  ].map((item) => (
                    <div key={item.label} className="flex flex-col items-center gap-1 bg-white px-4 py-3 text-center">
                      <span className="text-xs font-semibold uppercase tracking-wider text-navy/40">{item.label}</span>
                      <span className={cn("text-base font-bold", item.valueClass)}>{item.value}</span>
                    </div>
                  ))}
                </div>

                {/* Transaction ledger */}
                {!statement || statement.transactions.length === 0 ? (
                  <p className="text-sm text-navy/40">No transactions on record.</p>
                ) : (
                  <div className="-mx-8 overflow-hidden">
                    <table className="w-full text-sm">
                      <thead>
                        <tr className="bg-[#1B3A5C]">
                          <th className="px-8 py-2.5 text-left text-xs font-semibold uppercase tracking-wider text-white/80">Date</th>
                          <th className="px-4 py-2.5 text-left text-xs font-semibold uppercase tracking-wider text-white/80">Type</th>
                          <th className="px-4 py-2.5 text-left text-xs font-semibold uppercase tracking-wider text-white/80">Details</th>
                          <th className="px-4 py-2.5 text-right text-xs font-semibold uppercase tracking-wider text-white/80">Amount</th>
                          <th className="px-4 py-2.5 text-right text-xs font-semibold uppercase tracking-wider text-white/80">Payments</th>
                          <th className="px-8 py-2.5 text-right text-xs font-semibold uppercase tracking-wider text-white/80">Balance</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-surface-border">
                        {statement.transactions.map((tx, i) => {
                          const isInvoice = tx.type === "invoice";
                          const isPayment = tx.type === "payment" || tx.type === "advance";
                          return (
                            <tr key={i} className={i % 2 === 0 ? "bg-white" : "bg-gray-50/60"}>
                              <td className="px-8 py-2.5 text-xs text-navy/60">
                                {new Date(tx.date).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" })}
                              </td>
                              <td className="px-4 py-2.5">
                                <span className={cn(
                                  "inline-flex items-center rounded-full px-2 py-0.5 text-xs font-semibold",
                                  isInvoice ? "bg-blue-100 text-blue-700" : "bg-green-100 text-green-700",
                                )}>
                                  {isInvoice ? "Invoice" : "Payment"}
                                </span>
                              </td>
                              <td className="px-4 py-2.5 text-sm text-navy">
                                {tx.invoiceNumber ? (
                                  <Link
                                    href={`/invoices/${tx.invoiceId}`}
                                    className="font-mono text-xs font-semibold text-brand-500 hover:underline"
                                    onClick={(e) => e.stopPropagation()}
                                  >
                                    {tx.invoiceNumber}
                                  </Link>
                                ) : (
                                  <span className="text-xs text-navy/60">{tx.description}</span>
                                )}
                              </td>
                              <td className="px-4 py-2.5 text-right text-sm">
                                {isInvoice ? (
                                  <span className="font-medium text-navy">
                                    {new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(Math.abs(tx.amount))}
                                  </span>
                                ) : (
                                  <span className="text-navy/30">—</span>
                                )}
                              </td>
                              <td className="px-4 py-2.5 text-right text-sm">
                                {isPayment ? (
                                  <span className="font-medium text-success">
                                    {new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(Math.abs(tx.amount))}
                                  </span>
                                ) : (
                                  <span className="text-navy/30">—</span>
                                )}
                              </td>
                              <td className="px-8 py-2.5 text-right font-semibold text-navy">
                                {new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(tx.balance)}
                              </td>
                            </tr>
                          );
                        })}
                      </tbody>
                      <tfoot>
                        <tr className="border-t-2 border-surface-border bg-gray-50">
                          <td colSpan={3} className="px-8 py-3 text-sm font-bold text-navy">Balance Due</td>
                          <td colSpan={2} />
                          <td className={cn(
                            "px-8 py-3 text-right text-sm font-bold",
                            (statement?.outstandingAmount ?? 0) > 0 ? "text-danger" : "text-success",
                          )}>
                            {new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(statement?.outstandingAmount ?? 0)}
                          </td>
                        </tr>
                      </tfoot>
                    </table>
                  </div>
                )}
              </div>
            </div>
          </div>

          {/* Record Advance Payment Modal */}
          <Modal
            open={isAdvanceOpen}
            onClose={() => setIsAdvanceOpen(false)}
            title="Record Advance Payment"
            description="Record a pre-payment that can be applied to future invoices."
            footer={
              <>
                <Button variant="secondary" onClick={() => setIsAdvanceOpen(false)} disabled={createAdvance.isPending}>Cancel</Button>
                <Button
                  loading={createAdvance.isPending}
                  onClick={() => {
                    const amt = parseFloat(advanceForm.amount);
                    if (!amt || amt <= 0) return;
                    createAdvance.mutate(
                      { customerId: params.id, method: advanceForm.method, amount: amt, reference: advanceForm.reference || undefined, notes: advanceForm.notes || undefined },
                      { onSuccess: () => setIsAdvanceOpen(false) },
                    );
                  }}
                >
                  Record
                </Button>
              </>
            }
          >
            <div className="space-y-4">
              <div>
                <label className="mb-1.5 block text-sm font-medium text-navy/80">Payment Method</label>
                <select
                  value={advanceForm.method}
                  onChange={(e) => setAdvanceForm((f) => ({ ...f, method: e.target.value }))}
                  className="h-10 w-full rounded-lg border border-surface-border bg-white px-3 text-sm text-navy focus:border-transparent focus:outline-none focus:ring-2 focus:ring-brand-500"
                >
                  <option value="CASH">Cash</option>
                  <option value="CHECK">Check</option>
                  <option value="ACH">ACH / Bank Transfer</option>
                  <option value="OTHER">Other</option>
                </select>
              </div>
              <div>
                <label className="mb-1.5 block text-sm font-medium text-navy/80">Amount ($)</label>
                <input
                  type="number" step="0.01" min="0.01" placeholder="0.00"
                  value={advanceForm.amount}
                  onChange={(e) => setAdvanceForm((f) => ({ ...f, amount: e.target.value }))}
                  className="h-10 w-full rounded-lg border border-surface-border bg-white px-3 text-sm text-navy placeholder:text-navy/30 focus:border-transparent focus:outline-none focus:ring-2 focus:ring-brand-500"
                />
              </div>
              <div>
                <label className="mb-1.5 block text-sm font-medium text-navy/80">Reference # (optional)</label>
                <input
                  type="text"
                  value={advanceForm.reference}
                  onChange={(e) => setAdvanceForm((f) => ({ ...f, reference: e.target.value }))}
                  className="h-10 w-full rounded-lg border border-surface-border bg-white px-3 text-sm text-navy placeholder:text-navy/30 focus:border-transparent focus:outline-none focus:ring-2 focus:ring-brand-500"
                />
              </div>
              <div>
                <label className="mb-1.5 block text-sm font-medium text-navy/80">Notes (optional)</label>
                <textarea
                  rows={2}
                  value={advanceForm.notes}
                  onChange={(e) => setAdvanceForm((f) => ({ ...f, notes: e.target.value }))}
                  className="w-full resize-none rounded-lg border border-surface-border bg-white px-3 py-2 text-sm text-navy placeholder:text-navy/30 focus:border-transparent focus:outline-none focus:ring-2 focus:ring-brand-500"
                />
              </div>
            </div>
          </Modal>
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

      {/* Standing order modal */}
      <StandingOrderModal
        isOpen={isStandingOrderOpen}
        onClose={() => { setIsStandingOrderOpen(false); setEditingTemplate(null); }}
        customerId={params.id}
        template={editingTemplate}
      />

      {/* Delete standing order confirmation */}
      <ConfirmDialog
        open={!!deletingTemplateId}
        onClose={() => setDeletingTemplateId(null)}
        onConfirm={() => {
          if (!deletingTemplateId) return;
          deleteTemplate.mutate(
            { id: deletingTemplateId, customerId: params.id },
            { onSuccess: () => setDeletingTemplateId(null) },
          );
        }}
        title="Delete standing order?"
        description="This template and all its items will be deleted. Existing orders generated from this template will not be affected."
        confirmLabel="Yes, delete"
        variant="danger"
        loading={deleteTemplate.isPending}
      />
    </div>
  );
}
