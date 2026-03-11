"use client";

/**
 * DEV-ONLY visual test page for the shared component library.
 * Navigate to /test-ui in development. Safe to delete when no longer needed.
 */

import * as React from "react";
import {
  Button,
  Badge,
  Card,
  Input,
  Textarea,
  Select,
  Modal,
  Table,
  StatCard,
  Avatar,
  PageHeader,
  ToastProvider,
  useToast,
  type BadgeStatus,
} from "@routeflow/ui";
import type { ColumnDef } from "@tanstack/react-table";
import {
  Package,
  Truck,
  Users,
  DollarSign,
  ArrowRight,
  Plus,
} from "lucide-react";

// ─── Sample table data ────────────────────────────────────────────────────────

interface Order {
  id: string;
  customer: string;
  status: BadgeStatus;
  amount: string;
}

const ORDERS: Order[] = [
  { id: "ORD-001", customer: "Acme Corp", status: "PENDING", amount: "$420.00" },
  { id: "ORD-002", customer: "Globex", status: "IN_PROGRESS", amount: "$1,200.00" },
  { id: "ORD-003", customer: "Initech", status: "DELIVERED", amount: "$85.50" },
  { id: "ORD-004", customer: "Umbrella", status: "CANCELLED", amount: "$640.00" },
];

const ORDER_COLUMNS: ColumnDef<Order, unknown>[] = [
  { accessorKey: "id", header: "Order ID" },
  { accessorKey: "customer", header: "Customer", enableSorting: true },
  {
    accessorKey: "status",
    header: "Status",
    cell: ({ getValue }: { getValue: () => unknown }) => (
      <Badge status={getValue() as BadgeStatus} />
    ),
  },
  { accessorKey: "amount", header: "Amount", enableSorting: true },
];

const ALL_STATUSES: BadgeStatus[] = [
  "ACTIVE", "INACTIVE", "SUSPENDED", "PENDING", "CONFIRMED",
  "OUT_FOR_DELIVERY", "DELIVERED", "CANCELLED", "SCHEDULED",
  "IN_PROGRESS", "COMPLETED",
];

// ─── Toast demo (needs ToastProvider context) ─────────────────────────────────

function ToastDemo() {
  const { toast } = useToast();
  return (
    <Card title="Toast">
      <div className="flex flex-wrap gap-2">
        {(["success", "error", "warning", "info"] as const).map((v) => (
          <Button
            key={v}
            variant="secondary"
            size="sm"
            onClick={() =>
              toast({
                variant: v,
                title: `${v.charAt(0).toUpperCase() + v.slice(1)} toast`,
                description: `This is a ${v} notification. Auto-dismisses in 4s.`,
              })
            }
          >
            {v}
          </Button>
        ))}
      </div>
    </Card>
  );
}

// ─── Modal demo ───────────────────────────────────────────────────────────────

function ModalDemo() {
  const [open, setOpen] = React.useState(false);
  return (
    <Card title="Modal">
      <Button onClick={() => setOpen(true)}>Open Modal</Button>
      <Modal
        open={open}
        onClose={() => setOpen(false)}
        title="Confirm Action"
        footer={
          <>
            <Button variant="secondary" onClick={() => setOpen(false)}>
              Cancel
            </Button>
            <Button onClick={() => setOpen(false)}>Confirm</Button>
          </>
        }
      >
        <p>Are you sure you want to proceed? This action cannot be undone.</p>
      </Modal>
    </Card>
  );
}

// ─── Page ─────────────────────────────────────────────────────────────────────

export default function TestUIPage() {
  return (
    <ToastProvider>
      <div className="min-h-screen bg-surface-raised p-8">
        <div className="mx-auto max-w-5xl space-y-8">
          <PageHeader
            title="Component Library"
            subtitle="Visual test page — all variants rendered"
            action={<Button leftIcon={<Plus className="h-4 w-4" />}>New Item</Button>}
          />

          {/* Buttons */}
          <Card title="Button — variants & sizes">
            <div className="space-y-4">
              <div className="flex flex-wrap gap-3">
                {(["primary", "secondary", "ghost", "danger", "link"] as const).map((v) => (
                  <Button key={v} variant={v}>{v}</Button>
                ))}
              </div>
              <div className="flex flex-wrap items-center gap-3">
                {(["sm", "md", "lg"] as const).map((s) => (
                  <Button key={s} size={s}>{s}</Button>
                ))}
              </div>
              <div className="flex flex-wrap gap-3">
                <Button loading>Loading</Button>
                <Button disabled>Disabled</Button>
                <Button
                  leftIcon={<ArrowRight className="h-4 w-4" />}
                  rightIcon={<ArrowRight className="h-4 w-4" />}
                >
                  With icons
                </Button>
                <Button href="#" variant="secondary">Link button</Button>
              </div>
            </div>
          </Card>

          {/* Badges */}
          <Card title="Badge — all statuses">
            <div className="flex flex-wrap gap-2">
              {ALL_STATUSES.map((s) => (
                <Badge key={s} status={s} />
              ))}
            </div>
            <div className="mt-4 flex flex-wrap gap-2">
              {(["success", "warning", "danger", "info", "neutral"] as const).map((v) => (
                <Badge key={v} variant={v} label={v} />
              ))}
            </div>
          </Card>

          {/* Stat cards */}
          <div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
            <StatCard
              label="Total Orders"
              value="1,284"
              icon={<Package className="h-5 w-5" />}
              trend={12.4}
              trendLabel="vs last month"
            />
            <StatCard
              label="Active Routes"
              value="38"
              icon={<Truck className="h-5 w-5" />}
              trend={-3.1}
            />
            <StatCard
              label="Customers"
              value="214"
              icon={<Users className="h-5 w-5" />}
              trend={5.8}
            />
            <StatCard
              label="Revenue"
              value="$48,200"
              icon={<DollarSign className="h-5 w-5" />}
            />
          </div>

          {/* Avatars */}
          <Card title="Avatar — sizes & fallbacks">
            <div className="flex flex-wrap items-center gap-4">
              <Avatar size="sm" name="Alice Johnson" />
              <Avatar size="md" name="Bob Smith" />
              <Avatar size="lg" name="Charlie Brown" />
              <Avatar size="md" src="https://i.pravatar.cc/80" alt="Random user" />
              <Avatar size="md" src="broken-url" name="Fallback" />
              <Avatar size="md" />
            </div>
          </Card>

          {/* Form components */}
          <Card title="Form — Input, Textarea, Select">
            <div className="grid gap-4 sm:grid-cols-2">
              <Input label="Full name" placeholder="John Doe" />
              <Input label="Email" placeholder="john@example.com" type="email" />
              <Input label="With error" placeholder="Enter value" error="This field is required" />
              <Input label="Disabled" placeholder="Can't touch this" disabled />
              <Select
                label="Status"
                placeholder="Select a status…"
                options={[
                  { value: "active", label: "Active" },
                  { value: "inactive", label: "Inactive" },
                  { value: "suspended", label: "Suspended" },
                ]}
              />
              <Select
                label="Select with error"
                placeholder="Pick one…"
                options={[{ value: "a", label: "Option A" }]}
                error="Please select an option"
              />
              <div className="sm:col-span-2">
                <Textarea label="Notes" placeholder="Add notes here…" />
              </div>
              <div className="sm:col-span-2">
                <Textarea
                  label="Error textarea"
                  placeholder="Required"
                  error="This field cannot be empty"
                />
              </div>
            </div>
          </Card>

          {/* Table */}
          <Card title="Table — sortable, loading skeleton, empty state">
            <div className="space-y-4">
              <Table data={ORDERS} columns={ORDER_COLUMNS} />
              <p className="text-sm font-medium text-navy/60">Loading skeleton:</p>
              <Table data={[]} columns={ORDER_COLUMNS} isLoading />
              <p className="text-sm font-medium text-navy/60">Empty state:</p>
              <Table
                data={[]}
                columns={ORDER_COLUMNS}
                emptyState={
                  <span className="text-sm text-navy/40">No orders found. Try adjusting filters.</span>
                }
              />
            </div>
          </Card>

          {/* Modal */}
          <ModalDemo />

          {/* Toast */}
          <ToastDemo />
        </div>
      </div>
    </ToastProvider>
  );
}
