"use client";

import * as React from "react";
import Link from "next/link";
import { useParams, useRouter, useSearchParams } from "next/navigation";
import * as Tabs from "@radix-ui/react-tabs";
import { useQueryClient } from "@tanstack/react-query";
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
  X,
  MessageSquare,
  User,
  Building2,
  Camera,
  ZoomIn,
  Upload,
  Download,
  ShieldCheck,
  Wallet,
  UserCheck,
} from "lucide-react";
import {
  Avatar,
  Badge,
  Button,
  Card,
  Table,
  Select,
  Modal,
  Input,
  StatCard,
  cn,
  TAP_TARGET,
  useToast,
  type BadgeStatus,
} from "@routeflow/ui/web";
import {
  BarChart,
  Bar,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
  Legend,
} from "recharts";
import { usePageTitle } from "@/lib/page-title-context";
import { useAuth } from "@/lib/auth-context";
import { useApprovePortalRequest, useDeclinePortalRequest } from "@/lib/api/portal-approvals";
import { CustomerFormModal } from "../_components/CustomerFormModal";
import { AuthorizationsTab } from "../_components/AuthorizationsTab";
import { fmt, fmtCalendarDate, fmtDate } from "@/lib/formatting";
import { getTierPrice, computeMarginFraction, classifyMargin } from "@routeflow/pricing";
import {
  SELECTABLE_PAYMENT_METHODS,
  PAYMENT_METHOD_LABELS,
  paymentMethodLabel,
  type SelectablePaymentMethod,
} from "@/lib/payment-methods";
import { useMarginConfig } from "@/lib/api/margin";
import { useTierLabels } from "@/lib/api/tier-labels";
import { tierLabel } from "@/lib/tier-label";
import {
  useCustomer,
  useCustomerOrders,
  useCustomerRoutes,
  useUpdateCustomer,
  useUpdateCustomerStatus,
  useAddCustomerAddress,
  useUpdateCustomerAddress,
  useDeleteCustomerAddress,
  useCustomerStatement,
  useCustomerAdvancePayments,
  useCreateAdvancePayment,
  useCustomerPrices,
  useUpsertCustomerPrice,
  useDeleteCustomerPrice,
  useContactPersons,
  useAddContactPerson,
  useUpdateContactPerson,
  useDeleteContactPerson,
  useCustomerTags,
  useAssignCustomerTag,
  useRemoveCustomerTag,
  useCustomerComments,
  useAddCustomerComment,
  useDeleteCustomerComment,
  useCustomerIncomeChart,
  usePortalStatus,
  useSendPortalInvite,
  useResendPortalInvite,
  useDisconnectPortal,
  useSoftDeleteCustomer,
  useRestoreCustomer,
  useCustomerTaxDocuments,
  useUploadCustomerTaxDocuments,
  useDeleteCustomerTaxDocument,
  useCustomerDocuments,
  useUploadCustomerDocuments,
  useDeleteCustomerDocument,
  type CustomerDocument,
  type AdvancePayment,
  type CustomerPrice,
  type ContactPerson,
  type CustomerTag,
  type PortalStatus,
  type CustomerComment,
} from "@/lib/api/customers";
import { useUndo } from "@/lib/undo";
import { useProducts } from "@/lib/api/products";
import { useHasAddon } from "@/lib/api/tobacco";
import { MSRP_ADDON, SALES_AGENTS_ADDON, useRoutesAccess } from "@/lib/api/addons";
import {
  useCustomerCurrentAgent,
  useSalesAgents,
  useAddAssignment,
  useCloseAssignment,
  pctLabel,
} from "@/lib/api/sales-agents";
import { useInvoices } from "@/lib/api/invoices";
import { useRoutes, useAddStopToRoute } from "@/lib/api/routes";
import {
  useOrderTemplates,
  useUpdateOrderTemplate,
  useDeleteOrderTemplate,
  useGenerateTemplateOrder,
  type OrderTemplate,
} from "@/lib/api/order-templates";
import { StandingOrderModal } from "./StandingOrderModal";
import { LedgerTruncationNote } from "./ledger-truncation-note";
import { ConfirmDialog } from "@/components/ConfirmDialog";
import { CustomerRecordPaymentModal } from "@/components/CustomerRecordPaymentModal";
import { AddressAutocomplete } from "@/components/AddressAutocomplete";
import { BrandMark } from "@/components/brand";

// ── Types ─────────────────────────────────────────────────────────────────────

interface ApiOrder {
  id: string;
  orderNumber?: string;
  status: string;
  createdAt: string;
  [key: string]: unknown;
}

// ── Order table columns (stable outside component) ───────────────────────────

const orderColumns: ColumnDef<ApiOrder, unknown>[] = [
  {
    accessorKey: "orderNumber",
    header: "Order #",
    cell: ({ row }) => (
      <Link
        href={`/orders/${row.original.id}`}
        onClick={(e) => e.stopPropagation()}
        className="font-mono text-xs font-semibold text-navy hover:text-brand-500 hover:underline"
      >
        {row.original.orderNumber ?? row.original.id}
      </Link>
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
      <span className="text-navy/70">{new Date(row.original.createdAt).toLocaleDateString()}</span>
    ),
  },
];

// ── Tab trigger ───────────────────────────────────────────────────────────────

function TabTrigger({ value, children }: { value: string; children: React.ReactNode }) {
  return (
    <Tabs.Trigger
      value={value}
      className={cn(
        "-mb-px shrink-0 whitespace-nowrap border-b-2 px-4 py-3 text-sm font-medium transition-colors",
        "border-transparent text-navy/70 hover:text-navy",
        "data-[state=active]:border-brand-500 data-[state=active]:text-navy",
      )}
    >
      {children}
    </Tabs.Trigger>
  );
}

// ── Invoice status badge ──────────────────────────────────────────────────────

function renderInvoiceStatus(status: string, dueDate?: string | null): React.ReactNode {
  const today = new Date();
  today.setHours(0, 0, 0, 0);

  if (status === "PAID") return <span className="text-xs font-semibold text-green-600">Paid</span>;
  if (status === "VOID") return <span className="text-xs font-semibold text-gray-400">Void</span>;
  if (status === "WRITTEN_OFF")
    return <span className="text-xs font-semibold text-stone-500">Written Off</span>;
  if (status === "DRAFT") return <span className="text-xs font-semibold text-gray-500">Draft</span>;

  if (dueDate) {
    const due = new Date(dueDate);
    due.setHours(0, 0, 0, 0);
    const diffDays = Math.round((due.getTime() - today.getTime()) / (1000 * 60 * 60 * 24));

    if (status === "OVERDUE" || diffDays < 0) {
      const days = Math.abs(diffDays);
      if (status === "PARTIAL")
        return (
          <span className="text-xs font-semibold text-orange-500">
            Partial · Overdue{days > 0 ? ` by ${days}d` : ""}
          </span>
        );
      return (
        <span className="text-xs font-semibold text-red-600">
          Overdue{days > 0 ? ` by ${days}d` : ""}
        </span>
      );
    }
    if (diffDays === 0) {
      if (status === "PARTIAL")
        return <span className="text-xs font-semibold text-yellow-600">Partial · Due Today</span>;
      return <span className="text-xs font-semibold text-orange-500">Due Today</span>;
    }
    if (status === "PARTIAL")
      return (
        <span className="text-xs font-semibold text-yellow-600">Partial · Due in {diffDays}d</span>
      );
  }

  const colors: Record<string, string> = {
    SENT: "text-blue-600",
    VIEWED: "text-purple-600",
    PARTIAL: "text-yellow-600",
    OVERDUE: "text-red-600",
  };
  const labels: Record<string, string> = {
    SENT: "Sent",
    VIEWED: "Viewed",
    PARTIAL: "Partial",
    OVERDUE: "Overdue",
  };
  return (
    <span className={cn("text-xs font-semibold", colors[status] ?? "text-gray-500")}>
      {labels[status] ?? status}
    </span>
  );
}

// ── Image compression (runs in browser before upload) ─────────────────────────

async function compressImage(file: File, maxPx = 1600, quality = 0.72): Promise<File> {
  return new Promise((resolve) => {
    const img = new Image();
    const url = URL.createObjectURL(file);
    img.onload = () => {
      URL.revokeObjectURL(url);
      let { width, height } = img;
      if (width > maxPx || height > maxPx) {
        if (width > height) {
          height = Math.round((height * maxPx) / width);
          width = maxPx;
        } else {
          width = Math.round((width * maxPx) / height);
          height = maxPx;
        }
      }
      const canvas = document.createElement("canvas");
      canvas.width = width;
      canvas.height = height;
      canvas.getContext("2d")!.drawImage(img, 0, 0, width, height);
      canvas.toBlob(
        (blob) =>
          resolve(
            blob
              ? new File([blob], file.name.replace(/\.[^.]+$/, ".jpg"), { type: "image/jpeg" })
              : file,
          ),
        "image/jpeg",
        quality,
      );
    };
    img.onerror = () => {
      URL.revokeObjectURL(url);
      resolve(file);
    };
    img.src = url;
  });
}

// ── Info row ──────────────────────────────────────────────────────────────────

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
    <div className="flex items-start gap-3 min-w-0">
      <Icon className="mt-0.5 h-4 w-4 shrink-0 text-navy/70" />
      <div className="min-w-0">
        <p className="text-xs text-navy/70">{label}</p>
        <p className="mt-0.5 text-sm font-medium text-navy break-words">{value}</p>
      </div>
    </div>
  );
}

// ── Relative time helper ─────────────────────────────────────────────────────

function timeAgo(dateStr: string): string {
  const now = Date.now();
  const then = new Date(dateStr).getTime();
  const diff = Math.floor((now - then) / 1000);
  const mins = Math.floor(diff / 60);
  const hrs = Math.floor(mins / 60);
  const days = Math.floor(hrs / 24);

  if (diff < 60) return "just now";
  if (mins < 60) return `${mins} minute${mins !== 1 ? "s" : ""} ago`;
  if (hrs < 24) return `${hrs} hour${hrs !== 1 ? "s" : ""} ago`;
  if (days < 30) return `${days} day${days !== 1 ? "s" : ""} ago`;
  return fmtDate(dateStr);
}

// ── Address Form Modal (add + edit) ────────────────────────────────────────

interface AddressFormValues {
  label: string;
  line1: string;
  line2?: string;
  city: string;
  state: string;
  zip: string;
  addressType: string;
}

interface InitialAddress {
  label?: string;
  line1?: string;
  line2?: string;
  city?: string;
  state?: string;
  zip?: string;
  addressType?: string;
  /** Not user-editable here — "Set primary" on the card is the mechanism. Carried
   *  through purely so callers can pass the raw address row without stripping it. */
  isDefault?: boolean;
}

function buildAddressFormValues(initialAddress?: InitialAddress): AddressFormValues {
  return {
    label: initialAddress?.label ?? "",
    line1: initialAddress?.line1 ?? "",
    line2: initialAddress?.line2 ?? "",
    city: initialAddress?.city ?? "",
    state: initialAddress?.state ?? "",
    zip: initialAddress?.zip ?? "",
    addressType: initialAddress?.addressType ?? "BILLING",
  };
}

function AddressFormModal({
  isOpen,
  onClose,
  onSave,
  isSaving,
  mode,
  initialAddress,
}: {
  isOpen: boolean;
  onClose: () => void;
  onSave: (values: AddressFormValues) => void;
  isSaving: boolean;
  mode: "add" | "edit";
  initialAddress?: InitialAddress;
}) {
  const [form, setForm] = React.useState<AddressFormValues>(() =>
    buildAddressFormValues(initialAddress),
  );

  // Re-seed every time the modal opens — covers both a fresh "Add" (blank) and
  // "Edit" (prefilled from the clicked card); one modal now serves both modes.
  React.useEffect(() => {
    if (isOpen) setForm(buildAddressFormValues(initialAddress));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isOpen, initialAddress]);

  const handleChange =
    (field: keyof AddressFormValues) => (e: React.ChangeEvent<HTMLInputElement>) =>
      setForm((prev) => ({ ...prev, [field]: e.target.value }));

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    onSave(form);
  };

  return (
    <Modal
      open={isOpen}
      onClose={onClose}
      title={mode === "add" ? "Add Address" : "Edit Address"}
      footer={
        <>
          <Button variant="secondary" type="button" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" form="address-form" loading={isSaving}>
            {mode === "add" ? "Save Address" : "Save Changes"}
          </Button>
        </>
      }
    >
      <form id="address-form" onSubmit={handleSubmit} noValidate>
        <div className="space-y-3">
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="mb-1 block text-sm font-medium text-navy">Address Type</label>
              <select
                className="w-full rounded-lg border border-surface-border bg-white px-3 py-2 text-sm text-navy focus:outline-none focus:ring-2 focus:ring-brand-500"
                value={form.addressType}
                onChange={(e) => setForm((prev) => ({ ...prev, addressType: e.target.value }))}
              >
                <option value="BILLING">Billing</option>
                <option value="SHIPPING">Shipping</option>
                <option value="DELIVERY">Delivery</option>
              </select>
            </div>
            <Input
              label="Address Label"
              placeholder="Main Office, Warehouse…"
              value={form.label}
              onChange={handleChange("label")}
            />
          </div>
          <AddressAutocomplete
            label="Street"
            placeholder="123 Main St — start typing for suggestions"
            value={form.line1}
            onChange={(v) => setForm((prev) => ({ ...prev, line1: v }))}
            onAddressSelect={({ street, city, state, zip }) =>
              setForm((prev) => ({ ...prev, line1: street, city, state, zip }))
            }
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
              <Input placeholder="TX" value={form.state} onChange={handleChange("state")} />
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

// ── Assign Route Modal ────────────────────────────────────────────────────────

function AssignRouteModal({
  isOpen,
  onClose,
  customerId,
  addresses,
  routesAccess,
}: {
  isOpen: boolean;
  onClose: () => void;
  customerId: string;
  addresses: { id: string; label: string; line1: string; city: string }[];
  routesAccess: boolean;
}) {
  // This modal is always mounted (isOpen is a prop, not a mount condition), and
  // /routes is addon-gated server-side (403 without a dispatch addon), so the
  // query has to stay off until it is actually open on a routes tenant —
  // same double-gate as AssignAgentModal above.
  const { data: routesData, isLoading: routesLoading } = useRoutes(
    { isActive: true, page: 1 },
    { enabled: isOpen && routesAccess },
  );
  const addStop = useAddStopToRoute();
  const [routeId, setRouteId] = React.useState("");
  const [addressId, setAddressId] = React.useState("");
  const [notes, setNotes] = React.useState("");
  const [error, setError] = React.useState<string | null>(null);

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
    if (!routeId) {
      setError("Please select a route.");
      return;
    }
    setError(null);
    addStop.mutate(
      {
        routeId,
        customerId,
        customerAddressId: addressId || undefined,
        notes: notes || undefined,
      },
      {
        onSuccess: () => onClose(),
        onError: (err: any) =>
          setError(err?.response?.data?.message ?? err.message ?? "Failed to assign route."),
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
            <p className="text-sm text-navy/70">Loading routes…</p>
          ) : (
            <div>
              <label className="mb-1 block text-sm font-medium text-navy">Route</label>
              <select
                value={routeId}
                onChange={(e) => setRouteId(e.target.value)}
                className="h-10 w-full rounded border border-surface-border bg-white px-3 text-sm text-navy focus:border-transparent focus:outline-none focus:ring-2 focus:ring-brand-500"
              >
                <option value="">Select a route…</option>
                {routeOptions.map((r: any) => (
                  <option key={r.id} value={r.id}>
                    {r.name}
                  </option>
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
                  <option key={a.id} value={a.id}>
                    {a.label} — {a.line1}, {a.city}
                  </option>
                ))}
              </select>
            </div>
          )}
          <div>
            <label className="mb-1 block text-sm font-medium text-navy">
              Stop Notes <span className="font-normal text-navy/70">(optional)</span>
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

// ── Assign / Reassign Sales Agent Modal ──────────────────────────────────────

function AssignAgentModal({
  isOpen,
  onClose,
  customerId,
  hasSalesAgents,
}: {
  isOpen: boolean;
  onClose: () => void;
  customerId: string;
  hasSalesAgents: boolean;
}) {
  const { toast } = useToast();
  // Double-gated: the button that opens this modal only renders when
  // hasSalesAgents is true, but the query still checks it directly so a stale
  // mount (e.g. the addon toggling off mid-session) never fires the request.
  const { data: agents, isLoading: agentsLoading } = useSalesAgents(
    { status: "ACTIVE" },
    { enabled: isOpen && hasSalesAgents },
  );
  const [agentId, setAgentId] = React.useState("");
  const [effectiveFrom, setEffectiveFrom] = React.useState("");
  const addAssignment = useAddAssignment(agentId);

  React.useEffect(() => {
    if (isOpen) {
      setAgentId("");
      setEffectiveFrom(new Date().toISOString().slice(0, 10));
    }
  }, [isOpen]);

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!agentId) return;
    addAssignment.mutate(
      { customerId, effectiveFrom: effectiveFrom || undefined },
      {
        onSuccess: (data) => {
          toast({
            title: "Agent assigned",
            description: data.recompute
              ? `Recomputed ${data.recompute.invoicesSynced} invoice(s)`
              : undefined,
            variant: "success",
          });
          onClose();
        },
      },
    );
  };

  return (
    <Modal
      open={isOpen}
      onClose={onClose}
      title="Assign Sales Agent"
      description="Choose the agent to attribute for this customer going forward."
      footer={
        <>
          <Button variant="secondary" type="button" onClick={onClose}>
            Cancel
          </Button>
          <Button
            type="submit"
            form="assign-agent-form"
            loading={addAssignment.isPending}
            disabled={!agentId}
          >
            Assign
          </Button>
        </>
      }
    >
      <form id="assign-agent-form" onSubmit={handleSubmit} noValidate>
        <div className="space-y-4">
          {agentsLoading ? (
            <p className="text-sm text-navy/70">Loading agents…</p>
          ) : (
            <div>
              <label className="mb-1 block text-sm font-medium text-navy">Agent</label>
              <select
                value={agentId}
                onChange={(e) => setAgentId(e.target.value)}
                className="h-10 w-full rounded border border-surface-border bg-white px-3 text-sm text-navy focus:border-transparent focus:outline-none focus:ring-2 focus:ring-brand-500"
              >
                <option value="">Select an agent…</option>
                {(agents ?? []).map((a) => (
                  <option key={a.id} value={a.id}>
                    {a.name}
                  </option>
                ))}
              </select>
            </div>
          )}
          <div>
            <label className="mb-1 block text-sm font-medium text-navy">Effective from</label>
            <input
              type="date"
              value={effectiveFrom}
              onChange={(e) => setEffectiveFrom(e.target.value)}
              className="h-10 w-full rounded border border-surface-border bg-white px-3 text-sm text-navy focus:border-transparent focus:outline-none focus:ring-2 focus:ring-brand-500"
            />
            <p className="mt-1 text-xs text-navy/70">
              Backdating recomputes commission from that date.
            </p>
          </div>
        </div>
      </form>
    </Modal>
  );
}

// ── Contact Person Modal ─────────────────────────────────────────────────────

interface ContactFormValues {
  salutation: string;
  firstName: string;
  lastName: string;
  email: string;
  phone: string;
  mobile: string;
  isPrimary: boolean;
}

const EMPTY_CONTACT: ContactFormValues = {
  salutation: "",
  firstName: "",
  lastName: "",
  email: "",
  phone: "",
  mobile: "",
  isPrimary: false,
};

function ContactPersonModal({
  isOpen,
  onClose,
  customerId,
  editingContact,
}: {
  isOpen: boolean;
  onClose: () => void;
  customerId: string;
  editingContact: ContactPerson | null;
}) {
  const addContact = useAddContactPerson();
  const updateContact = useUpdateContactPerson();
  const [form, setForm] = React.useState<ContactFormValues>(EMPTY_CONTACT);

  React.useEffect(() => {
    if (isOpen) {
      if (editingContact) {
        setForm({
          salutation: editingContact.salutation ?? "",
          firstName: editingContact.firstName,
          lastName: editingContact.lastName ?? "",
          email: editingContact.email ?? "",
          phone: editingContact.phone ?? "",
          mobile: editingContact.mobile ?? "",
          isPrimary: editingContact.isPrimary,
        });
      } else {
        setForm(EMPTY_CONTACT);
      }
    }
  }, [isOpen, editingContact]);

  const handleChange =
    (field: keyof ContactFormValues) =>
    (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) => {
      const value = field === "isPrimary" ? (e.target as HTMLInputElement).checked : e.target.value;
      setForm((prev) => ({ ...prev, [field]: value }));
    };

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!form.firstName.trim()) return;
    const payload = {
      customerId,
      salutation: form.salutation || undefined,
      firstName: form.firstName.trim(),
      lastName: form.lastName.trim() || undefined,
      email: form.email.trim() || undefined,
      phone: form.phone.trim() || undefined,
      mobile: form.mobile.trim() || undefined,
      isPrimary: form.isPrimary,
    };
    if (editingContact) {
      updateContact.mutate(
        { ...payload, contactId: editingContact.id },
        { onSuccess: () => onClose() },
      );
    } else {
      addContact.mutate(payload, { onSuccess: () => onClose() });
    }
  };

  const isSaving = addContact.isPending || updateContact.isPending;

  return (
    <Modal
      open={isOpen}
      onClose={onClose}
      title={editingContact ? "Edit Contact Person" : "Add Contact Person"}
      footer={
        <>
          <Button variant="secondary" type="button" onClick={onClose} disabled={isSaving}>
            Cancel
          </Button>
          <Button type="submit" form="contact-person-form" loading={isSaving}>
            {editingContact ? "Save Changes" : "Add Contact"}
          </Button>
        </>
      }
    >
      <form id="contact-person-form" onSubmit={handleSubmit} noValidate>
        <div className="space-y-3">
          <div className="grid grid-cols-3 gap-3">
            <div>
              <label className="mb-1 block text-sm font-medium text-navy">Salutation</label>
              <select
                value={form.salutation}
                onChange={handleChange("salutation")}
                className="h-10 w-full rounded border border-surface-border bg-white px-3 text-sm text-navy focus:border-transparent focus:outline-none focus:ring-2 focus:ring-brand-500"
              >
                <option value="">--</option>
                <option value="Mr.">Mr.</option>
                <option value="Ms.">Ms.</option>
                <option value="Mrs.">Mrs.</option>
                <option value="Dr.">Dr.</option>
              </select>
            </div>
            <Input
              label="First Name *"
              placeholder="John"
              value={form.firstName}
              onChange={handleChange("firstName") as any}
            />
            <Input
              label="Last Name"
              placeholder="Doe"
              value={form.lastName}
              onChange={handleChange("lastName") as any}
            />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <Input
              label="Email"
              type="email"
              placeholder="john@example.com"
              value={form.email}
              onChange={handleChange("email") as any}
            />
            <Input
              label="Phone"
              type="tel"
              placeholder="(555) 123-4567"
              value={form.phone}
              onChange={handleChange("phone") as any}
            />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <Input
              label="Mobile"
              type="tel"
              placeholder="(555) 987-6543"
              value={form.mobile}
              onChange={handleChange("mobile") as any}
            />
            <div className="flex items-end pb-2">
              <label className="flex cursor-pointer items-center gap-2">
                <input
                  type="checkbox"
                  checked={form.isPrimary}
                  onChange={handleChange("isPrimary") as any}
                  className="h-4 w-4 rounded border-surface-border text-brand-500 focus:ring-brand-500"
                />
                <span className="text-sm font-medium text-navy">Primary Contact</span>
              </label>
            </div>
          </div>
        </div>
      </form>
    </Modal>
  );
}

// ── Special Prices Tab ────────────────────────────────────────────────────────

// Same VALID_TERMS list as the API DTO (update-customer.dto.ts) and the invoice
// pages' TERMS_OPTIONS — "" clears the override and falls back to the tenant
// default from Settings → Invoicing.
const CUSTOMER_TERMS_OPTIONS = [
  { value: "", label: "Use tenant default" },
  { value: "Due on Receipt", label: "Due on Receipt" },
  { value: "Net 15", label: "Net 15" },
  { value: "Net 30", label: "Net 30" },
  { value: "Net 45", label: "Net 45" },
  { value: "Net 60", label: "Net 60" },
];

function SpecialPricesTab({ customerId }: { customerId: string }) {
  const { data: customer } = useCustomer(customerId);
  const updateCustomer = useUpdateCustomer();
  const { toast } = useToast();
  const { user } = useAuth();
  // TENANT_ADMIN satisfies OPERATOR server-side (ROLE_SATISFIES in roles.guard.ts), so the
  // @Roles(OPERATOR) customer endpoints accept it — gating the UI on OPERATOR alone hid
  // these controls from a user the API already authorizes.
  const isOperator = user?.role === "OPERATOR" || user?.role === "TENANT_ADMIN";
  const { data: prices, isLoading } = useCustomerPrices(customerId);
  const upsertPrice = useUpsertCustomerPrice();
  const deletePrice = useDeleteCustomerPrice();
  const hasMsrpAddon = useHasAddon(MSRP_ADDON);
  const { data: tierLabels } = useTierLabels();
  // Their price vs cost now — the Price Memory margin column (pos-cost-roles §1).
  const { data: marginConfig } = useMarginConfig();
  const marginFloor = marginConfig?.defaultMarginFloor ?? 0.15;
  const { data: productsData } = useProducts({ isActive: true, limit: 200 });
  const allProducts: any[] = productsData?.data ?? [];

  const [isModalOpen, setIsModalOpen] = React.useState(false);
  const [editingPrice, setEditingPrice] = React.useState<CustomerPrice | null>(null);
  const [deletingPriceId, setDeletingPriceId] = React.useState<string | null>(null);
  const [productSearch, setProductSearch] = React.useState("");
  const [selectedProductId, setSelectedProductId] = React.useState("");
  // null = "no tier override" (row is MSRP-only, or unset while adding) — a
  // CustomerPrice row may now be tier-only, MSRP-only, or both.
  const [selectedTier, setSelectedTier] = React.useState<number | null>(null);
  const [msrpInput, setMsrpInput] = React.useState("");
  const [notes, setNotes] = React.useState("");
  const [productDropdownOpen, setProductDropdownOpen] = React.useState(false);

  const filteredProducts = allProducts.filter(
    (p: any) =>
      p.name.toLowerCase().includes(productSearch.toLowerCase()) ||
      (p.sku ?? "").toLowerCase().includes(productSearch.toLowerCase()),
  );

  // Get selected product for price preview
  const selectedProduct = allProducts.find((p: any) => p.id === selectedProductId);

  // An unset tier column (0/null) inherits the list price at checkout — label it.
  const tierUnset = (product: any, tier: number) =>
    !!product && tier !== 1 && !(Number(product[`priceTier${tier}`]) > 0);

  const openAdd = () => {
    setEditingPrice(null);
    setSelectedProductId("");
    setProductSearch("");
    setSelectedTier(null);
    setMsrpInput("");
    setNotes("");
    setIsModalOpen(true);
  };

  const openEdit = (cp: CustomerPrice) => {
    setEditingPrice(cp);
    setSelectedProductId(cp.productId);
    setProductSearch(cp.product?.name ?? "");
    setSelectedTier(cp.pricingTier ?? null);
    setMsrpInput(cp.msrp != null ? String(cp.msrp) : "");
    setNotes(cp.notes ?? "");
    setIsModalOpen(true);
  };

  const handleSave = () => {
    const msrpTrimmed = msrpInput.trim();
    if (!selectedProductId || (selectedTier == null && !msrpTrimmed)) return;
    upsertPrice.mutate(
      {
        customerId,
        productId: selectedProductId,
        pricingTier: selectedTier,
        // Only ever include msrp when the tenant has the addon — the server
        // 403s any *present* msrp key (even unchanged) for a tenant without
        // flag.msrp, which would otherwise block plain tier-override saves.
        ...(hasMsrpAddon ? { msrp: msrpTrimmed ? parseFloat(msrpTrimmed) : null } : {}),
        notes: notes || undefined,
      },
      {
        onSuccess: () => {
          setIsModalOpen(false);
          setEditingPrice(null);
        },
      },
    );
  };

  const handleDelete = (priceId: string) => {
    deletePrice.mutate({ customerId, priceId }, { onSuccess: () => setDeletingPriceId(null) });
  };

  // Deposit % is free text, so — unlike the sibling <select>s — it must NOT
  // PATCH per keystroke: typing "50" would persist 5 first and the server value
  // would fight the field mid-typing. Hold it locally, re-seed from the server,
  // and commit once on blur/Enter (clamped to the DTO's 0–100).
  const serverDeposit =
    customer?.defaultDepositPercent != null ? Number(customer.defaultDepositPercent) : null;
  const [depositInput, setDepositInput] = React.useState("");
  React.useEffect(() => {
    setDepositInput(serverDeposit != null ? String(serverDeposit) : "");
  }, [serverDeposit]);

  const commitDeposit = () => {
    const raw = depositInput.trim();
    const parsed = raw === "" ? null : Number(raw);
    if (parsed != null && !Number.isFinite(parsed)) {
      setDepositInput(serverDeposit != null ? String(serverDeposit) : "");
      return;
    }
    const next = parsed == null ? null : Math.min(100, Math.max(0, parsed));
    setDepositInput(next != null ? String(next) : "");
    if (next === serverDeposit) return;
    updateCustomer.mutate(
      { id: customerId, defaultDepositPercent: next },
      {
        onError: (err: any) => {
          setDepositInput(serverDeposit != null ? String(serverDeposit) : "");
          toast({
            title: "Couldn't save deposit",
            description: err?.response?.data?.message ?? "",
            variant: "error",
          });
        },
      },
    );
  };

  const priceList: CustomerPrice[] = prices ?? [];

  return (
    <Tabs.Content value="special-prices" className="mt-5 focus:outline-none">
      <Card className="mb-5">
        <div className="flex items-center justify-between gap-4">
          <div>
            <h3 className="text-base font-semibold text-navy">Default Pricing Tier</h3>
            <p className="mt-0.5 text-xs text-navy/70">
              Applies to every product for this customer. Per-product overrides below take
              precedence.
            </p>
          </div>
          {isOperator ? (
            <select
              value={customer?.pricingTier ?? 1}
              onChange={(e) => {
                updateCustomer.mutate({ id: customerId, pricingTier: Number(e.target.value) });
              }}
              className="rounded border border-surface-border bg-white px-2 py-1 text-sm text-navy focus:outline-none focus:ring-2 focus:ring-brand-500"
            >
              {[1, 2, 3, 4, 5].map((t) => (
                <option key={t} value={t}>
                  {tierLabel(tierLabels, t)}
                  {t === 1 ? " (Default)" : ""}
                </option>
              ))}
            </select>
          ) : (
            <p className="text-sm font-semibold text-navy">
              {tierLabel(tierLabels, customer?.pricingTier ?? 1)}
            </p>
          )}
        </div>
        {priceList.length > 0 && (
          <p className="mt-3 text-xs text-navy/70">
            {priceList.length} product{priceList.length === 1 ? " has" : "s have"} a per-product
            override and will keep {priceList.length === 1 ? "its" : "their"} own tier.
          </p>
        )}
      </Card>

      <Card className="mb-5">
        <div className="flex items-center justify-between gap-4">
          <div>
            <h3 className="text-base font-semibold text-navy">Default Payment Terms</h3>
            <p className="mt-0.5 text-xs text-navy/70">
              Seeds the terms and due date on this customer&apos;s new invoices. Wins over the
              tenant default in Settings &rarr; Invoicing.
            </p>
          </div>
          {isOperator ? (
            <select
              value={customer?.defaultPaymentTerms ?? ""}
              onChange={(e) => {
                updateCustomer.mutate({ id: customerId, defaultPaymentTerms: e.target.value });
              }}
              className="rounded border border-surface-border bg-white px-2 py-1 text-sm text-navy focus:outline-none focus:ring-2 focus:ring-brand-500"
            >
              {CUSTOMER_TERMS_OPTIONS.map((opt) => (
                <option key={opt.value} value={opt.value}>
                  {opt.label}
                </option>
              ))}
            </select>
          ) : (
            <p className="text-sm font-semibold text-navy">
              {customer?.defaultPaymentTerms || "Tenant default"}
            </p>
          )}
        </div>

        {/* Deposit — auto-applies to every invoice GENERATED for this customer
            (order flows); computeDepositFields derives the amount at read time,
            untouched here. A manual invoice's own deposit still wins. */}
        <div className="mt-3 flex items-center justify-between gap-4 border-t border-surface-border pt-3">
          <div>
            <p className="text-sm font-medium text-navy">Deposit</p>
            <p className="mt-0.5 text-[11px] leading-snug text-navy/70">
              Deposit due on invoice date; the remainder follows the terms above. Applies to new
              invoices automatically.
            </p>
          </div>
          {isOperator ? (
            <div className="flex items-center gap-1">
              <input
                type="number"
                min={0}
                max={100}
                step={1}
                placeholder="—"
                value={depositInput}
                onChange={(e) => setDepositInput(e.target.value)}
                onBlur={commitDeposit}
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    e.preventDefault();
                    e.currentTarget.blur();
                  }
                }}
                className="w-16 rounded border border-surface-border bg-white px-2 py-1 text-right text-sm text-navy focus:outline-none focus:ring-2 focus:ring-brand-500"
              />
              <span className="text-sm text-navy/70">%</span>
            </div>
          ) : (
            customer?.defaultDepositPercent != null && (
              <p className="text-sm font-semibold text-navy">
                {Number(customer.defaultDepositPercent)}%
              </p>
            )
          )}
        </div>
      </Card>

      <Card>
        <div className="mb-4 flex items-center justify-between">
          <div>
            <h3 className="text-base font-semibold text-navy">Product Overrides</h3>
            <p className="mt-0.5 text-xs text-navy/70">
              {hasMsrpAddon
                ? "Override the pricing tier and/or MSRP for specific products. These override the customer's default tier and the product's default MSRP."
                : "Override the pricing tier for specific products. These override the customer's default tier."}
            </p>
          </div>
          <Button size="sm" leftIcon={<Plus className="h-4 w-4" />} onClick={openAdd}>
            Add Override
          </Button>
        </div>

        {isLoading ? (
          <p className="text-sm text-navy/70">Loading…</p>
        ) : priceList.length === 0 ? (
          <div className="rounded-lg border border-dashed border-surface-border bg-surface-raised py-10 text-center">
            <p className="text-sm text-navy/70">No product overrides set.</p>
            <button className="mt-2 text-sm text-brand-500 hover:underline" onClick={openAdd}>
              Add the first one &rarr;
            </button>
          </div>
        ) : (
          <div className="-mx-6 -mb-6 overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-surface-border bg-gray-50">
                  <th className="px-6 py-3 text-left text-xs font-semibold uppercase tracking-wider text-navy/70">
                    Product
                  </th>
                  <th className="px-4 py-3 text-left text-xs font-semibold uppercase tracking-wider text-navy/70">
                    SKU
                  </th>
                  <th className="px-4 py-3 text-right text-xs font-semibold uppercase tracking-wider text-navy/70">
                    List Price
                  </th>
                  <th className="px-4 py-3 text-center text-xs font-semibold uppercase tracking-wider text-navy/70">
                    Override Tier
                  </th>
                  {hasMsrpAddon && (
                    <th className="px-4 py-3 text-right text-xs font-semibold uppercase tracking-wider text-navy/70">
                      MSRP Override
                    </th>
                  )}
                  <th className="px-4 py-3 text-right text-xs font-semibold uppercase tracking-wider text-navy/70">
                    Tier Price
                  </th>
                  <th className="px-4 py-3 text-right text-xs font-semibold uppercase tracking-wider text-navy/70">
                    Margin
                  </th>
                  <th className="px-4 py-3 text-left text-xs font-semibold uppercase tracking-wider text-navy/70">
                    Notes
                  </th>
                  <th className="px-6 py-3 text-right text-xs font-semibold uppercase tracking-wider text-navy/70">
                    Actions
                  </th>
                </tr>
              </thead>
              <tbody className="divide-y divide-surface-border">
                {priceList.map((cp) => {
                  // No tier override on this row (MSRP-only) \u2192 price at the
                  // customer's default tier, same as an ordinary order would.
                  const effectiveTier = cp.pricingTier ?? customer?.pricingTier ?? 1;
                  const tierPrice = cp.product ? getTierPrice(cp.product, effectiveTier) : 0;
                  return (
                    <tr key={cp.id} className="hover:bg-gray-50/60">
                      <td className="px-6 py-3 text-sm font-medium text-navy">
                        {cp.product?.name ?? "\u2014"}
                      </td>
                      <td className="px-4 py-3 font-mono text-xs text-navy/70">
                        {cp.product?.sku ?? "\u2014"}
                      </td>
                      <td className="px-4 py-3 text-right text-sm text-navy/70">
                        {cp.product?.pricePerUnit != null
                          ? fmt(Number(cp.product.pricePerUnit))
                          : "\u2014"}
                      </td>
                      <td className="px-4 py-3 text-center">
                        {cp.pricingTier != null ? (
                          <Badge variant="neutral">{tierLabel(tierLabels, cp.pricingTier)}</Badge>
                        ) : (
                          <span className="text-xs italic text-navy/50">Default tier</span>
                        )}
                      </td>
                      {hasMsrpAddon && (
                        <td className="px-4 py-3 text-right text-sm text-navy/70">
                          {cp.msrp != null ? (
                            <span className="font-mono tabular-nums text-navy">
                              {fmt(Number(cp.msrp))}
                              <span className="ml-1 text-[10px] text-navy/50">/pc</span>
                            </span>
                          ) : (
                            <span className="text-navy/30">\u2014</span>
                          )}
                        </td>
                      )}
                      <td className="px-4 py-3 text-right text-sm font-semibold text-brand-600">
                        {fmt(tierPrice)}
                        {cp.pricingTier != null && tierUnset(cp.product, cp.pricingTier) && (
                          <span className="ml-1 text-xs font-normal text-navy/50">(list)</span>
                        )}
                      </td>
                      <td className="px-4 py-3 text-right font-mono text-xs">
                        {(() => {
                          const margin = computeMarginFraction(
                            tierPrice,
                            cp.product?.averageCost != null ? Number(cp.product.averageCost) : null,
                            cp.product?.unitsPerBox,
                          );
                          if (margin == null)
                            return <span className="text-navy/30">{"\u2014"}</span>;
                          const cls = classifyMargin(margin, marginFloor);
                          const color =
                            cls === "belowFloor" || cls === "belowCost"
                              ? "text-danger"
                              : cls === "warn"
                                ? "text-amber-600"
                                : "text-success";
                          return <span className={color}>{(margin * 100).toFixed(1)}%</span>;
                        })()}
                      </td>
                      <td className="px-4 py-3 text-sm text-navy/70">{cp.notes ?? "\u2014"}</td>
                      <td className="px-6 py-3 text-right">
                        <div className="flex items-center justify-end gap-1">
                          <button
                            title="Edit override"
                            className={cn(TAP_TARGET, "rounded p-1.5 text-navy/70 transition-colors hover:bg-surface-raised hover:text-navy")}
                            onClick={() => openEdit(cp)}
                          >
                            <Pencil className="h-4 w-4" />
                          </button>
                          <button
                            title="Delete override"
                            className={cn(TAP_TARGET, "rounded p-1.5 text-navy/70 transition-colors hover:bg-danger-bg hover:text-danger")}
                            onClick={() => setDeletingPriceId(cp.id)}
                          >
                            <Trash2 className="h-4 w-4" />
                          </button>
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      {/* Add / Edit modal */}
      <Modal
        open={isModalOpen}
        onClose={() => setIsModalOpen(false)}
        title={editingPrice ? "Edit Price Override" : "Add Price Override"}
        footer={
          <>
            <Button
              variant="secondary"
              onClick={() => setIsModalOpen(false)}
              disabled={upsertPrice.isPending}
            >
              Cancel
            </Button>
            <Button
              loading={upsertPrice.isPending}
              onClick={handleSave}
              disabled={!selectedProductId || (selectedTier == null && !msrpInput.trim())}
            >
              Save
            </Button>
          </>
        }
      >
        <div className="space-y-4">
          <div>
            <label className="mb-1.5 block text-sm font-medium text-navy/80">Product</label>
            <div className="relative">
              <input
                type="text"
                placeholder="Search by name or SKU…"
                value={productSearch}
                onChange={(e) => {
                  setProductSearch(e.target.value);
                  setProductDropdownOpen(true);
                }}
                onFocus={() => setProductDropdownOpen(true)}
                className="h-10 w-full rounded-lg border border-surface-border bg-white px-3 text-sm text-navy placeholder:text-navy/70 focus:border-transparent focus:outline-none focus:ring-2 focus:ring-brand-500"
              />
              {productDropdownOpen && productSearch.length > 0 && filteredProducts.length > 0 && (
                <div className="absolute z-10 mt-1 w-full rounded-lg border border-surface-border bg-white shadow-lg">
                  <ul className="max-h-40 overflow-y-auto">
                    {filteredProducts.slice(0, 20).map((p: any) => (
                      <li key={p.id}>
                        <button
                          className="flex w-full items-center justify-between px-3 py-2 text-left hover:bg-surface-raised"
                          onClick={() => {
                            setSelectedProductId(p.id);
                            setProductSearch(p.name);
                            setProductDropdownOpen(false);
                          }}
                        >
                          <span className="text-sm font-medium text-navy">{p.name}</span>
                          {p.sku && <span className="font-mono text-xs text-navy/70">{p.sku}</span>}
                        </button>
                      </li>
                    ))}
                  </ul>
                </div>
              )}
            </div>
          </div>
          <div>
            <label className="mb-1.5 block text-sm font-medium text-navy/80">
              Pricing Tier (optional)
            </label>
            <select
              value={selectedTier ?? ""}
              onChange={(e) =>
                setSelectedTier(e.target.value === "" ? null : Number(e.target.value))
              }
              className="h-10 w-full rounded-lg border border-surface-border bg-white px-3 text-sm text-navy focus:border-transparent focus:outline-none focus:ring-2 focus:ring-brand-500"
            >
              <option value="">No override (use customer default)</option>
              {[1, 2, 3, 4, 5].map((t) => (
                <option key={t} value={t}>
                  {tierLabel(tierLabels, t)}
                  {t === 1 ? " (List Price)" : ""}
                  {selectedProduct ? ` — ${fmt(getTierPrice(selectedProduct, t))}` : ""}
                  {tierUnset(selectedProduct, t) ? " (list)" : ""}
                </option>
              ))}
            </select>
            {selectedProduct && selectedTier != null && (
              <p className="mt-1 text-xs text-navy/70">
                Price at {tierLabel(tierLabels, selectedTier)}:{" "}
                <span className="font-semibold text-brand-600">
                  {fmt(getTierPrice(selectedProduct, selectedTier))}
                </span>
                {tierUnset(selectedProduct, selectedTier) && (
                  <span className="ml-1 text-navy/50">(list)</span>
                )}
              </p>
            )}
          </div>
          {hasMsrpAddon && (
            <div>
              <label className="mb-1.5 block text-sm font-medium text-navy/80">
                MSRP Override (optional, per piece)
              </label>
              <input
                type="number"
                min="0"
                step="0.01"
                placeholder="Leave blank to use the product's default MSRP"
                value={msrpInput}
                onChange={(e) => setMsrpInput(e.target.value)}
                className="h-10 w-full rounded-lg border border-surface-border bg-white px-3 text-sm text-navy focus:border-transparent focus:outline-none focus:ring-2 focus:ring-brand-500"
              />
            </div>
          )}
          <div>
            <label className="mb-1.5 block text-sm font-medium text-navy/80">
              Notes (optional)
            </label>
            <textarea
              rows={2}
              placeholder="e.g. Contract price, promotional rate…"
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              className="w-full resize-none rounded-lg border border-surface-border bg-white px-3 py-2 text-sm text-navy placeholder:text-navy/30 focus:border-transparent focus:outline-none focus:ring-2 focus:ring-brand-500"
            />
          </div>
        </div>
      </Modal>

      <ConfirmDialog
        open={!!deletingPriceId}
        onClose={() => setDeletingPriceId(null)}
        onConfirm={() => {
          if (deletingPriceId) handleDelete(deletingPriceId);
        }}
        title="Delete price override?"
        description="This will remove the tier and/or MSRP override for this product. The customer will get their default tier price and the product's default MSRP."
        confirmLabel="Yes, delete"
        variant="danger"
        loading={deletePrice.isPending}
      />
    </Tabs.Content>
  );
}

// ── Comments Tab ──────────────────────────────────────────────────────────────

function CommentsTab({ customerId }: { customerId: string }) {
  const { data: comments, isLoading } = useCustomerComments(customerId);
  const addComment = useAddCustomerComment();
  const deleteComment = useDeleteCustomerComment();
  const [newComment, setNewComment] = React.useState("");

  const handleAddComment = (e: React.FormEvent) => {
    e.preventDefault();
    if (!newComment.trim()) return;
    addComment.mutate(
      { customerId, content: newComment.trim() },
      { onSuccess: () => setNewComment("") },
    );
  };

  const commentList: CustomerComment[] = comments ?? [];
  const sortedComments = [...commentList].sort(
    (a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime(),
  );

  return (
    <Tabs.Content value="comments" className="mt-5 focus:outline-none">
      <Card>
        <h3 className="mb-4 text-base font-semibold text-navy">Comments</h3>

        {/* Add comment form */}
        <form onSubmit={handleAddComment} className="mb-6">
          <textarea
            rows={3}
            placeholder="Add a comment…"
            value={newComment}
            onChange={(e) => setNewComment(e.target.value)}
            className="w-full resize-none rounded-lg border border-surface-border bg-white px-3 py-2 text-sm text-navy placeholder:text-navy/70 focus:border-transparent focus:outline-none focus:ring-2 focus:ring-brand-500"
          />
          <div className="mt-2 flex justify-end">
            <Button
              type="submit"
              size="sm"
              loading={addComment.isPending}
              disabled={!newComment.trim()}
              leftIcon={<MessageSquare className="h-4 w-4" />}
            >
              Add Comment
            </Button>
          </div>
        </form>

        {/* Comments list */}
        {isLoading ? (
          <p className="text-sm text-navy/70">Loading comments…</p>
        ) : sortedComments.length === 0 ? (
          <div className="rounded-lg border border-dashed border-surface-border bg-surface-raised py-10 text-center">
            <MessageSquare className="mx-auto h-8 w-8 text-navy/20" />
            <p className="mt-2 text-sm text-navy/70">No comments yet.</p>
          </div>
        ) : (
          <ul className="space-y-4">
            {sortedComments.map((comment) => (
              <li
                key={comment.id}
                className="rounded-lg border border-surface-border bg-surface-raised p-4"
              >
                <div className="flex items-start justify-between gap-3">
                  <div className="flex items-center gap-2">
                    <div className="flex h-7 w-7 items-center justify-center rounded-full bg-brand-100 text-xs font-bold text-brand-700">
                      <User className="h-3.5 w-3.5" />
                    </div>
                    <div>
                      <p className="text-xs font-semibold text-navy">
                        {(comment as any).user?.username ?? "User"}
                      </p>
                      <p className="text-xs text-navy/70">{timeAgo(comment.createdAt)}</p>
                    </div>
                  </div>
                  <button
                    title="Delete comment"
                    className={cn(TAP_TARGET, "rounded p-1 text-navy/30 transition-colors hover:bg-danger-bg hover:text-danger")}
                    onClick={() =>
                      deleteComment.mutate({
                        customerId,
                        commentId: comment.id,
                      })
                    }
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                  </button>
                </div>
                <p className="mt-2 whitespace-pre-wrap text-sm text-navy/80">{comment.content}</p>
              </li>
            ))}
          </ul>
        )}
      </Card>
    </Tabs.Content>
  );
}

// ── Documents Tab ─────────────────────────────────────────────────────────────

function DocumentThumb({
  doc,
  onView,
}: {
  doc: { url: string; mimeType: string; originalName: string };
  onView: () => void;
}) {
  const [imgFailed, setImgFailed] = React.useState(false);
  const isImage = doc.mimeType.startsWith("image/");
  const isPdf = doc.mimeType === "application/pdf";

  const base =
    "flex h-40 w-full items-center justify-center bg-gradient-to-br from-surface-raised to-white";

  const body =
    isImage && !imgFailed ? (
      <img
        src={doc.url}
        alt={doc.originalName}
        className="h-40 w-full object-cover"
        onError={() => setImgFailed(true)}
        loading="lazy"
      />
    ) : isImage ? (
      <div className={cn(base, "flex-col gap-1.5 text-navy/70")}>
        <Camera className="h-10 w-10" />
        <span className="text-[10px] font-medium uppercase tracking-wide">Image preview</span>
      </div>
    ) : isPdf ? (
      <div
        className={cn(base, "flex-col gap-1.5 bg-gradient-to-br from-red-50 to-white text-red-600")}
      >
        <FileText className="h-10 w-10" />
        <span className="rounded bg-red-600 px-1.5 py-0.5 text-[10px] font-bold uppercase tracking-wide text-white">
          PDF
        </span>
      </div>
    ) : (
      <div className={cn(base, "flex-col gap-1.5 text-navy/70")}>
        <FileText className="h-10 w-10" />
        <span className="text-[10px] font-medium uppercase tracking-wide">
          {(doc.originalName.split(".").pop() || "File").slice(0, 6)}
        </span>
      </div>
    );

  return (
    <button
      onClick={onView}
      className="block w-full cursor-pointer focus:outline-none focus:ring-2 focus:ring-brand-500 focus:ring-inset"
      title={`View ${doc.originalName}`}
    >
      {body}
    </button>
  );
}

function DocumentViewer({ doc, onClose }: { doc: CustomerDocument | null; onClose: () => void }) {
  const [zoomed, setZoomed] = React.useState(false);
  React.useEffect(() => {
    setZoomed(false);
  }, [doc]);
  if (!doc) return null;
  const isImage = doc.mimeType.startsWith("image/");
  const isPdf = doc.mimeType === "application/pdf";
  return (
    <Modal
      open={!!doc}
      onClose={onClose}
      title={doc.originalName}
      description={doc.docType}
      className="max-w-4xl overflow-hidden p-0"
    >
      {/* Action bar */}
      <div className="flex items-center gap-1 border-b border-surface-border px-4 py-2">
        {isImage && (
          <button
            onClick={() => setZoomed((z) => !z)}
            className="flex items-center gap-1 rounded px-2 py-1 text-xs text-navy/70 transition-colors hover:bg-surface-raised hover:text-navy"
          >
            <ZoomIn className="h-3.5 w-3.5" />
            {zoomed ? "Fit" : "Zoom"}
          </button>
        )}
        <a
          href={doc.url}
          download={doc.originalName}
          target="_blank"
          rel="noopener noreferrer"
          className="ml-auto flex items-center gap-1 rounded px-2 py-1 text-xs text-navy/70 transition-colors hover:bg-surface-raised hover:text-navy"
        >
          <Download className="h-3.5 w-3.5" />
          Download
        </a>
      </div>
      {/* Content */}
      {isImage ? (
        <div
          className={cn(
            "flex items-center justify-center overflow-auto bg-surface-raised",
            zoomed ? "h-[75vh]" : "h-[60vh]",
          )}
        >
          <img
            src={doc.url}
            alt={doc.originalName}
            className={cn(
              "object-contain transition-all",
              zoomed ? "h-full max-w-none" : "max-h-full max-w-full",
            )}
          />
        </div>
      ) : isPdf ? (
        <div className="h-[75vh]">
          <iframe src={doc.url} className="h-full w-full border-0" title={doc.originalName} />
        </div>
      ) : (
        <div className="flex h-48 flex-col items-center justify-center gap-2 text-navy/70">
          <FileText className="h-12 w-12" />
          <p className="text-sm">Preview not available</p>
        </div>
      )}
    </Modal>
  );
}

/**
 * Fabricate a CustomerDocument-shaped record from a tax-exempt doc {key,url} pair so the
 * tax-exempt lightbox can reuse DocumentViewer (image + PDF aware) instead of the old
 * image-only <img> overlay. The tax-documents endpoint only returns {key, url} — no mimeType —
 * so PDF-ness is inferred from the key's extension (uploadTaxDocument keeps the original
 * extension via `compressed.ext`).
 */
function taxDocToViewerDoc(doc: { key: string; url: string }): CustomerDocument {
  const isPdf = doc.key.toLowerCase().endsWith(".pdf");
  return {
    id: doc.key,
    docType: "Tax Exempt Certificate",
    originalName: doc.key.split("/").pop() || "Tax exempt document",
    mimeType: isPdf ? "application/pdf" : "image/jpeg",
    sizeBytes: 0,
    createdAt: new Date().toISOString(),
    url: doc.url,
  };
}

const DOC_TYPES = [
  "Tax Exempt Certificate",
  "Resale Certificate",
  "W-9",
  "Signed Agreement",
  "Other",
];

function DocumentsTab({ customerId }: { customerId: string }) {
  const { toast } = useToast();
  const { data: docs, isLoading } = useCustomerDocuments(customerId);
  const upload = useUploadCustomerDocuments(customerId);
  const del = useDeleteCustomerDocument(customerId);
  const [uploadOpen, setUploadOpen] = React.useState(false);
  const [files, setFiles] = React.useState<File[]>([]);
  const [docType, setDocType] = React.useState(DOC_TYPES[0]);
  const [viewing, setViewing] = React.useState<CustomerDocument | null>(null);

  const handleUpload = async () => {
    if (files.length === 0) return;
    try {
      await upload.mutateAsync({ files, docType });
      toast({
        title: `Uploaded ${files.length} document${files.length !== 1 ? "s" : ""}`,
        variant: "success",
      });
      setFiles([]);
      setUploadOpen(false);
    } catch (e: any) {
      toast({
        title: "Upload failed",
        description: e?.response?.data?.message ?? "",
        variant: "error",
      });
    }
  };

  const handleDelete = async (id: string) => {
    try {
      await del.mutateAsync(id);
      toast({ title: "Document deleted", variant: "success" });
    } catch {
      toast({ title: "Delete failed", variant: "error" });
    }
  };

  const fmtSize = (b: number) =>
    b < 1024
      ? `${b} B`
      : b < 1_048_576
        ? `${Math.round(b / 1024)} KB`
        : `${(b / 1_048_576).toFixed(1)} MB`;

  return (
    <Tabs.Content value="documents" className="mt-5 focus:outline-none">
      <Card>
        <div className="mb-4 flex items-center justify-between">
          <h3 className="text-base font-semibold text-navy">Documents</h3>
          <Button
            size="sm"
            leftIcon={<Upload className="h-4 w-4" />}
            onClick={() => setUploadOpen(true)}
          >
            Upload Document
          </Button>
        </div>

        {isLoading ? (
          <p className="text-sm text-navy/70">Loading…</p>
        ) : !docs || docs.length === 0 ? (
          <div className="rounded-lg border border-dashed border-surface-border bg-surface-raised py-10 text-center">
            <FileText className="mx-auto h-8 w-8 text-navy/20" />
            <p className="mt-2 text-sm text-navy/70">
              No documents uploaded. Use the Upload button to add tax forms, signed agreements, or
              other files.
            </p>
          </div>
        ) : (
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {docs.map((d) => (
              <div
                key={d.id}
                className="group relative overflow-hidden rounded-lg border border-surface-border bg-white"
              >
                <DocumentThumb doc={d} onView={() => setViewing(d)} />
                <div className="p-3">
                  <p className="text-xs font-medium uppercase tracking-wide text-brand-600">
                    {d.docType}
                  </p>
                  <p className="mt-0.5 truncate text-sm text-navy" title={d.originalName}>
                    {d.originalName}
                  </p>
                  <p className="mt-0.5 text-xs text-navy/70">
                    {fmtSize(d.sizeBytes)} · {fmtDate(d.createdAt)}
                  </p>
                </div>
                <button
                  onClick={() => handleDelete(d.id)}
                  title="Delete document"
                  className={cn(
                    TAP_TARGET,
                    "touch-reveal absolute right-2 top-2 rounded-full bg-white/90 text-navy/70 opacity-0 shadow transition hover:text-danger group-hover:opacity-100",
                  )}
                >
                  <Trash2 className="h-3.5 w-3.5" />
                </button>
              </div>
            ))}
          </div>
        )}
      </Card>

      <Modal
        open={uploadOpen}
        onClose={() => {
          setUploadOpen(false);
          setFiles([]);
        }}
        title="Upload Document"
        footer={
          <>
            <Button
              variant="secondary"
              onClick={() => {
                setUploadOpen(false);
                setFiles([]);
              }}
            >
              Cancel
            </Button>
            <Button loading={upload.isPending} disabled={files.length === 0} onClick={handleUpload}>
              Upload {files.length > 0 ? `(${files.length})` : ""}
            </Button>
          </>
        }
      >
        <div className="space-y-4">
          <div>
            <label className="mb-1 block text-xs font-medium uppercase tracking-wide text-navy/70">
              Document Type
            </label>
            <select
              value={docType}
              onChange={(e) => setDocType(e.target.value)}
              className="w-full rounded-lg border border-surface-border px-3 py-2 text-sm text-navy focus:outline-none focus:ring-2 focus:ring-brand-500"
            >
              {DOC_TYPES.map((t) => (
                <option key={t} value={t}>
                  {t}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label className="mb-1 block text-xs font-medium uppercase tracking-wide text-navy/70">
              Files (images or PDF)
            </label>
            <input
              type="file"
              multiple
              accept="image/*,application/pdf"
              onChange={(e) => setFiles(Array.from(e.target.files ?? []))}
              className="block w-full text-sm text-navy file:mr-3 file:rounded-lg file:border-0 file:bg-brand-500 file:px-3 file:py-1.5 file:text-sm file:font-medium file:text-white hover:file:bg-brand-600"
            />
            {files.length > 0 && (
              <ul className="mt-2 space-y-1">
                {files.map((f, i) => (
                  <li key={i} className="truncate text-xs text-navy/70">
                    {f.name} ({fmtSize(f.size)})
                  </li>
                ))}
              </ul>
            )}
          </div>
        </div>
      </Modal>

      <DocumentViewer doc={viewing} onClose={() => setViewing(null)} />
    </Tabs.Content>
  );
}

// ── Page ──────────────────────────────────────────────────────────────────────

const STATUS_CYCLE = ["ACTIVE", "INACTIVE", "SUSPENDED"] as const;
type CustomerStatus = (typeof STATUS_CYCLE)[number];

/** "Outstanding" spans four statuses, but ListInvoicesDto validates `status` as a
 *  single enum value (a comma-list 400s) — so it's filtered client-side. */
const OUTSTANDING_STATUSES = ["SENT", "VIEWED", "PARTIAL", "OVERDUE"];

function CustomerDetailPageInner({ id }: { id: string }) {
  const { setTitle } = usePageTitle();
  const router = useRouter();
  const { user } = useAuth();
  // See the note in SpecialPricesTab: TENANT_ADMIN satisfies OPERATOR server-side.
  const isOperator = user?.role === "OPERATOR" || user?.role === "TENANT_ADMIN";
  const { toast } = useToast();
  const hasSalesAgents = useHasAddon(SALES_AGENTS_ADDON);
  // Assigning a customer to a standing route is a recurring-routes surface —
  // /routes 403s without a dispatch addon, so hide the entry point and keep the
  // modal's query off (this page is not behind the shell's RouteGuard).
  const { enabled: routesAccess } = useRoutesAccess();
  const currentAgent = useCustomerCurrentAgent(id, { enabled: hasSalesAgents });
  const [agentModalOpen, setAgentModalOpen] = React.useState(false);
  const closeAssignment = useCloseAssignment();

  const handleEndAttribution = () => {
    if (!confirm("Remove this customer's sales agent attribution?")) return;
    closeAssignment.mutate(
      { customerId: id },
      {
        onSuccess: (data) => {
          toast({
            title: "Agent removed",
            description: data.recompute
              ? `Recomputed ${data.recompute.invoicesSynced} invoice(s)`
              : undefined,
            variant: "success",
          });
        },
      },
    );
  };

  const { data: customer, isLoading } = useCustomer(id);
  const { data: tierLabels } = useTierLabels();
  const { data: ordersResult, isError: ordersError } = useCustomerOrders<ApiOrder>(id);
  const { data: customerRoutes } = useCustomerRoutes(id);
  const { data: orderTemplates } = useOrderTemplates(id);
  const updateStatus = useUpdateCustomerStatus();
  const updateCustomer = useUpdateCustomer();
  const addAddress = useAddCustomerAddress();
  const updateAddress = useUpdateCustomerAddress();
  const deleteAddress = useDeleteCustomerAddress();
  const updateTemplate = useUpdateOrderTemplate();
  const deleteTemplate = useDeleteOrderTemplate();
  const generateOrder = useGenerateTemplateOrder();

  const { data: statement } = useCustomerStatement(id);
  const { data: advancePayments } = useCustomerAdvancePayments(id);
  const createAdvance = useCreateAdvancePayment();
  const queryClient = useQueryClient();

  const [invoiceFilter, setInvoiceFilter] = React.useState<"all" | "outstanding" | "paid" | "void">(
    "all",
  );
  const { data: invoicesData, isLoading: invoicesLoading } = useInvoices({
    customerId: id,
    status: invoiceFilter === "paid" ? "PAID" : invoiceFilter === "void" ? "VOID" : undefined,
    limit: 50,
  });
  const customerInvoices = React.useMemo(() => {
    const rows = invoicesData?.data ?? [];
    return invoiceFilter === "outstanding"
      ? rows.filter((inv) => OUTSTANDING_STATUSES.includes(inv.status))
      : rows;
  }, [invoicesData, invoiceFilter]);

  // New hooks
  const { data: contactPersons, isLoading: contactsLoading } = useContactPersons(id);
  const deleteContact = useDeleteContactPerson();
  const { data: allTags } = useCustomerTags();
  const assignTag = useAssignCustomerTag();
  const removeTag = useRemoveCustomerTag();
  const { data: chartData } = useCustomerIncomeChart(id);

  // Delete customer — reversible soft-delete with 8-second Undo (ux-standards).
  const softDeleteCustomer = useSoftDeleteCustomer();
  const restoreCustomer = useRestoreCustomer();
  const runUndoable = useUndo();
  const [isDeleteOpen, setIsDeleteOpen] = React.useState(false);

  const handleDeleteCustomer = () => {
    const name = customer?.businessName ?? "Customer";
    // Capture the pre-delete status so Undo restores exactly (not force-ACTIVE).
    const priorStatus = currentStatus;
    setIsDeleteOpen(false);
    router.push("/customers");
    runUndoable({
      message: "Customer removed",
      description: name,
      perform: () => softDeleteCustomer.mutateAsync(id).then(() => undefined),
      undo: () => restoreCustomer.mutateAsync({ id, status: priorStatus }).then(() => undefined),
    });
  };

  // Buyer Portal management
  const { data: portalStatus, isLoading: portalLoading } = usePortalStatus(id);
  // The shared PortalStatus type (apps/web/lib/api/customers.ts) doesn't declare
  // buyerName/buyerEmail — out of this package's file scope to touch — but the API's
  // getPortalStatus now returns them (flat, not nested under buyerAccount) while a
  // request is PENDING_SELLER_APPROVAL, so the card can say WHO is asking. Read them
  // via a local, additive cast instead of widening the shared interface.
  const pendingRequester = portalStatus as
    (PortalStatus & { buyerName?: string | null; buyerEmail?: string | null }) | undefined;
  const sendInvite = useSendPortalInvite();
  const resendInvite = useResendPortalInvite();
  const disconnectPortal = useDisconnectPortal();
  // Both hooks invalidate portal-status AND the bell's pending-approvals list, so
  // approving or declining here makes the "Action needed" row disappear immediately.
  const approvePortal = useApprovePortalRequest();
  const declinePortal = useDeclinePortalRequest();
  const [portalInviteEmail, setPortalInviteEmail] = React.useState("");
  const [portalMsg, setPortalMsg] = React.useState<string | null>(null);
  const [declineConfirmOpen, setDeclineConfirmOpen] = React.useState(false);

  // Tax-exempt documents
  const { data: taxDocs = [] } = useCustomerTaxDocuments(id);
  const uploadTaxDocs = useUploadCustomerTaxDocuments(id);
  const deleteTaxDoc = useDeleteCustomerTaxDocument(id);
  // Routed through the same DocumentViewer used by the Documents tab (not a plain <img>
  // lightbox) so a PDF tax-exempt document is viewable, not just images.
  const [taxDocLightbox, setTaxDocLightbox] = React.useState<CustomerDocument | null>(null);
  const taxDocInputRef = React.useRef<HTMLInputElement>(null);

  const allOrders: ApiOrder[] = ordersResult?.data ?? [];
  // H1: `allOrders` is a capped page (the endpoint's take:50 display budget),
  // so every COUNT the UI shows reads the server's own `meta.total` over the
  // customer's whole order history — a customer with 120 orders must not read
  // "Orders (50)". The list below stays the display budget it always was.
  const orderCount = ordersResult?.meta?.total ?? 0;
  const addresses = customer?.addresses ?? [];
  const currentStatus: CustomerStatus = (customer?.user?.status as CustomerStatus) ?? "ACTIVE";
  // REG-B170: the detail page previously looked fully live for a removed (soft-deleted)
  // customer — no banner, edit/status/remove controls all still rendered. Reads keep working
  // (restore symmetry); only the banner + Restore surface and hiding those controls are new —
  // the actual safety net is the server refusing update/changeStatus for a removed customer.
  const isRemoved = !!customer?.deletedAt;

  React.useEffect(() => {
    setTitle(customer?.businessName ?? "Customer");
  }, [setTitle, customer?.businessName]);

  const [isEditOpen, setIsEditOpen] = React.useState(false);
  const [isAddAddressOpen, setIsAddAddressOpen] = React.useState(false);
  // Non-null = the address card being edited (edit mode of AddressFormModal);
  // null = the modal (when isAddAddressOpen) is in "add" mode.
  const [editingAddress, setEditingAddress] = React.useState<any | null>(null);
  // Inline two-tap delete confirm, keyed by address id (the suppliers-page idiom).
  const [deleteAddressConfirmId, setDeleteAddressConfirmId] = React.useState<string | null>(null);
  const [isAssignRouteOpen, setIsAssignRouteOpen] = React.useState(false);
  const [orderStatusFilter, setOrderStatusFilter] = React.useState("");
  const [pendingStatus, setPendingStatus] = React.useState<CustomerStatus | null>(null);

  // Controlled Tabs so the Edit Customer modal's "Addresses tab" link (the honest
  // replacement for the modal's old silent-discard address section) can switch to
  // it — including a query-string entry (`?tab=addresses`) so the SAME link works
  // when the modal was opened from the customers LIST page and lands here fresh.
  const searchParams = useSearchParams();
  const [activeTab, setActiveTab] = React.useState("profile");
  React.useEffect(() => {
    const tab = searchParams.get("tab");
    if (tab) setActiveTab(tab);
  }, [searchParams]);

  // B512 (C2 390px audit): the tab strip scrolls horizontally on mobile instead
  // of wrapping, so a deep link (`?tab=documents`) landing on a tab past the
  // fold must scroll it into view — otherwise the strip looks like it starts on
  // a random tab with no indication anything is off-screen to the left.
  const tabsListRef = React.useRef<HTMLDivElement>(null);
  React.useEffect(() => {
    const activeEl = tabsListRef.current?.querySelector<HTMLElement>('[data-state="active"]');
    activeEl?.scrollIntoView({ inline: "center", block: "nearest" });
  }, [activeTab]);

  // Delivery time window
  const [windowStart, setWindowStart] = React.useState(customer?.deliveryWindowStart ?? "");
  const [windowEnd, setWindowEnd] = React.useState(customer?.deliveryWindowEnd ?? "");
  const [anyTime, setAnyTime] = React.useState(
    !customer?.deliveryWindowStart && !customer?.deliveryWindowEnd,
  );

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
      updateCustomer.mutate({
        id: id,
        deliveryWindowStart: "",
        deliveryWindowEnd: "",
      });
    }
  };

  // Tax-document upload with client-side compression
  const handleTaxDocFiles = React.useCallback(
    async (files: FileList | null) => {
      if (!files || files.length === 0) return;
      const compressed = await Promise.all(Array.from(files).map((f) => compressImage(f)));
      uploadTaxDocs.mutate(compressed);
    },
    [uploadTaxDocs],
  );

  // Customer-level payment allocation (lump sum across open invoices)
  const [isRecordPaymentOpen, setIsRecordPaymentOpen] = React.useState(false);

  // Advance payment
  const [isAdvanceOpen, setIsAdvanceOpen] = React.useState(false);
  const [advanceForm, setAdvanceForm] = React.useState<{
    method: SelectablePaymentMethod;
    amount: string;
    reference: string;
    notes: string;
  }>({
    method: "ACH",
    amount: "",
    reference: "",
    notes: "",
  });

  // Standing orders
  const [isStandingOrderOpen, setIsStandingOrderOpen] = React.useState(false);
  const [editingTemplate, setEditingTemplate] = React.useState<OrderTemplate | null>(null);
  const [deletingTemplateId, setDeletingTemplateId] = React.useState<string | null>(null);

  // Contact person modal
  const [isContactModalOpen, setIsContactModalOpen] = React.useState(false);
  const [editingContact, setEditingContact] = React.useState<ContactPerson | null>(null);
  const [deletingContactId, setDeletingContactId] = React.useState<string | null>(null);

  // Tag dropdown
  const [tagDropdownOpen, setTagDropdownOpen] = React.useState(false);
  const tagDropdownRef = React.useRef<HTMLDivElement>(null);

  React.useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (tagDropdownRef.current && !tagDropdownRef.current.contains(e.target as Node)) {
        setTagDropdownOpen(false);
      }
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, []);

  const templates = orderTemplates ?? [];

  const handleTimeWindowBlur = () => {
    updateCustomer.mutate({
      id: id,
      deliveryWindowStart: windowStart || undefined,
      deliveryWindowEnd: windowEnd || undefined,
    });
  };

  if (isLoading) {
    return <div className="p-12 text-center text-navy/70">Loading...</div>;
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
      setPendingStatus(s);
    } else {
      updateStatus.mutate({ id: id, status: s });
    }
  };

  const confirmStatusChange = () => {
    if (!pendingStatus) return;
    updateStatus.mutate(
      { id: id, status: pendingStatus },
      { onSuccess: () => setPendingStatus(null) },
    );
  };

  const handleSaveAddress = (values: AddressFormValues) => {
    if (editingAddress) {
      updateAddress.mutate(
        { id: id, addrId: editingAddress.id, ...values },
        {
          onSuccess: () => {
            toast({ title: "Address updated", variant: "success" });
            // Close BEFORE clearing editingAddress — the modal is open on
            // isAddAddressOpen and derives its mode from editingAddress, so
            // leaving it open would flip it into a blank "Add Address" form.
            setIsAddAddressOpen(false);
            setEditingAddress(null);
          },
          onError: (err: any) =>
            toast({
              title: "Update failed",
              description: err?.response?.data?.message ?? "",
              variant: "error",
            }),
        },
      );
    } else {
      addAddress.mutate(
        { id: id, ...values },
        {
          onSuccess: () => {
            toast({ title: "Address added", variant: "success" });
            setIsAddAddressOpen(false);
          },
          onError: (err: any) =>
            toast({
              title: "Couldn't add address",
              description: err?.response?.data?.message ?? "",
              variant: "error",
            }),
        },
      );
    }
  };

  const handleSetPrimaryAddress = (addrId: string) => {
    updateAddress.mutate(
      { id: id, addrId, isDefault: true },
      {
        onError: (err: any) =>
          toast({
            title: "Couldn't set primary",
            description: err?.response?.data?.message ?? "",
            variant: "error",
          }),
      },
    );
  };

  const handleDeleteAddress = (addrId: string) => {
    setDeleteAddressConfirmId(null);
    deleteAddress.mutate(
      { id: id, addrId },
      {
        onSuccess: () => toast({ title: "Address deleted", variant: "success" }),
        // The server 409s (ConflictException) with a specific reason when a route
        // stop still references this address — surface it, don't swallow it.
        onError: (err: any) =>
          toast({
            title: "Couldn't delete address",
            description: err?.response?.data?.message ?? "This address couldn't be deleted.",
            variant: "error",
          }),
      },
    );
  };

  // Tags
  const assignedTags: CustomerTag[] = customer?.tagAssignments?.map((ta: any) => ta.tag) ?? [];
  const assignedTagIds = new Set(assignedTags.map((t) => t.id));
  const availableTags = (allTags ?? []).filter((t) => !assignedTagIds.has(t.id));

  // Contact persons
  const contacts: ContactPerson[] = contactPersons ?? [];

  // Credit limit usage
  const creditLimit = customer?.creditLimit != null ? Number(customer.creditLimit) : null;
  const receivables = customer?.receivables != null ? Number(customer.receivables) : 0;
  const creditUsagePercent =
    creditLimit && creditLimit > 0 ? Math.min(100, (receivables / creditLimit) * 100) : 0;

  return (
    <div className="space-y-5 p-6">
      {/* Back + header row */}
      <div className="flex items-start gap-4">
        <Link
          href="/customers"
          className="mt-0.5 flex items-center gap-1.5 text-sm text-navy/70 transition-colors hover:text-navy"
        >
          <ArrowLeft className="h-4 w-4" />
          Customers
        </Link>
      </div>

      {/* REG-B170: removed customers previously looked fully live here — no indication, and
          restore was reachable only within the 8-second Undo toast right after removal. */}
      {isRemoved && (
        <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-danger/30 bg-danger-bg px-4 py-3">
          <p className="text-sm font-medium text-danger">
            This customer has been removed. Restore it to edit or change its status.
          </p>
          <Button
            variant="secondary"
            size="sm"
            leftIcon={<UserCheck className="h-3.5 w-3.5" />}
            onClick={() => restoreCustomer.mutate({ id })}
            loading={restoreCustomer.isPending}
          >
            Restore
          </Button>
        </div>
      )}

      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="flex items-center gap-3.5">
          <Avatar name={customer.businessName} size="lg" className="h-[42px] w-[42px] text-sm" />
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2.5">
              <h1 className="text-2xl font-bold text-navy">{customer.businessName}</h1>
              {isRemoved ? (
                <Badge variant="danger" label="Removed" />
              ) : (
                <Badge status={currentStatus} />
              )}
              <Badge
                variant="info"
                label={`${tierLabel(tierLabels, customer.pricingTier ?? 1)} pricing`}
              />
              <span
                className={cn(
                  "inline-flex items-center gap-1 rounded-full px-2.5 py-0.5 text-xs font-semibold",
                  customer.customerType === "individual"
                    ? "bg-purple-100 text-purple-700"
                    : "bg-blue-100 text-blue-700",
                )}
              >
                {customer.customerType === "individual" ? (
                  <>
                    <User className="h-3 w-3" /> Individual
                  </>
                ) : (
                  <>
                    <Building2 className="h-3 w-3" /> Business
                  </>
                )}
              </span>
            </div>
            <p className="mt-1 text-sm text-navy/70">
              {[
                customer.contactName,
                `Customer since ${fmtDate(customer.createdAt)}`,
                (customerRoutes ?? [])[0]?.name,
              ]
                .filter(Boolean)
                .join(" · ")}
            </p>
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-2.5">
          {!isRemoved && (
            <Button
              variant="secondary"
              size="sm"
              leftIcon={<Pencil className="h-3.5 w-3.5" />}
              onClick={() => setIsEditOpen(true)}
            >
              Edit
            </Button>
          )}
          <Button
            variant="secondary"
            size="sm"
            leftIcon={<FileText className="h-3.5 w-3.5" />}
            href={`/invoices/new?customerId=${id}`}
          >
            New Invoice
          </Button>
        </div>
      </div>

      {/* Tabs */}
      <Tabs.Root value={activeTab} onValueChange={setActiveTab} className="flex flex-col">
        <Tabs.List
          ref={tabsListRef}
          className="flex overflow-x-auto border-b border-surface-border"
        >
          <TabTrigger value="profile">Profile</TabTrigger>
          <TabTrigger value="orders">Orders{orderCount > 0 ? ` (${orderCount})` : ""}</TabTrigger>
          <TabTrigger value="addresses">Addresses ({addresses.length})</TabTrigger>
          <TabTrigger value="standing-orders">
            Standing Orders
            {templates.length > 0 ? ` (${templates.length})` : ""}
          </TabTrigger>
          <TabTrigger value="invoices">
            Invoices
            {customerInvoices.length > 0 ? ` (${customerInvoices.length})` : ""}
          </TabTrigger>
          <TabTrigger value="billing">Billing</TabTrigger>
          <TabTrigger value="special-prices">Special Prices</TabTrigger>
          <TabTrigger value="comments">
            <span className="flex items-center gap-1.5">
              <MessageSquare className="h-3.5 w-3.5" />
              Comments
            </span>
          </TabTrigger>
          <TabTrigger value="documents">
            <span className="flex items-center gap-1.5">
              <FileText className="h-3.5 w-3.5" />
              Documents
            </span>
          </TabTrigger>
          <TabTrigger value="authorizations">
            <span className="flex items-center gap-1.5">
              <ShieldCheck className="h-3.5 w-3.5" />
              Licenses
            </span>
          </TabTrigger>
        </Tabs.List>

        {/* ── Profile tab ────────────────────────────────────────── */}
        <Tabs.Content value="profile" className="mt-5 focus:outline-none">
          <div className="space-y-5">
            {/* Stat cards — key numbers foregrounded, all from already-loaded data */}
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
              <StatCard
                label="Orders"
                value={ordersError ? "—" : orderCount}
                icon={<FileText className="h-5 w-5" />}
              />
              <StatCard
                label="Open Balance"
                value={fmt(statement?.outstandingAmount ?? 0)}
                icon={<TrendingDown className="h-5 w-5" />}
                className={(statement?.outstandingAmount ?? 0) > 0 ? "border-danger/40" : undefined}
              />
              <StatCard
                label="Advance Balance"
                value={fmt(statement?.advanceBalance ?? 0)}
                icon={<DollarSign className="h-5 w-5" />}
              />
            </div>

            {/* New fields & tags row */}
            <div className="grid grid-cols-1 gap-5 lg:grid-cols-3">
              <div className="lg:col-span-2">
                <Card title="Customer Details">
                  <div className="grid grid-cols-2 gap-x-6 gap-y-4 sm:grid-cols-3">
                    {customer.displayName && (
                      <InfoRow icon={User} label="Display Name" value={customer.displayName} />
                    )}
                    {customer.email && <InfoRow icon={Mail} label="Email" value={customer.email} />}
                    {customer.mobile && (
                      <InfoRow icon={Phone} label="Mobile" value={customer.mobile} />
                    )}
                    <InfoRow icon={Phone} label="Phone" value={customer.phone ?? "\u2014"} />
                    <InfoRow
                      icon={FileText}
                      label="Customer Since"
                      value={fmtDate(customer.createdAt)}
                    />
                    {customer.currency && (
                      <div className="flex items-start gap-3">
                        <DollarSign className="mt-0.5 h-4 w-4 shrink-0 text-navy/70" />
                        <div>
                          <p className="text-xs text-navy/70">Currency</p>
                          <span className="mt-0.5 inline-flex items-center rounded-full bg-surface-raised px-2 py-0.5 text-xs font-semibold text-navy">
                            {customer.currency}
                          </span>
                        </div>
                      </div>
                    )}
                    {customer.taxId && (
                      <div className="flex items-start gap-3">
                        <FileText className="mt-0.5 h-4 w-4 shrink-0 text-navy/70" />
                        <div>
                          <p className="text-xs text-navy/70">Tax ID</p>
                          <div className="mt-0.5 flex items-center gap-2">
                            <p className="text-sm font-medium text-navy">{customer.taxId}</p>
                            {customer.isTaxExempt && (
                              <span className="rounded-full bg-green-100 px-2 py-0.5 text-xs font-semibold text-green-700">
                                Tax Exempt
                              </span>
                            )}
                          </div>
                        </div>
                      </div>
                    )}
                  </div>

                  {/* Tax Exempt Documents */}
                  {customer.isTaxExempt && (
                    <div className="mt-5 border-t border-surface-border pt-4">
                      <div className="flex items-center justify-between mb-3">
                        <p className="text-xs font-semibold uppercase tracking-wider text-navy/70">
                          Tax Exempt Documents
                        </p>
                        {isOperator && (
                          <button
                            onClick={() => taxDocInputRef.current?.click()}
                            disabled={uploadTaxDocs.isPending}
                            className="flex items-center gap-1.5 rounded-md border border-surface-border bg-white px-2.5 py-1 text-xs font-medium text-navy hover:bg-surface-50 disabled:opacity-50"
                          >
                            <Camera className="h-3.5 w-3.5" />
                            {uploadTaxDocs.isPending ? "Uploading…" : "Add Photo"}
                          </button>
                        )}
                        {/* Hidden file input — accept images, allow camera on mobile */}
                        <input
                          ref={taxDocInputRef}
                          type="file"
                          accept="image/*"
                          capture="environment"
                          multiple
                          className="hidden"
                          onChange={(e) => handleTaxDocFiles(e.target.files)}
                        />
                      </div>

                      {taxDocs.length === 0 ? (
                        <p className="text-xs text-navy/70 italic">No documents uploaded yet.</p>
                      ) : (
                        <div className="grid grid-cols-3 gap-2">
                          {taxDocs.map((doc) => (
                            <div
                              key={doc.key}
                              className="group relative aspect-square rounded-lg overflow-hidden border border-surface-border bg-surface-50"
                            >
                              {/* eslint-disable-next-line @next/next/no-img-element */}
                              <img
                                src={doc.url}
                                alt="Tax exempt doc"
                                className="h-full w-full object-cover"
                              />
                              <div className="touch-reveal absolute inset-0 flex items-center justify-center gap-1.5 bg-black/50 opacity-0 transition-opacity group-hover:opacity-100">
                                <button
                                  onClick={() => setTaxDocLightbox(taxDocToViewerDoc(doc))}
                                  className={cn(TAP_TARGET, "rounded-full bg-white/90 text-navy hover:bg-white")}
                                  title="View full size"
                                >
                                  <ZoomIn className="h-3.5 w-3.5" />
                                </button>
                                {isOperator && (
                                  <button
                                    onClick={() => deleteTaxDoc.mutate(doc.key)}
                                    className={cn(
                                      TAP_TARGET,
                                      "rounded-full bg-white/90 text-red-600 hover:bg-white",
                                    )}
                                    title="Delete"
                                  >
                                    <Trash2 className="h-3.5 w-3.5" />
                                  </button>
                                )}
                              </div>
                            </div>
                          ))}
                        </div>
                      )}
                    </div>
                  )}

                  {/* Pricing Tier */}
                  <div className="mt-5 border-t border-surface-border pt-4">
                    <div className="flex items-center justify-between">
                      <p className="text-xs font-semibold uppercase tracking-wider text-navy/70">
                        Pricing Tier
                      </p>
                      {isOperator && (
                        <select
                          value={customer.pricingTier ?? 1}
                          onChange={(e) => {
                            updateCustomer.mutate({
                              id: id,
                              pricingTier: Number(e.target.value),
                            });
                          }}
                          className="rounded border border-surface-border bg-white px-2 py-1 text-sm text-navy focus:outline-none focus:ring-2 focus:ring-brand-500"
                        >
                          {[1, 2, 3, 4, 5].map((t) => (
                            <option key={t} value={t}>
                              {tierLabel(tierLabels, t)}
                              {t === 1 ? " (Default)" : ""}
                            </option>
                          ))}
                        </select>
                      )}
                    </div>
                    {!isOperator && (
                      <p className="mt-1 text-sm font-semibold text-navy">
                        {tierLabel(tierLabels, customer.pricingTier ?? 1)}
                      </p>
                    )}
                  </div>

                  {/* Credit Limit bar */}
                  {creditLimit != null && creditLimit > 0 && (
                    <div className="mt-5 border-t border-surface-border pt-4">
                      <div className="mb-1.5 flex items-center justify-between">
                        <p className="text-xs font-semibold uppercase tracking-wider text-navy/70">
                          Credit Limit
                        </p>
                        <p className="text-sm font-semibold text-navy">
                          {fmt(receivables)} / {fmt(creditLimit)}
                        </p>
                      </div>
                      <div className="h-2.5 w-full overflow-hidden rounded-full bg-surface-raised">
                        <div
                          className={cn(
                            "h-full rounded-full transition-all",
                            creditUsagePercent > 90
                              ? "bg-danger"
                              : creditUsagePercent > 70
                                ? "bg-warning"
                                : "bg-brand-500",
                          )}
                          style={{ width: `${creditUsagePercent}%` }}
                        />
                      </div>
                      <p className="mt-1 text-xs text-navy/70">
                        {creditUsagePercent.toFixed(0)}% used
                        {creditLimit - receivables > 0 && (
                          <> &middot; {fmt(creditLimit - receivables)} available</>
                        )}
                      </p>
                    </div>
                  )}
                </Card>
              </div>

              {/* Tags card */}
              <div>
                <Card title="Tags">
                  <div className="flex flex-wrap gap-2">
                    {assignedTags.map((tag) => (
                      <span
                        key={tag.id}
                        className="group inline-flex items-center gap-1 rounded-full px-2.5 py-1 text-xs font-semibold"
                        style={{
                          backgroundColor: `${tag.color}20`,
                          color: tag.color,
                        }}
                      >
                        {tag.name}
                        <button
                          title={`Remove tag "${tag.name}"`}
                          className={cn(TAP_TARGET, "touch-reveal rounded-full p-0.5 opacity-0 transition-opacity hover:bg-black/10 group-hover:opacity-100")}
                          onClick={() =>
                            removeTag.mutate({
                              customerId: id,
                              tagId: tag.id,
                            })
                          }
                        >
                          <X className="h-3 w-3" />
                        </button>
                      </span>
                    ))}
                    {assignedTags.length === 0 && (
                      <p className="text-xs text-navy/70">No tags assigned.</p>
                    )}
                  </div>

                  <div className="relative mt-3" ref={tagDropdownRef}>
                    <Button
                      size="sm"
                      variant="secondary"
                      leftIcon={<Plus className="h-3.5 w-3.5" />}
                      onClick={() => setTagDropdownOpen((o) => !o)}
                    >
                      Add Tag
                    </Button>
                    {tagDropdownOpen && availableTags.length > 0 && (
                      <div className="absolute left-0 z-20 mt-1 w-56 rounded-lg border border-surface-border bg-white shadow-lg">
                        <ul className="max-h-48 overflow-y-auto py-1">
                          {availableTags.map((tag) => (
                            <li key={tag.id}>
                              <button
                                className="flex w-full items-center gap-2 px-3 py-2 text-left text-sm hover:bg-surface-raised"
                                onClick={() => {
                                  assignTag.mutate({
                                    customerId: id,
                                    tagId: tag.id,
                                  });
                                  setTagDropdownOpen(false);
                                }}
                              >
                                <span
                                  className="h-3 w-3 shrink-0 rounded-full"
                                  style={{ backgroundColor: tag.color }}
                                />
                                <span className="font-medium text-navy">{tag.name}</span>
                              </button>
                            </li>
                          ))}
                        </ul>
                      </div>
                    )}
                    {tagDropdownOpen && availableTags.length === 0 && (
                      <div className="absolute left-0 z-20 mt-1 w-56 rounded-lg border border-surface-border bg-white p-3 shadow-lg">
                        <p className="text-xs text-navy/70">All tags assigned.</p>
                      </div>
                    )}
                  </div>
                </Card>
              </div>
            </div>

            {/* Income & Expense Chart */}
            <Card title="Income & Expenses (Last 6 Months)">
              {!chartData || chartData.length === 0 ? (
                <div className="flex h-48 items-center justify-center">
                  <p className="text-sm text-navy/70">No chart data available.</p>
                </div>
              ) : (
                <div className="h-72">
                  <ResponsiveContainer width="100%" height="100%">
                    <BarChart data={chartData} margin={{ top: 5, right: 20, left: 10, bottom: 5 }}>
                      <CartesianGrid strokeDasharray="3 3" stroke="#e5e7eb" />
                      <XAxis dataKey="month" tick={{ fontSize: 12, fill: "#6b7280" }} />
                      <YAxis
                        tick={{ fontSize: 12, fill: "#6b7280" }}
                        tickFormatter={(v: number) =>
                          `$${v >= 1000 ? `${(v / 1000).toFixed(0)}k` : v}`
                        }
                      />
                      <Tooltip
                        formatter={(value) => fmt(Number(value))}
                        contentStyle={{
                          borderRadius: "8px",
                          border: "1px solid #e5e7eb",
                          fontSize: "13px",
                        }}
                      />
                      <Legend wrapperStyle={{ fontSize: "13px" }} />
                      <Bar dataKey="income" name="Income" fill="#22c55e" radius={[4, 4, 0, 0]} />
                      <Bar
                        dataKey="expenses"
                        name="Expenses"
                        fill="#ef4444"
                        radius={[4, 4, 0, 0]}
                      />
                    </BarChart>
                  </ResponsiveContainer>
                </div>
              )}
            </Card>

            {/* Contact Persons */}
            <Card>
              <div className="mb-4 flex items-center justify-between">
                <div>
                  <h3 className="text-base font-semibold text-navy">Contact Persons</h3>
                  <p className="mt-0.5 text-xs text-navy/70">
                    People associated with this customer account.
                  </p>
                </div>
                <Button
                  size="sm"
                  leftIcon={<Plus className="h-4 w-4" />}
                  onClick={() => {
                    setEditingContact(null);
                    setIsContactModalOpen(true);
                  }}
                >
                  Add Contact
                </Button>
              </div>

              {contactsLoading ? (
                <p className="text-sm text-navy/70">Loading contacts…</p>
              ) : contacts.length === 0 ? (
                <div className="rounded-lg border border-dashed border-surface-border bg-surface-raised py-10 text-center">
                  <User className="mx-auto h-8 w-8 text-navy/20" />
                  <p className="mt-2 text-sm text-navy/70">No contact persons yet.</p>
                  <button
                    className="mt-2 text-sm text-brand-500 hover:underline"
                    onClick={() => {
                      setEditingContact(null);
                      setIsContactModalOpen(true);
                    }}
                  >
                    Add the first one &rarr;
                  </button>
                </div>
              ) : (
                <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
                  {contacts.map((contact) => (
                    <div
                      key={contact.id}
                      className="rounded-lg border border-surface-border bg-surface-raised p-4"
                    >
                      <div className="flex items-start justify-between gap-2">
                        <div className="flex items-center gap-2">
                          <div className="flex h-8 w-8 items-center justify-center rounded-full bg-brand-100 text-xs font-bold text-brand-700">
                            {contact.firstName.charAt(0).toUpperCase()}
                            {contact.lastName ? contact.lastName.charAt(0).toUpperCase() : ""}
                          </div>
                          <div>
                            <p className="text-sm font-semibold text-navy">
                              {[contact.salutation, contact.firstName, contact.lastName]
                                .filter(Boolean)
                                .join(" ")}
                            </p>
                            {contact.isPrimary && (
                              <span className="inline-flex items-center rounded-full bg-brand-100 px-2 py-0.5 text-xs font-semibold text-brand-700">
                                Primary
                              </span>
                            )}
                          </div>
                        </div>
                        <div className="flex shrink-0 items-center gap-0.5">
                          <button
                            title="Edit contact"
                            className={cn(TAP_TARGET, "rounded p-1.5 text-navy/70 transition-colors hover:bg-white hover:text-navy")}
                            onClick={() => {
                              setEditingContact(contact);
                              setIsContactModalOpen(true);
                            }}
                          >
                            <Pencil className="h-3.5 w-3.5" />
                          </button>
                          <button
                            title="Delete contact"
                            className={cn(TAP_TARGET, "rounded p-1.5 text-navy/70 transition-colors hover:bg-danger-bg hover:text-danger")}
                            onClick={() => setDeletingContactId(contact.id)}
                          >
                            <Trash2 className="h-3.5 w-3.5" />
                          </button>
                        </div>
                      </div>
                      <div className="mt-3 space-y-1.5">
                        {contact.email && (
                          <p className="flex items-center gap-2 text-xs text-navy/70">
                            <Mail className="h-3 w-3 shrink-0 text-navy/30" />
                            {contact.email}
                          </p>
                        )}
                        {contact.phone && (
                          <p className="flex items-center gap-2 text-xs text-navy/70">
                            <Phone className="h-3 w-3 shrink-0 text-navy/30" />
                            {contact.phone}
                          </p>
                        )}
                        {contact.mobile && (
                          <p className="flex items-center gap-2 text-xs text-navy/70">
                            <Phone className="h-3 w-3 shrink-0 text-navy/30" />
                            {contact.mobile}
                            <span className="text-navy/30">(mobile)</span>
                          </p>
                        )}
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </Card>

            {/* Existing: Delivery window + Routes + Status */}
            <div className="grid grid-cols-1 gap-5 lg:grid-cols-3">
              <div className="space-y-5 lg:col-span-2">
                <Card title="Delivery Time Window">
                  <div className="space-y-3">
                    <p className="text-sm text-navy/70">
                      Set the customer&apos;s accepted delivery hours. The route optimizer will
                      schedule this stop within the window.
                    </p>
                    <label className="flex cursor-pointer items-center gap-2">
                      <input
                        type="checkbox"
                        checked={anyTime}
                        onChange={(e) => handleAnyTimeToggle(e.target.checked)}
                        className="h-4 w-4 rounded border-surface-border text-brand-500 focus:ring-brand-500"
                      />
                      <span className="text-sm font-medium text-navy">
                        Any time (24/7 — no window restriction)
                      </span>
                    </label>
                    <div
                      className={`grid grid-cols-2 gap-4 transition-opacity ${anyTime ? "pointer-events-none opacity-40" : ""}`}
                    >
                      <div className="space-y-1">
                        <label className="flex items-center gap-1.5 text-xs font-medium text-navy/70">
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
                        <label className="flex items-center gap-1.5 text-xs font-medium text-navy/70">
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
                      <p className="text-xs font-medium text-success">
                        Window: {windowStart} – {windowEnd}
                      </p>
                    )}
                  </div>
                </Card>

                <Card title="Assigned Routes">
                  <div className="space-y-3">
                    {(customerRoutes ?? []).length === 0 ? (
                      <p className="text-sm text-navy/70">Not assigned to any routes yet.</p>
                    ) : (
                      <ul className="-mx-6 divide-y divide-surface-border">
                        {(customerRoutes as any[]).map((r) => (
                          <li key={r.id} className="flex items-center gap-3 px-6 py-3">
                            <Route className="h-4 w-4 shrink-0 text-navy/70" />
                            <div className="min-w-0 flex-1">
                              <p className="text-sm font-medium text-navy">{r.name}</p>
                              {r.driverName && (
                                <p className="text-xs text-navy/70">Driver: {r.driverName}</p>
                              )}
                            </div>
                            <span
                              className={cn(
                                "shrink-0 rounded-full px-2 py-0.5 text-xs font-medium",
                                r.isActive
                                  ? "bg-success-bg text-success"
                                  : "bg-surface-raised text-navy/70",
                              )}
                            >
                              {r.isActive ? "Active" : "Inactive"}
                            </span>
                          </li>
                        ))}
                      </ul>
                    )}
                    {routesAccess && (
                      <Button
                        size="sm"
                        variant="secondary"
                        leftIcon={<Plus className="h-4 w-4" />}
                        onClick={() => setIsAssignRouteOpen(true)}
                      >
                        Assign to Route
                      </Button>
                    )}
                  </div>
                </Card>
              </div>

              <div className="space-y-5">
                {hasSalesAgents && (
                  <Card title="Sales Agent">
                    {currentAgent.isLoading ? (
                      <p className="text-sm text-navy/70">Loading…</p>
                    ) : currentAgent.data?.assignment ? (
                      <div className="flex flex-col gap-2">
                        <div className="flex items-center justify-between">
                          <Link
                            href={`/sales-agents/${currentAgent.data.assignment.agent.id}`}
                            className="text-sm font-semibold text-brand-700 hover:underline"
                          >
                            {currentAgent.data.assignment.agent.name}
                          </Link>
                          {currentAgent.data.assignment.agent.status !== "ACTIVE" && (
                            <Badge
                              variant="warning"
                              label={
                                currentAgent.data.assignment.agent.status === "STOPPED_FOR_NEW"
                                  ? "Stopped for new"
                                  : "Paused"
                              }
                            />
                          )}
                        </div>
                        <p className="text-xs text-navy/70">
                          Since {fmtCalendarDate(currentAgent.data.assignment.effectiveFrom)}
                          {currentAgent.data.customerRatePct != null &&
                            ` · customer rate ${pctLabel(currentAgent.data.customerRatePct)}`}
                        </p>
                        {isOperator && (
                          <div className="flex gap-2 border-t border-surface-border pt-3">
                            <Button
                              size="sm"
                              variant="secondary"
                              onClick={() => setAgentModalOpen(true)}
                            >
                              Reassign
                            </Button>
                            <Button size="sm" variant="ghost" onClick={handleEndAttribution}>
                              Remove
                            </Button>
                          </div>
                        )}
                      </div>
                    ) : (
                      <div className="flex flex-col gap-3">
                        <p className="text-sm text-navy/70">No agent assigned (house account).</p>
                        {isOperator && (
                          <Button
                            size="sm"
                            variant="secondary"
                            onClick={() => setAgentModalOpen(true)}
                          >
                            Assign agent
                          </Button>
                        )}
                      </div>
                    )}
                  </Card>
                )}

                <Card title="Account Status">
                  {isRemoved ? (
                    // REG-B170: status can't be cycled and Remove doesn't apply to an
                    // already-removed customer — Restore is the only action here.
                    <div className="flex flex-col gap-4">
                      <div className="flex items-center justify-between">
                        <p className="text-sm text-navy/70">Current status</p>
                        <Badge variant="danger" label="Removed" />
                      </div>
                      <Button
                        variant="secondary"
                        leftIcon={<UserCheck className="h-4 w-4" />}
                        onClick={() => restoreCustomer.mutate({ id })}
                        loading={restoreCustomer.isPending}
                      >
                        Restore customer
                      </Button>
                    </div>
                  ) : (
                    <div className="flex flex-col gap-4">
                      <div className="flex items-center justify-between">
                        <p className="text-sm text-navy/70">Current status</p>
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
                                : "border-surface-border text-navy/70 hover:border-navy/30 hover:text-navy",
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
                      {currentStatus === "SUSPENDED" && (
                        <div className="border-t border-surface-border pt-4">
                          <button
                            onClick={() => setIsDeleteOpen(true)}
                            className="flex w-full items-center gap-2 rounded-lg border border-danger/30 px-3 py-2 text-sm font-medium text-danger transition-colors hover:bg-danger/5"
                          >
                            <Trash2 className="h-4 w-4" />
                            Remove customer
                          </button>
                        </div>
                      )}
                    </div>
                  )}
                </Card>

                {/* ── Buyer Portal card ──────────────────────────── */}
                <Card title="Buyer Portal">
                  {portalLoading ? (
                    <p className="text-sm text-navy/70">Loading…</p>
                  ) : (
                    <div className="flex flex-col gap-3">
                      {/* Status row */}
                      <div className="flex items-center justify-between">
                        <p className="text-sm text-navy/70">Portal status</p>
                        <span
                          className={cn(
                            "rounded-full px-2.5 py-0.5 text-xs font-semibold",
                            portalStatus?.status === "ACTIVE"
                              ? "bg-success/10 text-success"
                              : portalStatus?.status === "INVITED"
                                ? "bg-warning/10 text-warning-700"
                                : portalStatus?.status === "PENDING_SELLER_APPROVAL"
                                  ? "bg-brand-50 text-brand-700"
                                  : portalStatus?.status === "DISCONNECTED"
                                    ? "bg-danger/10 text-danger"
                                    : "bg-surface-raised text-navy/70",
                          )}
                        >
                          {portalStatus?.status === "NOT_INVITED"
                            ? "Not Invited"
                            : portalStatus?.status === "INVITED"
                              ? "Invite Sent"
                              : portalStatus?.status === "ACTIVE"
                                ? "Connected"
                                : portalStatus?.status === "PENDING_SELLER_APPROVAL"
                                  ? "Pending Approval"
                                  : portalStatus?.status === "DISCONNECTED"
                                    ? "Disconnected"
                                    : "Unknown"}
                        </span>
                      </div>

                      {/* Active: show buyer account */}
                      {portalStatus?.status === "ACTIVE" && portalStatus.buyerAccount && (
                        <div className="rounded-lg bg-surface-raised px-3 py-2 text-xs text-navy/70">
                          <p className="font-medium">{portalStatus.buyerAccount.name}</p>
                          <p>{portalStatus.buyerAccount.email}</p>
                        </div>
                      )}

                      {/* Invited: show expiry */}
                      {portalStatus?.status === "INVITED" && portalStatus.inviteExpiresAt && (
                        <p className="text-xs text-navy/70">
                          Expires {new Date(portalStatus.inviteExpiresAt).toLocaleDateString()}
                        </p>
                      )}

                      {/* Pending approval: show WHO is asking to connect */}
                      {portalStatus?.status === "PENDING_SELLER_APPROVAL" &&
                        pendingRequester?.buyerName && (
                          <div className="rounded-lg bg-brand-50 px-3 py-2 text-xs text-navy/70">
                            <p className="font-medium text-navy">
                              {pendingRequester.buyerName}
                              {pendingRequester.buyerEmail
                                ? ` (${pendingRequester.buyerEmail})`
                                : ""}
                            </p>
                            <p>wants to connect as this customer.</p>
                          </div>
                        )}

                      {/* Error/success message */}
                      {portalMsg && (
                        <p className="rounded-lg bg-success/10 px-3 py-2 text-xs text-success">
                          {portalMsg}
                        </p>
                      )}

                      {/* Override email field for sending invite */}
                      {(portalStatus?.status === "NOT_INVITED" ||
                        portalStatus?.status === "DISCONNECTED") && (
                        <Input
                          placeholder={`Override email (optional)`}
                          value={portalInviteEmail}
                          onChange={(e) => setPortalInviteEmail(e.target.value)}
                          label="Invite email"
                        />
                      )}

                      {/* Actions */}
                      <div className="flex flex-col gap-2">
                        {(portalStatus?.status === "NOT_INVITED" ||
                          portalStatus?.status === "DISCONNECTED") && (
                          <Button
                            size="sm"
                            loading={sendInvite.isPending}
                            onClick={() => {
                              setPortalMsg(null);
                              sendInvite.mutate(
                                {
                                  id: id,
                                  method: "EMAIL",
                                  overrideEmail: portalInviteEmail || undefined,
                                },
                                {
                                  onSuccess: (d: { message?: string }) =>
                                    setPortalMsg(d?.message ?? "Invite sent!"),
                                  onError: () => setPortalMsg(null),
                                },
                              );
                            }}
                          >
                            Send Portal Invite
                          </Button>
                        )}

                        {portalStatus?.status === "INVITED" && (
                          <Button
                            size="sm"
                            variant="secondary"
                            loading={resendInvite.isPending}
                            onClick={() => {
                              setPortalMsg(null);
                              resendInvite.mutate(id, {
                                onSuccess: (d: { message?: string }) =>
                                  setPortalMsg(d?.message ?? "Invite resent!"),
                                onError: () => setPortalMsg(null),
                              });
                            }}
                          >
                            Resend Invite
                          </Button>
                        )}

                        {portalStatus?.status === "PENDING_SELLER_APPROVAL" && (
                          <div className="flex gap-2">
                            <Button
                              size="sm"
                              loading={approvePortal.isPending}
                              onClick={() => {
                                setPortalMsg(null);
                                approvePortal.mutate(id, {
                                  onSuccess: () => setPortalMsg("Buyer connection approved!"),
                                  onError: () => setPortalMsg(null),
                                });
                              }}
                            >
                              Approve Connection
                            </Button>
                            <Button
                              size="sm"
                              variant="danger"
                              onClick={() => {
                                setPortalMsg(null);
                                setDeclineConfirmOpen(true);
                              }}
                            >
                              Decline
                            </Button>
                          </div>
                        )}

                        {(portalStatus?.status === "ACTIVE" ||
                          portalStatus?.status === "INVITED" ||
                          portalStatus?.status === "PENDING_SELLER_APPROVAL") && (
                          <Button
                            size="sm"
                            variant="danger"
                            loading={disconnectPortal.isPending}
                            onClick={() => {
                              setPortalMsg(null);
                              disconnectPortal.mutate(id, {
                                onSuccess: () => setPortalMsg("Portal disconnected."),
                                onError: () => setPortalMsg(null),
                              });
                            }}
                          >
                            Disconnect Portal
                          </Button>
                        )}
                      </div>
                    </div>
                  )}
                </Card>
              </div>
            </div>
          </div>
        </Tabs.Content>

        {/* ── Orders tab ─────────────────────────────────────────── */}
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
            {orderCount > allOrders.length && (
              <p className="mb-2 text-xs text-navy/70">
                Showing the latest {allOrders.length} of {orderCount} orders.
              </p>
            )}
            <div className="-mx-6 -mb-6">
              <Table
                data={filteredOrders}
                columns={orderColumns}
                onRowClick={(row) => router.push(`/orders/${row.original.id}`)}
                emptyState={
                  ordersError
                    ? "Couldn't load this customer's orders. Refresh to try again."
                    : orderStatusFilter
                      ? "No orders match the selected filter."
                      : "No orders yet."
                }
              />
            </div>
          </Card>
        </Tabs.Content>

        {/* ── Addresses tab ──────────────────────────────────────── */}
        <Tabs.Content value="addresses" className="mt-5 focus:outline-none">
          <Card>
            <div className="mb-4 flex items-center justify-between">
              <h3 className="text-base font-semibold text-navy">Addresses</h3>
              <Button
                size="sm"
                leftIcon={<Plus className="h-4 w-4" />}
                onClick={() => {
                  setEditingAddress(null);
                  setIsAddAddressOpen(true);
                }}
              >
                Add Address
              </Button>
            </div>

            {addresses.length === 0 ? (
              <p className="text-sm text-navy/70">No addresses on file.</p>
            ) : (
              (() => {
                const typeOrder = ["BILLING", "SHIPPING", "DELIVERY"];
                const typeLabel: Record<string, string> = {
                  BILLING: "Billing",
                  SHIPPING: "Shipping",
                  DELIVERY: "Delivery",
                };
                const typeColor: Record<string, string> = {
                  BILLING: "bg-brand-100 text-brand-700",
                  SHIPPING: "bg-teal-100 text-teal-700",
                  DELIVERY: "bg-purple-100 text-purple-700",
                };
                const grouped: Record<string, any[]> = {};
                for (const addr of addresses as any[]) {
                  const t = addr.addressType || "BILLING";
                  if (!grouped[t]) grouped[t] = [];
                  grouped[t].push(addr);
                }
                const orderedTypes = [
                  ...typeOrder.filter((t) => grouped[t]),
                  ...Object.keys(grouped).filter((t) => !typeOrder.includes(t)),
                ];
                return (
                  <div className="space-y-4">
                    {orderedTypes.map((type) => (
                      <div key={type}>
                        <div className="mb-2 flex items-center gap-2">
                          <span
                            className={cn(
                              "rounded-full px-2.5 py-0.5 text-xs font-semibold",
                              typeColor[type] ?? "bg-gray-100 text-gray-700",
                            )}
                          >
                            {typeLabel[type] ?? type}
                          </span>
                          <span className="text-xs text-navy/70">
                            {grouped[type].length} address{grouped[type].length > 1 ? "es" : ""}
                          </span>
                        </div>
                        <ul className="divide-y divide-surface-border rounded-lg border border-surface-border">
                          {grouped[type].map((addr: any) => (
                            <li key={addr.id} className="flex items-start gap-3 px-4 py-3">
                              <MapPin className="mt-0.5 h-4 w-4 shrink-0 text-navy/70" />
                              <div className="min-w-0 flex-1">
                                <div className="flex items-center gap-2">
                                  <p className="text-sm font-medium text-navy">{addr.label}</p>
                                  {addr.isDefault && (
                                    <Star className="h-3.5 w-3.5 fill-warning text-warning" />
                                  )}
                                </div>
                                <p className="mt-0.5 text-sm text-navy/70">
                                  {addr.line1}
                                  {addr.line2 ? `, ${addr.line2}` : ""}, {addr.city}, {addr.state}{" "}
                                  {addr.zip}
                                </p>
                              </div>
                              <div className="flex shrink-0 flex-col items-end gap-1.5">
                                {addr.isDefault && (
                                  <span className="rounded-full bg-brand-100 px-2 py-0.5 text-xs font-medium text-brand-700">
                                    Primary
                                  </span>
                                )}
                                {deleteAddressConfirmId === addr.id ? (
                                  <div className="flex items-center gap-2">
                                    <span className="text-xs text-danger">Delete?</span>
                                    <button
                                      type="button"
                                      onClick={() => handleDeleteAddress(addr.id)}
                                      disabled={deleteAddress.isPending}
                                      className="text-xs font-medium text-danger hover:underline disabled:opacity-40"
                                    >
                                      Delete
                                    </button>
                                    <button
                                      type="button"
                                      onClick={() => setDeleteAddressConfirmId(null)}
                                      className="text-xs text-navy/70 hover:text-navy transition-colors"
                                    >
                                      Cancel
                                    </button>
                                  </div>
                                ) : (
                                  <div className="flex items-center gap-1">
                                    {!addr.isDefault && (
                                      <button
                                        type="button"
                                        onClick={() => handleSetPrimaryAddress(addr.id)}
                                        disabled={updateAddress.isPending}
                                        title="Set as primary"
                                        className={cn(
                                          TAP_TARGET,
                                          "rounded p-1 text-navy/30 transition-colors hover:bg-warning/10 hover:text-warning disabled:opacity-40",
                                        )}
                                      >
                                        <Star className="h-3.5 w-3.5" />
                                      </button>
                                    )}
                                    <button
                                      type="button"
                                      onClick={() => {
                                        setEditingAddress(addr);
                                        setIsAddAddressOpen(true);
                                      }}
                                      title="Edit"
                                      className={cn(
                                        TAP_TARGET,
                                        "rounded p-1 text-navy/30 transition-colors hover:bg-surface-raised hover:text-navy",
                                      )}
                                    >
                                      <Pencil className="h-3.5 w-3.5" />
                                    </button>
                                    <button
                                      type="button"
                                      onClick={() => setDeleteAddressConfirmId(addr.id)}
                                      title="Delete"
                                      className={cn(
                                        TAP_TARGET,
                                        "rounded p-1 text-navy/30 transition-colors hover:bg-danger/10 hover:text-danger",
                                      )}
                                    >
                                      <Trash2 className="h-3.5 w-3.5" />
                                    </button>
                                  </div>
                                )}
                              </div>
                            </li>
                          ))}
                        </ul>
                      </div>
                    ))}
                  </div>
                );
              })()
            )}
          </Card>
        </Tabs.Content>

        {/* ── Standing Orders tab ────────────────────────────────── */}
        <Tabs.Content value="standing-orders" className="mt-5 focus:outline-none">
          <Card>
            <div className="mb-4 flex items-center justify-between">
              <div>
                <h3 className="text-base font-semibold text-navy">Standing Orders</h3>
                <p className="mt-0.5 text-xs text-navy/70">
                  Auto-generated orders based on recurring schedules.
                </p>
              </div>
              <Button
                size="sm"
                leftIcon={<Plus className="h-4 w-4" />}
                onClick={() => {
                  setEditingTemplate(null);
                  setIsStandingOrderOpen(true);
                }}
              >
                Add Standing Order
              </Button>
            </div>

            {templates.length === 0 ? (
              <div className="rounded-lg border border-dashed border-surface-border bg-surface-raised py-10 text-center">
                <p className="text-sm text-navy/70">No standing orders yet.</p>
                <button
                  className="mt-2 text-sm text-brand-500 hover:underline"
                  onClick={() => {
                    setEditingTemplate(null);
                    setIsStandingOrderOpen(true);
                  }}
                >
                  Add the first one &rarr;
                </button>
              </div>
            ) : (
              <ul className="-mx-6 -mb-6 divide-y divide-surface-border">
                {templates.map((tmpl) => (
                  <li key={tmpl.id} className="px-6 py-4">
                    <div className="flex items-start justify-between gap-4">
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center gap-2">
                          <p className="text-sm font-semibold text-navy">{tmpl.name}</p>
                          <span
                            className={cn(
                              "rounded-full px-2 py-0.5 text-xs font-medium",
                              tmpl.isActive
                                ? "bg-success-bg text-success"
                                : "bg-surface-raised text-navy/70",
                            )}
                          >
                            {tmpl.isActive ? "Active" : "Paused"}
                          </span>
                        </div>
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
                        <p className="mt-1 text-xs text-navy/70">
                          {tmpl.items.length} item
                          {tmpl.items.length !== 1 ? "s" : ""}
                          {tmpl.notes && ` \u00b7 ${tmpl.notes}`}
                        </p>
                      </div>
                      <div className="flex shrink-0 items-center gap-1">
                        <button
                          title={tmpl.isActive ? "Pause template" : "Activate template"}
                          className={cn(TAP_TARGET, "rounded p-1.5 text-navy/70 transition-colors hover:bg-surface-raised hover:text-navy")}
                          onClick={() =>
                            updateTemplate.mutate({
                              id: tmpl.id,
                              isActive: !tmpl.isActive,
                            })
                          }
                        >
                          <span
                            className={cn(
                              "block h-4 w-4",
                              tmpl.isActive ? "text-success" : "text-navy/30",
                            )}
                          >
                            {tmpl.isActive ? "\u23f8" : "\u25b6"}
                          </span>
                        </button>
                        <button
                          title="Generate order now"
                          className={cn(TAP_TARGET, "rounded p-1.5 text-navy/70 transition-colors hover:bg-brand-50 hover:text-brand-600")}
                          onClick={() =>
                            generateOrder.mutate(tmpl.id, {
                              onSuccess: () => window.alert(`Order generated for "${tmpl.name}"!`),
                            })
                          }
                        >
                          <Zap className="h-4 w-4" />
                        </button>
                        <button
                          title="Edit template"
                          className={cn(TAP_TARGET, "rounded p-1.5 text-navy/70 transition-colors hover:bg-surface-raised hover:text-navy")}
                          onClick={() => {
                            setEditingTemplate(tmpl);
                            setIsStandingOrderOpen(true);
                          }}
                        >
                          <Pencil className="h-4 w-4" />
                        </button>
                        <button
                          title="Delete template"
                          className={cn(TAP_TARGET, "rounded p-1.5 text-navy/70 transition-colors hover:bg-danger-bg hover:text-danger")}
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

        {/* ── Invoices tab ───────────────────────────────────────── */}
        <Tabs.Content value="invoices" className="mt-5 focus:outline-none">
          {/* Summary bar */}
          {(() => {
            const allInvoices = invoicesData?.data ?? [];
            // B110: the Outstanding card reads the statement's own
            // `outstandingAmount` — computed server-side over the customer's
            // WHOLE open invoice set — instead of reducing this tab's paged
            // `invoicesData` (which silently undercounted once a customer had
            // more open invoices than fit one page). Matches the Overview
            // tile above (both read the same `statement`), never a second,
            // page-scoped basis.
            // m8: "Overdue" is a money figure too — read the statement's
            // `overdueAmount` (the server's uncapped sum over the customer's
            // whole open set), never a count over this tab's 50-row page.
            const outstandingTotal = statement?.outstandingAmount ?? 0;
            const overdueTotal = statement?.overdueAmount ?? 0;
            return (
              <div className="mb-5 grid grid-cols-2 gap-4 sm:grid-cols-3">
                <Card>
                  <p className="text-xs font-semibold uppercase tracking-wider text-navy/70">
                    Outstanding
                  </p>
                  <p
                    className={`mt-1 text-xl font-bold ${outstandingTotal > 0 ? "text-danger" : "text-success"}`}
                  >
                    {fmt(outstandingTotal)}
                  </p>
                </Card>
                <Card>
                  <p className="text-xs font-semibold uppercase tracking-wider text-navy/70">
                    Overdue
                  </p>
                  <p
                    className={`mt-1 text-xl font-bold ${overdueTotal > 0 ? "text-danger" : "text-navy"}`}
                  >
                    {fmt(overdueTotal)}
                  </p>
                </Card>
                <Card>
                  <p className="text-xs font-semibold uppercase tracking-wider text-navy/70">
                    Total Invoices
                  </p>
                  <p className="mt-1 text-xl font-bold text-navy">
                    {invoicesData?.meta?.total ?? allInvoices.length}
                  </p>
                </Card>
              </div>
            );
          })()}

          <Card>
            {/* Header row */}
            <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
              <div className="flex gap-2">
                {(
                  [
                    { key: "all", label: "All" },
                    { key: "outstanding", label: "Outstanding" },
                    { key: "paid", label: "Paid" },
                    { key: "void", label: "Void" },
                  ] as const
                ).map(({ key, label }) => (
                  <button
                    key={key}
                    onClick={() => setInvoiceFilter(key)}
                    className={`rounded-full px-3 py-1 text-xs font-semibold transition-colors ${
                      invoiceFilter === key
                        ? "bg-brand text-white"
                        : "bg-surface-secondary text-navy/70 hover:bg-surface-border"
                    }`}
                  >
                    {label}
                  </button>
                ))}
              </div>
              <Link
                href={`/invoices/new?customerId=${id}`}
                className="inline-flex items-center gap-1.5 rounded-lg bg-brand px-3 py-1.5 text-xs font-semibold text-white hover:bg-brand/90"
              >
                <Plus className="h-3.5 w-3.5" />
                New Invoice
              </Link>
            </div>

            {/* Invoice table */}
            {invoicesLoading ? (
              <p className="py-8 text-center text-sm text-navy/70">Loading invoices…</p>
            ) : customerInvoices.length === 0 ? (
              <div className="py-10 text-center">
                <FileText className="mx-auto mb-3 h-8 w-8 text-navy/20" />
                <p className="text-sm font-medium text-navy/70">No invoices found</p>
                <Link
                  href={`/invoices/new?customerId=${id}`}
                  className="mt-3 inline-flex items-center gap-1.5 rounded-lg bg-brand px-3 py-1.5 text-xs font-semibold text-white hover:bg-brand/90"
                >
                  <Plus className="h-3.5 w-3.5" />
                  Create Invoice
                </Link>
              </div>
            ) : (
              <div className="-mx-6 -mb-6 overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b border-surface-border bg-surface-secondary text-left text-xs font-semibold uppercase tracking-wider text-navy/70">
                      <th className="px-6 py-3">Invoice #</th>
                      <th className="px-4 py-3">Date</th>
                      <th className="px-4 py-3">Due Date</th>
                      <th className="px-4 py-3 text-right">Total</th>
                      <th className="px-4 py-3 text-right">Balance Due</th>
                      <th className="px-6 py-3">Status</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-surface-border">
                    {customerInvoices.map((inv) => {
                      const isOverdue = inv.status === "OVERDUE";
                      const balanceDue = inv.balanceDue ?? 0;
                      return (
                        <tr
                          key={inv.id}
                          className="transition-colors hover:bg-surface-secondary/40"
                        >
                          <td className="px-6 py-3">
                            <Link
                              href={`/invoices/${inv.id}`}
                              className="font-semibold text-brand hover:underline"
                            >
                              {inv.invoiceNumber}
                            </Link>
                          </td>
                          <td className="px-4 py-3 text-navy/70">
                            {inv.issueDate ? fmtCalendarDate(inv.issueDate) : "—"}
                          </td>
                          <td
                            className={`px-4 py-3 ${isOverdue ? "font-semibold text-danger" : "text-navy/70"}`}
                          >
                            {inv.dueDate ? fmtCalendarDate(inv.dueDate) : "—"}
                          </td>
                          <td className="px-4 py-3 text-right text-navy">{fmt(inv.total)}</td>
                          <td
                            className={`px-4 py-3 text-right font-semibold ${balanceDue > 0 ? "text-danger" : "text-success"}`}
                          >
                            {fmt(balanceDue)}
                          </td>
                          <td className="px-6 py-3">
                            {renderInvoiceStatus(inv.status, inv.dueDate)}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </Card>
        </Tabs.Content>

        {/* ── Billing tab ────────────────────────────────────────── */}
        <Tabs.Content value="billing" className="mt-5 focus:outline-none">
          <div className="grid grid-cols-1 gap-5 lg:grid-cols-3">
            <div className="space-y-4 lg:col-span-1">
              <Card>
                <div className="space-y-3">
                  <div className="flex items-center justify-between">
                    <p className="text-xs font-semibold uppercase tracking-wider text-navy/70">
                      Open Balance
                    </p>
                    <TrendingDown className="h-4 w-4 text-danger" />
                  </div>
                  <p
                    className={`text-2xl font-bold ${(statement?.outstandingAmount ?? 0) > 0 ? "text-danger" : "text-success"}`}
                  >
                    {fmt(statement?.outstandingAmount ?? 0)}
                  </p>
                  <p className="text-xs text-navy/70">Amount currently owed on invoices</p>
                  <Button
                    size="sm"
                    className="w-full"
                    leftIcon={<Wallet className="h-4 w-4" />}
                    onClick={() => setIsRecordPaymentOpen(true)}
                  >
                    Record Payment
                  </Button>
                </div>
              </Card>
              <Card>
                <div className="space-y-3">
                  <div className="flex items-center justify-between">
                    <p className="text-xs font-semibold uppercase tracking-wider text-navy/70">
                      Advance Balance
                    </p>
                    <DollarSign className="h-4 w-4 text-success" />
                  </div>
                  <p className="text-2xl font-bold text-success">
                    {fmt(statement?.advanceBalance ?? 0)}
                  </p>
                  <p className="text-xs text-navy/70">Pre-paid credit available to apply</p>
                  <Button
                    size="sm"
                    variant="secondary"
                    className="w-full"
                    leftIcon={<Plus className="h-4 w-4" />}
                    onClick={() => {
                      setAdvanceForm({
                        method: "ACH",
                        amount: "",
                        reference: "",
                        notes: "",
                      });
                      setIsAdvanceOpen(true);
                    }}
                  >
                    Record Advance Payment
                  </Button>
                </div>
              </Card>

              {(advancePayments ?? []).length > 0 && (
                <Card title="Advance Payments">
                  <ul className="-mx-6 -mb-6 divide-y divide-surface-border">
                    {(advancePayments ?? []).map((ap: AdvancePayment) => (
                      <li key={ap.id} className="px-6 py-3">
                        <div className="flex items-center justify-between">
                          <span className="text-sm font-semibold text-navy">
                            {fmt(Number(ap.amount))}
                          </span>
                          <span
                            className={`text-xs font-medium ${Number(ap.balance) > 0 ? "text-success" : "text-navy/70"}`}
                          >
                            {fmt(Number(ap.balance))} left
                          </span>
                        </div>
                        <p className="mt-0.5 text-xs text-navy/70">
                          {paymentMethodLabel(ap.method)}
                          {ap.reference ? ` \u00b7 ${ap.reference}` : ""} \u00b7{" "}
                          {new Date(ap.createdAt).toLocaleDateString()}
                        </p>
                      </li>
                    ))}
                  </ul>
                </Card>
              )}
            </div>

            <div className="space-y-4 lg:col-span-2">
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

              <div className="rounded-xl border border-surface-border bg-white p-8 shadow-[0_2px_12px_0_rgb(0,0,0,0.06)]">
                <div className="mb-6 flex items-start justify-between">
                  <div>
                    <div className="flex items-center gap-2">
                      <BrandMark size={28} />
                      <span className="text-base font-bold text-navy">RouteFlow</span>
                    </div>
                    <p className="mt-0.5 text-xs text-navy/70">Austin, TX · routeflow.io</p>
                  </div>
                  <div className="text-right">
                    <p className="text-lg font-bold uppercase tracking-wide text-navy">
                      Statement of Accounts
                    </p>
                    <p className="mt-0.5 text-xs text-navy/70">
                      As of{" "}
                      {new Date().toLocaleDateString("en-US", {
                        month: "long",
                        day: "numeric",
                        year: "numeric",
                      })}
                    </p>
                  </div>
                </div>

                <div className="mb-6 border-t border-surface-border pt-4">
                  <p className="text-xs font-semibold uppercase tracking-wider text-navy/70">To</p>
                  <p className="mt-1 text-sm font-semibold text-navy">{customer.businessName}</p>
                  {customer.contactName && (
                    <p className="text-sm text-navy/70">{customer.contactName}</p>
                  )}
                  {customer.address && (
                    <p className="mt-0.5 whitespace-pre-line text-xs text-navy/70">
                      {customer.address}
                    </p>
                  )}
                </div>

                <div className="mb-6 grid grid-cols-2 gap-px overflow-hidden rounded-lg border border-surface-border bg-surface-border sm:grid-cols-4">
                  {[
                    {
                      label: "Opening Balance",
                      value: fmt(0),
                      valueClass: "text-navy",
                    },
                    {
                      // B110/M1: lifetime totals come from the server's
                      // DB-side aggregate over the WHOLE invoice/payment
                      // history, never a reduce over the capped `transactions`
                      // ledger below (which stops at one page).
                      label: "Invoiced Amount",
                      value: fmt(statement?.lifetimeInvoiced ?? 0),
                      valueClass: "text-navy",
                    },
                    {
                      label: "Amount Received",
                      value: fmt(statement?.lifetimeReceived ?? 0),
                      valueClass: "text-success",
                    },
                    {
                      label: "Balance Due",
                      value: fmt(statement?.outstandingAmount ?? 0),
                      valueClass:
                        (statement?.outstandingAmount ?? 0) > 0 ? "text-danger" : "text-success",
                    },
                  ].map((item) => (
                    <div
                      key={item.label}
                      className="flex flex-col items-center gap-1 bg-white px-4 py-3 text-center"
                    >
                      <span className="text-xs font-semibold uppercase tracking-wider text-navy/70">
                        {item.label}
                      </span>
                      <span className={cn("text-base font-bold", item.valueClass)}>
                        {item.value}
                      </span>
                    </div>
                  ))}
                </div>

                <LedgerTruncationNote truncated={statement?.transactionsTruncated} />

                {!statement || statement.transactions.length === 0 ? (
                  <p className="text-sm text-navy/70">No transactions on record.</p>
                ) : (
                  <div className="-mx-8 overflow-x-auto">
                    <table className="w-full min-w-[640px] text-sm">
                      <thead>
                        <tr className="bg-[#1B3A5C]">
                          <th className="px-8 py-2.5 text-left text-xs font-semibold uppercase tracking-wider text-white/80">
                            Date
                          </th>
                          <th className="px-4 py-2.5 text-left text-xs font-semibold uppercase tracking-wider text-white/80">
                            Type
                          </th>
                          <th className="px-4 py-2.5 text-left text-xs font-semibold uppercase tracking-wider text-white/80">
                            Details
                          </th>
                          <th className="px-4 py-2.5 text-right text-xs font-semibold uppercase tracking-wider text-white/80">
                            Amount
                          </th>
                          <th className="px-8 py-2.5 text-right text-xs font-semibold uppercase tracking-wider text-white/80">
                            Remaining
                          </th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-surface-border">
                        {statement.transactions.map((tx, i) => {
                          // Server rows: INVOICE / CREDIT_NOTE / ADVANCE_PAYMENT
                          // (payments fold into invoices). `runningBalance` is
                          // per-row remaining: owed / unused / in wallet.
                          const isInvoice = tx.type === "INVOICE";
                          const meta = isInvoice
                            ? { label: "Invoice", cls: "bg-blue-100 text-blue-700" }
                            : tx.type === "CREDIT_NOTE"
                              ? { label: "Credit note", cls: "bg-green-100 text-green-700" }
                              : { label: "Advance", cls: "bg-purple-100 text-purple-700" };
                          const remainingLabel = isInvoice
                            ? "owed"
                            : tx.type === "CREDIT_NOTE"
                              ? "unused"
                              : "in wallet";
                          return (
                            <tr
                              key={tx.id ?? i}
                              className={i % 2 === 0 ? "bg-white" : "bg-gray-50/60"}
                            >
                              <td className="px-8 py-2.5 text-xs text-navy/70">
                                {new Date(tx.date).toLocaleDateString("en-US", {
                                  month: "short",
                                  day: "numeric",
                                  year: "numeric",
                                })}
                              </td>
                              <td className="px-4 py-2.5">
                                <span
                                  className={cn(
                                    "inline-flex items-center rounded-full px-2 py-0.5 text-xs font-semibold",
                                    meta.cls,
                                  )}
                                >
                                  {meta.label}
                                </span>
                              </td>
                              <td className="px-4 py-2.5 text-sm text-navy">
                                <span className="text-xs text-navy/70">{tx.description}</span>
                              </td>
                              <td className="px-4 py-2.5 text-right text-sm">
                                <span
                                  className={cn(
                                    "font-medium",
                                    isInvoice ? "text-navy" : "text-success",
                                  )}
                                >
                                  {fmt(Math.abs(tx.amount))}
                                </span>
                              </td>
                              <td className="px-8 py-2.5 text-right text-sm">
                                <span className="font-semibold text-navy">
                                  {fmt(Math.abs(tx.runningBalance))}
                                </span>
                                <span className="ml-1 text-xs text-navy/50">{remainingLabel}</span>
                              </td>
                            </tr>
                          );
                        })}
                      </tbody>
                      <tfoot>
                        <tr className="border-t-2 border-surface-border bg-gray-50">
                          <td colSpan={3} className="px-8 py-3 text-sm font-bold text-navy">
                            Balance Due
                          </td>
                          <td />
                          <td
                            className={cn(
                              "px-8 py-3 text-right text-sm font-bold",
                              (statement?.outstandingAmount ?? 0) > 0
                                ? "text-danger"
                                : "text-success",
                            )}
                          >
                            {fmt(statement?.outstandingAmount ?? 0)}
                          </td>
                        </tr>
                      </tfoot>
                    </table>
                  </div>
                )}
              </div>
            </div>
          </div>

          {isRecordPaymentOpen && (
            <CustomerRecordPaymentModal
              customerId={id}
              customerName={customer.businessName}
              onClose={() => setIsRecordPaymentOpen(false)}
              // useRecordPaymentStandalone only invalidates ["invoices"]; the Open
              // Balance headline and the advance list on this tab live under
              // ["customers", id, …] and would otherwise stay stale.
              onSuccess={() => {
                void queryClient.invalidateQueries({ queryKey: ["customers", id] });
              }}
            />
          )}

          <Modal
            open={isAdvanceOpen}
            onClose={() => setIsAdvanceOpen(false)}
            title="Record Advance Payment"
            description="Record a pre-payment that can be applied to future invoices."
            footer={
              <>
                <Button
                  variant="secondary"
                  onClick={() => setIsAdvanceOpen(false)}
                  disabled={createAdvance.isPending}
                >
                  Cancel
                </Button>
                <Button
                  loading={createAdvance.isPending}
                  onClick={() => {
                    const amt = parseFloat(advanceForm.amount);
                    if (!amt || amt <= 0) return;
                    createAdvance.mutate(
                      {
                        customerId: id,
                        method: advanceForm.method,
                        amount: amt,
                        reference: advanceForm.reference || undefined,
                        notes: advanceForm.notes || undefined,
                      },
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
                <label className="mb-1.5 block text-sm font-medium text-navy/80">
                  Payment Method
                </label>
                <select
                  value={advanceForm.method}
                  onChange={(e) =>
                    setAdvanceForm((f) => ({
                      ...f,
                      method: e.target.value as SelectablePaymentMethod,
                    }))
                  }
                  className="h-10 w-full rounded-lg border border-surface-border bg-white px-3 text-sm text-navy focus:border-transparent focus:outline-none focus:ring-2 focus:ring-brand-500"
                >
                  {SELECTABLE_PAYMENT_METHODS.map((m) => (
                    <option key={m} value={m}>
                      {PAYMENT_METHOD_LABELS[m]}
                    </option>
                  ))}
                </select>
              </div>
              <div>
                <label className="mb-1.5 block text-sm font-medium text-navy/80">Amount ($)</label>
                <input
                  type="number"
                  step="0.01"
                  min="0.01"
                  placeholder="0.00"
                  value={advanceForm.amount}
                  onChange={(e) =>
                    setAdvanceForm((f) => ({
                      ...f,
                      amount: e.target.value,
                    }))
                  }
                  className="h-10 w-full rounded-lg border border-surface-border bg-white px-3 text-sm text-navy placeholder:text-navy/30 focus:border-transparent focus:outline-none focus:ring-2 focus:ring-brand-500"
                />
              </div>
              <div>
                <label className="mb-1.5 block text-sm font-medium text-navy/80">
                  Reference # (optional)
                </label>
                <input
                  type="text"
                  value={advanceForm.reference}
                  onChange={(e) =>
                    setAdvanceForm((f) => ({
                      ...f,
                      reference: e.target.value,
                    }))
                  }
                  className="h-10 w-full rounded-lg border border-surface-border bg-white px-3 text-sm text-navy placeholder:text-navy/30 focus:border-transparent focus:outline-none focus:ring-2 focus:ring-brand-500"
                />
              </div>
              <div>
                <label className="mb-1.5 block text-sm font-medium text-navy/80">
                  Notes (optional)
                </label>
                <textarea
                  rows={2}
                  value={advanceForm.notes}
                  onChange={(e) =>
                    setAdvanceForm((f) => ({
                      ...f,
                      notes: e.target.value,
                    }))
                  }
                  className="w-full resize-none rounded-lg border border-surface-border bg-white px-3 py-2 text-sm text-navy placeholder:text-navy/30 focus:border-transparent focus:outline-none focus:ring-2 focus:ring-brand-500"
                />
              </div>
            </div>
          </Modal>
        </Tabs.Content>

        {/* ── Special Prices tab ─────────────────────────────────── */}
        <SpecialPricesTab customerId={id} />

        {/* ── Comments tab ───────────────────────────────────────── */}
        <CommentsTab customerId={id} />

        {/* ── Documents tab ──────────────────────────────────────── */}
        <DocumentsTab customerId={id} />

        {/* ── Licenses & Authorizations tab (W6b) ────────────────── */}
        <AuthorizationsTab customerId={id} />
      </Tabs.Root>

      {/* Modals */}
      <CustomerFormModal
        isOpen={isEditOpen}
        onClose={() => setIsEditOpen(false)}
        mode="edit"
        initialData={customer}
      />
      <AddressFormModal
        isOpen={isAddAddressOpen}
        onClose={() => {
          setIsAddAddressOpen(false);
          setEditingAddress(null);
        }}
        onSave={handleSaveAddress}
        isSaving={editingAddress ? updateAddress.isPending : addAddress.isPending}
        mode={editingAddress ? "edit" : "add"}
        initialAddress={editingAddress ?? undefined}
      />
      <AssignRouteModal
        isOpen={isAssignRouteOpen}
        onClose={() => setIsAssignRouteOpen(false)}
        customerId={id}
        addresses={addresses.map((a: any) => ({
          id: a.id,
          label: a.label ?? "Address",
          line1: a.line1,
          city: a.city,
        }))}
        routesAccess={routesAccess}
      />
      <ContactPersonModal
        isOpen={isContactModalOpen}
        onClose={() => {
          setIsContactModalOpen(false);
          setEditingContact(null);
        }}
        customerId={id}
        editingContact={editingContact}
      />
      <AssignAgentModal
        isOpen={agentModalOpen}
        onClose={() => setAgentModalOpen(false)}
        customerId={id}
        hasSalesAgents={hasSalesAgents}
      />

      <ConfirmDialog
        open={pendingStatus !== null}
        onClose={() => setPendingStatus(null)}
        onConfirm={confirmStatusChange}
        title={
          pendingStatus === "SUSPENDED" ? "Suspend this customer?" : "Deactivate this customer?"
        }
        description={
          pendingStatus === "SUSPENDED"
            ? `${customer.businessName} will be suspended and will lose access to the platform.`
            : `${customer.businessName} will be marked as inactive.`
        }
        confirmLabel={pendingStatus === "SUSPENDED" ? "Yes, suspend" : "Yes, deactivate"}
        variant={pendingStatus === "SUSPENDED" ? "danger" : "secondary"}
        loading={updateStatus.isPending}
      />

      <StandingOrderModal
        isOpen={isStandingOrderOpen}
        onClose={() => {
          setIsStandingOrderOpen(false);
          setEditingTemplate(null);
        }}
        customerId={id}
        template={editingTemplate}
      />

      <ConfirmDialog
        open={!!deletingTemplateId}
        onClose={() => setDeletingTemplateId(null)}
        onConfirm={() => {
          if (!deletingTemplateId) return;
          deleteTemplate.mutate(
            { id: deletingTemplateId, customerId: id },
            { onSuccess: () => setDeletingTemplateId(null) },
          );
        }}
        title="Delete standing order?"
        description="This template and all its items will be deleted. Existing orders generated from this template will not be affected."
        confirmLabel="Yes, delete"
        variant="danger"
        loading={deleteTemplate.isPending}
      />

      <ConfirmDialog
        open={!!deletingContactId}
        onClose={() => setDeletingContactId(null)}
        onConfirm={() => {
          if (!deletingContactId) return;
          deleteContact.mutate(
            { customerId: id, contactId: deletingContactId },
            { onSuccess: () => setDeletingContactId(null) },
          );
        }}
        title="Delete contact person?"
        description="This contact person will be permanently removed from this customer."
        confirmLabel="Yes, delete"
        variant="danger"
        loading={deleteContact.isPending}
      />

      <ConfirmDialog
        open={declineConfirmOpen}
        onClose={() => setDeclineConfirmOpen(false)}
        onConfirm={() => {
          declinePortal.mutate(id, {
            onSuccess: () => {
              setDeclineConfirmOpen(false);
              setPortalMsg("Request declined.");
            },
          });
        }}
        title="Decline this request?"
        description={`Decline ${
          pendingRequester?.buyerName ?? "this buyer"
        }'s request? They will not be connected to this account.`}
        confirmLabel="Yes, decline"
        variant="danger"
        loading={declinePortal.isPending}
      />

      {/* ── Remove customer modal — reversible soft-delete with 8s Undo ── */}
      <Modal
        open={isDeleteOpen}
        onClose={() => setIsDeleteOpen(false)}
        title="Remove customer?"
        description={`${customer?.businessName ?? "This customer"}'s orders, invoices, and history are kept. You'll have a few seconds to undo, and you can restore the customer any time.`}
        footer={
          <>
            <Button variant="secondary" onClick={() => setIsDeleteOpen(false)}>
              Cancel
            </Button>
            <Button
              variant="danger"
              loading={softDeleteCustomer.isPending}
              onClick={handleDeleteCustomer}
            >
              Remove customer
            </Button>
          </>
        }
      >
        <p className="pt-2 text-sm text-navy/70">
          The customer stops appearing in lists and their portal access is paused. Nothing is
          erased.
        </p>
      </Modal>

      {/* ── Tax document lightbox — routed through DocumentViewer so a PDF tax-exempt
           document is viewable too, not just images ─────────────────────────────── */}
      <DocumentViewer doc={taxDocLightbox} onClose={() => setTaxDocLightbox(null)} />
    </div>
  );
}

/** `useSearchParams` (the `?tab=addresses` deep link the Edit Customer modal's
 *  honest "Addresses tab" link uses) needs a Suspense boundary above it — same
 *  wrapper `suppliers/[id]/page.tsx` uses for its `?paymentGroup=` deep link. */
export default function CustomerDetailPage() {
  const params = useParams();
  const id = params.id as string;
  return (
    <React.Suspense
      fallback={
        <div className="flex h-64 items-center justify-center">
          <div className="h-8 w-8 animate-spin rounded-full border-4 border-brand-500 border-t-transparent" />
        </div>
      }
    >
      <CustomerDetailPageInner id={id} />
    </React.Suspense>
  );
}
