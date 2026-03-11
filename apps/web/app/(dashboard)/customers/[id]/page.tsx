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
  useUpdateCustomerStatus,
  useAddCustomerAddress,
} from "@/lib/api/customers";

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
  const [orderStatusFilter, setOrderStatusFilter] = React.useState("");

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
    updateStatus.mutate({ id: params.id, status: s });
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

              {/* Assigned routes — not available from API yet */}
              <Card title="Assigned Routes">
                <p className="text-sm text-navy/40">No routes data available.</p>
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
    </div>
  );
}
