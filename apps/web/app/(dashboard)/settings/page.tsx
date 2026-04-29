"use client";

import * as React from "react";
import * as Tabs from "@radix-ui/react-tabs";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import {
  Upload,
  CheckCircle2,
  Bell,
  Pencil,
  ToggleLeft,
  ToggleRight,
  Copy,
  Check,
  Building2,
  Users as UsersIcon,
  Download,
  Sparkles,
  Eye,
  EyeOff,
  ExternalLink,
  Trash2,
  BarChart3,
  Mail,
  Send,
  UserCircle,
  Link as LinkIcon,
  Monitor,
  Smartphone,
  Laptop,
  Globe,
  Clock,
  AlertTriangle,
  AlertCircle,
  Package,
  LogOut as LogOutIcon,
  Loader2,
  FileText,
  Truck,
} from "lucide-react";
import {
  Input,
  Textarea,
  Select,
  Button,
  Badge,
  Modal,
  Card,
  cn,
} from "@routeflow/ui/web";
import { useToast } from "@routeflow/ui/web";
import { usePageTitle } from "@/lib/page-title-context";
import { useUsers, useCreateOperator, useUpdateUser, useChangeUserStatus, useResetUserPassword, useToggleDriverPermit, AppUser } from "@/lib/api/users";
import { useNotificationsStatus, useSendTestNotification } from "@/lib/api/notifications";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { apiClient } from "@/lib/api-client";
import { AddressAutocomplete } from "@/components/AddressAutocomplete";
import { useImportProducts, type ZohoImportItem } from "@/lib/api/products";
import { useInvoiceSettings, useUpdateInvoiceSettings } from "@/lib/api/invoices";
import { useTenant } from "@/components/tenant-provider";

// ─── Helpers ──────────────────────────────────────────────────────────────────

function TabTrigger({
  value,
  icon,
  children,
}: {
  value: string;
  icon?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <Tabs.Trigger
      value={value}
      className={cn(
        "-mb-px flex items-center gap-2 border-b-2 px-5 py-3 text-sm font-medium transition-colors",
        "border-transparent text-navy/60 hover:text-navy",
        "data-[state=active]:border-brand-500 data-[state=active]:text-navy",
      )}
    >
      {icon && <span className="shrink-0">{icon}</span>}
      {children}
    </Tabs.Trigger>
  );
}

// ─── TAB 1: Business Profile ──────────────────────────────────────────────────

const profileSchema = z.object({
  ownerName: z.string().min(1, "Required"),
  phone: z.string().min(7, "Enter a valid phone number"),
  customerEmail: z.string().email("Enter a valid email").or(z.literal("")),
  street: z.string().min(1, "Required"),
  city: z.string().min(1, "Required"),
  state: z.string().optional(),
  zip: z.string().regex(/^\d{5}(-\d{4})?$/, "Enter a valid ZIP code"),
  taxRate: z.coerce.number().min(0).max(100),
});
type ProfileFormValues = z.infer<typeof profileSchema>;

function BusinessProfileTab() {
  const { toast } = useToast();
  const qc = useQueryClient();
  const { branding } = useTenant();
  const [logoPreview, setLogoPreview] = React.useState<string | null>(null);
  const fileInputRef = React.useRef<HTMLInputElement>(null);

  const { data: savedSettings } = useQuery({
    queryKey: ["settings"],
    queryFn: () => apiClient.get("/settings").then((r) => r.data),
  });

  const saveSettings = useMutation({
    mutationFn: (data: ProfileFormValues) => apiClient.patch("/settings", data).then((r) => r.data),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["settings"] });
      toast({ title: "Profile saved", description: "Your business profile has been updated.", variant: "success" });
    },
    onError: () => toast({ title: "Failed to save settings", variant: "error" }),
  });

  const { register, handleSubmit, reset, watch, setValue, formState: { errors, isSubmitting } } = useForm<ProfileFormValues>({
    resolver: zodResolver(profileSchema),
    defaultValues: {
      ownerName: "",
      phone: "",
      customerEmail: "",
      street: "",
      city: "",
      state: "",
      zip: "",
      taxRate: 0,
    },
  });

  React.useEffect(() => {
    if (savedSettings) {
      reset({
        ownerName: savedSettings.ownerName ?? "",
        phone: savedSettings.phone ?? "",
        customerEmail: savedSettings.customerEmail ?? "",
        street: savedSettings.street ?? "",
        city: savedSettings.city ?? "",
        state: savedSettings.state ?? "",
        zip: savedSettings.zip ?? "",
        taxRate: savedSettings.taxRate ?? 0,
      });
    }
  }, [savedSettings, reset]);

  const handleLogoChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const url = URL.createObjectURL(file);
    setLogoPreview(url);
  };

  const onSubmit = async (data: ProfileFormValues) => {
    await saveSettings.mutateAsync(data);
  };

  return (
    <form onSubmit={handleSubmit(onSubmit)} noValidate className="space-y-6">
      <Card title="Business Information">
        <div className="grid grid-cols-2 gap-4">
          <div className="flex flex-col gap-1">
            <label className="text-sm font-medium text-navy">Business Name</label>
            <div className="flex h-10 items-center rounded border border-surface-border bg-surface-raised px-3 text-sm text-navy/70">
              {savedSettings?.businessName || "Set by platform admin"}
            </div>
            <p className="text-xs text-navy/40">Managed by platform admin</p>
          </div>
          <Input label="Owner / Manager Name" register={register("ownerName")} error={errors.ownerName?.message} />
          <Input label="Phone" type="tel" register={register("phone")} error={errors.phone?.message} />
          <div className="flex flex-col gap-1">
            <label className="text-sm font-medium text-navy">Account Email</label>
            <div className="flex h-10 items-center rounded border border-surface-border bg-surface-raised px-3 text-sm text-navy/70">
              {savedSettings?.email || "Set by platform admin"}
            </div>
            <p className="text-xs text-navy/40">Used for RouteFlow communications. Managed by platform admin.</p>
          </div>
          <div className="col-span-2">
            <Input
              label="Customer-Facing Email"
              type="email"
              placeholder="invoices@yourbusiness.com"
              register={register("customerEmail")}
              error={errors.customerEmail?.message}
            />
            <p className="mt-1 text-xs text-navy/40">Used for invoices, order updates, and customer communications.</p>
          </div>
        </div>
      </Card>

      <Card title="Business Address">
        <div className="space-y-3">
          <AddressAutocomplete
            label="Street"
            placeholder="123 Main St — start typing for suggestions"
            value={watch("street") ?? ""}
            onChange={(v) => setValue("street", v, { shouldDirty: true })}
            onAddressSelect={({ street, city, state, zip }) => {
              setValue("street", street, { shouldDirty: true });
              setValue("city", city, { shouldDirty: true });
              setValue("state", state, { shouldDirty: true });
              setValue("zip", zip, { shouldDirty: true });
            }}
            error={errors.street?.message}
          />
          <div className="grid grid-cols-3 gap-3">
            <div className="col-span-2">
              <Input label="City" register={register("city")} error={errors.city?.message} />
            </div>
            <div>
              <Input label="State" placeholder="TX" register={register("state")} error={errors.state?.message} />
            </div>
          </div>
          <div className="w-40">
            <Input label="ZIP Code" register={register("zip")} error={errors.zip?.message} />
          </div>
        </div>
      </Card>

      <Card title="Logo">
        <div className="flex items-center gap-5">
          {/* Preview — local upload takes priority; otherwise show saved tenant logo */}
          <div className="flex h-20 w-20 shrink-0 items-center justify-center overflow-hidden rounded-xl border border-surface-border bg-surface-raised">
            {logoPreview ? (
              <img src={logoPreview} alt="Logo preview" className="h-full w-full object-cover" />
            ) : branding?.logoUrl ? (
              <img src={branding.logoUrl} alt={branding.businessName} className="h-full w-full object-contain p-2" />
            ) : (
              <img src="/logo.svg" alt="RouteFlow" className="h-10 w-10 object-contain" />
            )}
          </div>
          <div className="space-y-2">
            <p className="text-sm text-navy/60">Upload a PNG or SVG. Recommended size: 256 × 256 px.</p>
            <Button
              variant="secondary"
              size="sm"
              type="button"
              leftIcon={<Upload className="h-4 w-4" />}
              onClick={() => fileInputRef.current?.click()}
            >
              Choose File
            </Button>
            <input
              ref={fileInputRef}
              type="file"
              accept="image/png,image/svg+xml,image/jpeg"
              className="sr-only"
              onChange={handleLogoChange}
            />
          </div>
        </div>
      </Card>

      <Card title="Tax Settings">
        <div className="w-48">
          <div className="relative">
            <Input
              label="Default Tax Rate"
              type="number"
              step="0.01"
              min="0"
              max="100"
              register={register("taxRate")}
              error={errors.taxRate?.message}
            />
            <span className="absolute right-3 top-[34px] text-sm text-navy/40">%</span>
          </div>
        </div>
      </Card>

      <div className="flex justify-end">
        <Button type="submit" loading={isSubmitting}>Save Changes</Button>
      </div>
    </form>
  );
}

// ─── TAB 2: Notifications ─────────────────────────────────────────────────────

function NotificationsTab() {
  const { toast } = useToast();
  const { data: notificationsStatus } = useNotificationsStatus();
  const sendTest = useSendTestNotification();

  const handleTestNotification = () => {
    sendTest.mutate(undefined, {
      onSuccess: (result) => toast({
        title: "Test notification sent",
        description: `Sent to ${result.sent} of ${result.deviceCount} device(s).`,
        variant: "success",
      }),
      onError: (err) => toast({ title: "Failed", description: err.message, variant: "error" }),
    });
  };

  return (
    <div className="space-y-5">
      <Card title="Push Notifications">
        <div className="space-y-4">
          <div className="flex items-center justify-between rounded-lg border border-surface-border bg-surface-raised p-4">
            <div className="flex items-center gap-3">
              <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-brand-50">
                <Bell className="h-5 w-5 text-brand-500" />
              </div>
              <div>
                <p className="text-sm font-semibold text-navy">Driver App Notifications</p>
                <p className="text-xs text-navy/50">
                  {notificationsStatus?.configured
                    ? `${notificationsStatus.deviceCount} device(s) registered`
                    : "Push notifications are not configured"}
                </p>
              </div>
            </div>
            {notificationsStatus?.configured ? (
              <Badge variant="success" label="Active" />
            ) : (
              <Badge variant="warning" label="Not set up" />
            )}
          </div>

          {!notificationsStatus?.configured && (
            <div className="text-sm text-navy/60">
              <p>Push notifications allow drivers to receive real-time alerts for new orders and route assignments. Contact your system administrator to enable this feature.</p>
            </div>
          )}

          <Button
            variant="secondary"
            size="sm"
            leftIcon={<Bell className="h-4 w-4" />}
            loading={sendTest.isPending}
            disabled={!notificationsStatus?.configured}
            onClick={handleTestNotification}
          >
            Send Test Notification
          </Button>
        </div>
      </Card>
    </div>
  );
}

// ─── TAB 3: User Management ───────────────────────────────────────────────────

const addUserSchema = z.object({
  name: z.string().min(1, "Required"),
  role: z.enum(["OPERATOR", "DRIVER"]),
  username: z.string().min(3, "At least 3 characters").regex(/^[a-z0-9_.]+$/, "Lowercase letters, numbers, dots, underscores"),
  email: z.string().email("Enter a valid email"),
});
type AddUserFormValues = z.infer<typeof addUserSchema>;

function RoleBadge({ role }: { role: AppUser["role"] }) {
  if (role === "TENANT_ADMIN") return <Badge variant="info" label="Admin" />;
  return (
    <Badge
      variant={role === "OPERATOR" ? "info" : "neutral"}
      label={role === "OPERATOR" ? "Operator" : "Driver"}
    />
  );
}

function AddUserModal({ isOpen, onClose, onCreated }: {
  isOpen: boolean;
  onClose: () => void;
  onCreated: (tempPassword: string) => void;
}) {
  const createOperator = useCreateOperator();
  const [tempPassword, setTempPassword] = React.useState<string | null>(null);
  const [copied, setCopied] = React.useState(false);

  const { register, handleSubmit, watch, setValue, reset, formState: { errors, isSubmitting, touchedFields } } =
    useForm<AddUserFormValues>({
      resolver: zodResolver(addUserSchema),
      defaultValues: { role: "DRIVER" },
    });

  const nameValue = watch("name") ?? "";
  React.useEffect(() => {
    if (touchedFields.username) return;
    const parts = nameValue.trim().split(/\s+/);
    if (parts.length >= 2 && parts[0] && parts[parts.length - 1]) {
      setValue("username", `${parts[0][0].toLowerCase()}${parts[parts.length - 1].toLowerCase()}`);
    }
  }, [nameValue, touchedFields.username, setValue]);

  const handleClose = () => {
    setTempPassword(null);
    setCopied(false);
    reset();
    onClose();
  };

  const onSubmit = async (data: AddUserFormValues) => {
    const result = await createOperator.mutateAsync({
      name: data.name,
      email: data.email,
      username: data.username,
    });
    setTempPassword(result.tempPassword);
    onCreated(result.tempPassword);
  };

  const copyPw = async () => {
    if (!tempPassword) return;
    try { await navigator.clipboard.writeText(tempPassword); setCopied(true); setTimeout(() => setCopied(false), 2000); }
    catch { /* clipboard unavailable */ }
  };

  return (
    <Modal
      open={isOpen}
      onClose={handleClose}
      title={tempPassword ? "User Created" : "Add User"}
      description={
        tempPassword
          ? "Share the temporary password. The user will be prompted to change it on first login."
          : "Create a new operator or driver account."
      }
      footer={
        tempPassword ? (
          <Button onClick={handleClose}>Done</Button>
        ) : (
          <>
            <Button variant="secondary" type="button" onClick={handleClose}>Cancel</Button>
            <Button type="submit" form="add-user-form" loading={isSubmitting || createOperator.isPending}>Create User</Button>
          </>
        )
      }
    >
      {tempPassword ? (
        <div className="flex flex-col items-center gap-5 py-4">
          <div className="flex h-14 w-14 items-center justify-center rounded-full bg-success-bg">
            <CheckCircle2 className="h-7 w-7 text-success" />
          </div>
          <div className="w-full space-y-2 text-center">
            <p className="text-sm font-medium text-navy">Temporary password</p>
            <div className="flex items-center justify-center gap-2">
              <code className="rounded-lg border border-surface-border bg-surface-raised px-4 py-2 font-mono text-lg font-bold tracking-widest text-navy">
                {tempPassword}
              </code>
              <button onClick={copyPw} title="Copy" className="rounded p-2 text-navy/40 hover:bg-surface-raised hover:text-navy transition-colors">
                {copied ? <Check className="h-4 w-4 text-success" /> : <Copy className="h-4 w-4" />}
              </button>
            </div>
          </div>
        </div>
      ) : (
        <form id="add-user-form" onSubmit={handleSubmit(onSubmit)} noValidate className="space-y-4">
          {createOperator.error && (
            <p className="text-sm text-danger">{createOperator.error.message}</p>
          )}
          <Input label="Full Name" placeholder="Jane Smith" register={register("name")} error={errors.name?.message} />
          <Select
            label="Role"
            options={[
              { value: "DRIVER", label: "Driver" },
              { value: "OPERATOR", label: "Operator" },
            ]}
            register={register("role")}
            error={errors.role?.message}
          />
          <Input label="Username" placeholder="jsmith" register={register("username")} error={errors.username?.message} />
          <Input label="Email" type="email" placeholder="jane@example.com" register={register("email")} error={errors.email?.message} />
        </form>
      )}
    </Modal>
  );
}

// ─── Edit User Modal ──────────────────────────────────────────────────────────

const editUserSchema = z.object({
  username: z.string().min(3, "At least 3 characters").regex(/^[a-z0-9_.]+$/, "Lowercase letters, numbers, dots, underscores"),
  email: z.string().email("Enter a valid email"),
  role: z.enum(["OPERATOR", "DRIVER"]),
});
type EditUserFormValues = z.infer<typeof editUserSchema>;

function EditUserModal({
  isOpen,
  onClose,
  user,
}: {
  isOpen: boolean;
  onClose: () => void;
  user: AppUser | null;
}) {
  const updateUser = useUpdateUser();
  const resetPassword = useResetUserPassword();
  const { toast } = useToast();
  const [tempPassword, setTempPassword] = React.useState<string | null>(null);
  const [copied, setCopied] = React.useState(false);

  const { register, handleSubmit, reset, formState: { errors, isSubmitting } } =
    useForm<EditUserFormValues>({
      resolver: zodResolver(editUserSchema),
    });

  React.useEffect(() => {
    if (isOpen && user) {
      const role = user.role === "OPERATOR" || user.role === "DRIVER" ? user.role : "OPERATOR";
      reset({ username: user.username, email: user.email, role });
      setTempPassword(null);
      setCopied(false);
    }
  }, [isOpen, user, reset]);

  const onSubmit = async (data: EditUserFormValues) => {
    if (!user) return;
    await updateUser.mutateAsync(
      { id: user.id, username: data.username, email: data.email, role: data.role },
      {
        onSuccess: () => {
          toast({ title: "User updated", variant: "success" });
          onClose();
        },
        onError: (err) =>
          toast({ title: "Update failed", description: err.message, variant: "error" }),
      },
    );
  };

  const handleResetPassword = () => {
    if (!user) return;
    resetPassword.mutate(user.id, {
      onSuccess: (result) => setTempPassword(result.tempPassword),
      onError: () => toast({ title: "Failed to reset password", variant: "error" }),
    });
  };

  const copyPw = async () => {
    if (!tempPassword) return;
    try { await navigator.clipboard.writeText(tempPassword); setCopied(true); setTimeout(() => setCopied(false), 2000); }
    catch { /* clipboard unavailable */ }
  };

  return (
    <Modal
      open={isOpen}
      onClose={onClose}
      title="Edit User"
      description="Update the user's details or reset their password."
      footer={
        <>
          <Button variant="secondary" type="button" onClick={onClose}>Cancel</Button>
          <Button type="submit" form="edit-user-form" loading={isSubmitting || updateUser.isPending}>
            Save Changes
          </Button>
        </>
      }
    >
      <form id="edit-user-form" onSubmit={handleSubmit(onSubmit)} noValidate className="space-y-4">
        {updateUser.error && (
          <p className="text-sm text-danger">{updateUser.error.message}</p>
        )}
        {user?.role === "TENANT_ADMIN" ? (
          <div>
            <label className="mb-1 block text-sm font-medium text-navy">Role</label>
            <div className="flex h-10 items-center rounded-md border border-surface-border bg-surface-secondary px-3 text-sm text-navy/60">
              Admin
            </div>
            <p className="mt-1 text-xs text-navy/40">Tenant admin role cannot be changed.</p>
          </div>
        ) : (
          <Select
            label="Role"
            options={[
              { value: "DRIVER", label: "Driver" },
              { value: "OPERATOR", label: "Operator" },
            ]}
            register={register("role")}
            error={errors.role?.message}
          />
        )}
        <Input
          label="Username"
          placeholder="jsmith"
          register={register("username")}
          error={errors.username?.message}
        />
        <Input
          label="Email"
          type="email"
          placeholder="jane@example.com"
          register={register("email")}
          error={errors.email?.message}
        />
      </form>

      {/* Password reset section */}
      <div className="mt-4 border-t border-surface-border pt-4">
        {tempPassword ? (
          <div className="space-y-2">
            <p className="text-xs font-medium text-navy">New temporary password — share with user:</p>
            <div className="flex items-center gap-2">
              <code className="flex-1 rounded border border-surface-border bg-surface-raised px-3 py-1.5 font-mono text-sm font-bold tracking-widest text-navy">
                {tempPassword}
              </code>
              <button onClick={copyPw} title="Copy" className="rounded p-1.5 text-navy/40 hover:bg-surface-raised hover:text-navy transition-colors">
                {copied ? <Check className="h-4 w-4 text-success" /> : <Copy className="h-4 w-4" />}
              </button>
            </div>
          </div>
        ) : (
          <Button
            variant="secondary"
            size="sm"
            loading={resetPassword.isPending}
            onClick={handleResetPassword}
          >
            Reset Password
          </Button>
        )}
      </div>
    </Modal>
  );
}

function UserManagementTab() {
  const { data, isLoading } = useUsers();
  const changeStatus = useChangeUserStatus();
  const [isAddOpen, setIsAddOpen] = React.useState(false);
  const [editingUser, setEditingUser] = React.useState<AppUser | null>(null);
  const { toast } = useToast();

  const users = data?.data ?? [];

  const toggleStatus = (user: AppUser) => {
    const nextStatus = user.status === "ACTIVE" ? "INACTIVE" : "ACTIVE";
    changeStatus.mutate(
      { id: user.id, status: nextStatus },
      {
        onError: () => toast({ title: "Failed to update status", variant: "error" }),
      },
    );
  };

  const handleCreated = (_tempPassword: string) => {
    // Users list is invalidated automatically by useCreateOperator onSuccess
  };

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <p className="text-sm text-navy/60">
          {isLoading ? "Loading..." : `${data?.meta.total ?? 0} users total`}
        </p>
        <Button size="sm" onClick={() => setIsAddOpen(true)}>Add User</Button>
      </div>

      <div className="overflow-hidden rounded-lg border border-surface-border bg-white">
        <table className="w-full text-sm">
          <thead className="border-b border-surface-border bg-surface-raised">
            <tr>
              <th className="px-4 py-3 text-left text-xs font-medium text-navy/60">Username</th>
              <th className="px-4 py-3 text-left text-xs font-medium text-navy/60">Email</th>
              <th className="px-4 py-3 text-left text-xs font-medium text-navy/60">Role</th>
              <th className="px-4 py-3 text-left text-xs font-medium text-navy/60">Status</th>
              <th className="px-4 py-3 text-left text-xs font-medium text-navy/60">Created</th>
              <th className="px-4 py-3" />
            </tr>
          </thead>
          <tbody className="divide-y divide-surface-border">
            {isLoading ? (
              <tr>
                <td colSpan={6} className="px-4 py-8 text-center text-sm text-navy/40">
                  Loading users...
                </td>
              </tr>
            ) : users.length === 0 ? (
              <tr>
                <td colSpan={6} className="px-4 py-8 text-center text-sm text-navy/40">
                  No users found.
                </td>
              </tr>
            ) : (
              users.map((user) => (
                <tr key={user.id} className="hover:bg-surface-raised transition-colors">
                  <td className="px-4 py-3 font-mono text-xs text-navy/70">{user.username}</td>
                  <td className="px-4 py-3 text-navy/70">{user.email}</td>
                  <td className="px-4 py-3"><RoleBadge role={user.role} /></td>
                  <td className="px-4 py-3">
                    <Badge status={user.status === "ACTIVE" ? "ACTIVE" : "INACTIVE"} />
                  </td>
                  <td className="px-4 py-3 text-navy/60">
                    {new Date(user.createdAt).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" })}
                  </td>
                  <td className="px-4 py-3">
                    <div className="flex items-center gap-1 justify-end">
                      <button
                        title="Edit user"
                        onClick={() => setEditingUser(user)}
                        className="rounded p-1.5 text-navy/40 hover:bg-surface-raised hover:text-navy transition-colors"
                      >
                        <Pencil className="h-4 w-4" />
                      </button>
                      <button
                        title={user.status === "ACTIVE" ? "Deactivate" : "Activate"}
                        onClick={() => toggleStatus(user)}
                        disabled={changeStatus.isPending}
                        className={cn(
                          "rounded p-1.5 transition-colors disabled:opacity-50",
                          user.status === "ACTIVE"
                            ? "text-success hover:bg-success-bg"
                            : "text-navy/30 hover:bg-surface-raised hover:text-navy",
                        )}
                      >
                        {user.status === "ACTIVE" ? (
                          <ToggleRight className="h-4 w-4" />
                        ) : (
                          <ToggleLeft className="h-4 w-4" />
                        )}
                      </button>
                    </div>
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>

      <AddUserModal
        isOpen={isAddOpen}
        onClose={() => setIsAddOpen(false)}
        onCreated={handleCreated}
      />

      <EditUserModal
        isOpen={!!editingUser}
        onClose={() => setEditingUser(null)}
        user={editingUser}
      />
    </div>
  );
}

// ─── TAB 4: Import ────────────────────────────────────────────────────────────

// ── Zoho CSV parser (products) ──────────────────────────────────────────────

function splitCsvRows(text: string): string[] {
  const rows: string[] = [];
  let current = "";
  let inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch === '"') {
      if (inQuotes && text[i + 1] === '"') { current += '"'; i++; }
      else { inQuotes = !inQuotes; current += ch; }
    } else if ((ch === "\r" || ch === "\n") && !inQuotes) {
      if (ch === "\r" && text[i + 1] === "\n") i++;
      if (current.trim()) rows.push(current);
      current = "";
    } else { current += ch; }
  }
  if (current.trim()) rows.push(current);
  return rows;
}

function parseCSVLine(line: string): string[] {
  const result: string[] = [];
  let current = "";
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') {
      if (inQuotes && line[i + 1] === '"') { current += '"'; i++; }
      else { inQuotes = !inQuotes; }
    } else if (ch === "," && !inQuotes) { result.push(current); current = ""; }
    else { current += ch; }
  }
  result.push(current);
  return result;
}

function parseZohoCsv(text: string): ZohoImportItem[] {
  const rows = splitCsvRows(text);
  if (rows.length < 2) return [];
  const headers = parseCSVLine(rows[0].replace(/^\uFEFF/, ""));
  const colAlt = (row: string[], ...keys: string[]): string => {
    for (const key of keys) {
      const idx = headers.indexOf(key);
      if (idx >= 0) return (row[idx] ?? "").trim();
    }
    return "";
  };
  const parsePrice = (raw: string): string | undefined => {
    const cleaned = raw.replace(/^USD\s*/i, "").replace(/,/g, "").trim();
    const num = parseFloat(cleaned);
    return isNaN(num) ? undefined : num.toFixed(2);
  };
  const items: ZohoImportItem[] = [];
  for (let i = 1; i < rows.length; i++) {
    const row = parseCSVLine(rows[i]);
    if (row.every((c) => c === "")) continue;
    const name = colAlt(row, "Item Name");
    if (!name) continue;
    const pricePerUnit = parsePrice(colAlt(row, "Selling Price", "Rate"));
    if (!pricePerUnit) continue;
    const unit = colAlt(row, "Unit Name", "Unit", "Usage unit") || "pcs";
    const rawSku = colAlt(row, "SKU");
    const sku = rawSku || undefined;
    const upc = colAlt(row, "UPC");
    const ean = colAlt(row, "EAN");
    const skuLooksLikeBarcode = !!rawSku && /^\d{8,14}$/.test(rawSku);
    const barcode = upc || ean || (skuLooksLikeBarcode ? rawSku : undefined) || undefined;
    const description = colAlt(row, "Sales Description", "Description") || undefined;
    const category = colAlt(row, "Category Name") || undefined;
    const statusRaw = colAlt(row, "Status");
    const isActive = statusRaw === "" ? true : statusRaw.toLowerCase() === "active";
    const stockRaw = colAlt(row, "Stock On Hand", "Opening Stock");
    const stockNum = parseFloat(stockRaw.replace(/,/g, ""));
    const currentStock = !isNaN(stockNum) ? stockNum.toFixed(3) : undefined;
    const averageCost = parsePrice(colAlt(row, "Purchase Price"));
    const reorderNum = parseInt(colAlt(row, "Reorder Level"), 10);
    const reorderPoint = !isNaN(reorderNum) ? reorderNum : undefined;
    items.push({ name, sku, barcode, unit, pricePerUnit, category, description, isActive, currentStock, averageCost, reorderPoint });
  }
  return items;
}

// ── Products import card ────────────────────────────────────────────────────

type ProductImportRow = { row: number; name: string; reason: string };

function ProductsImportCard() {
  const importProducts = useImportProducts();
  const { toast } = useToast();
  const [parsedItems, setParsedItems] = React.useState<ZohoImportItem[]>([]);
  const [parseError, setParseError] = React.useState<string | null>(null);
  const [fileName, setFileName] = React.useState<string>("");
  const [result, setResult] = React.useState<{ created: number; skipped: number; errors: ProductImportRow[] } | null>(null);
  const [showErrors, setShowErrors] = React.useState(false);
  const fileRef = React.useRef<HTMLInputElement>(null);

  const handleFile = (file: File) => {
    if (!file.name.endsWith(".csv")) {
      setParseError("Please upload a .csv file exported from Zoho.");
      return;
    }
    setParseError(null);
    setResult(null);
    setParsedItems([]);
    setFileName(file.name);
    const reader = new FileReader();
    reader.onload = (e) => {
      try {
        const items = parseZohoCsv(e.target?.result as string);
        if (items.length === 0) {
          setParseError("No valid items found. Make sure you exported Items from Zoho Inventory.");
          return;
        }
        setParsedItems(items);
      } catch {
        setParseError("Failed to parse CSV. Please check the file format.");
      }
    };
    reader.readAsText(file);
  };

  const handleImport = async () => {
    try {
      const res = await importProducts.mutateAsync(parsedItems);
      setResult(res);
      toast({ title: "Products imported", description: `${res.created} created, ${res.skipped} skipped`, variant: "success" });
    } catch (err: unknown) {
      toast({ title: "Import failed", description: (err as { message?: string })?.message ?? "Please try again", variant: "error" });
    }
  };

  return (
    <div className="col-span-2 rounded-xl border border-surface-border bg-white overflow-hidden">
      <div className="flex items-center gap-3 border-b border-surface-border p-4">
        <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg text-brand-500 bg-brand-50">
          <Package className="h-5 w-5" />
        </span>
        <div className="flex-1 min-w-0">
          <p className="font-semibold text-navy">Products (Items)</p>
          <p className="text-xs text-navy/60">Import products and pricing from Zoho Inventory Items CSV export</p>
        </div>
        {result && (
          <div className="flex items-center gap-1.5 text-xs shrink-0">
            <span className="flex items-center gap-1 text-success"><CheckCircle2 className="h-3.5 w-3.5" />{result.created} created</span>
            {result.skipped > 0 && <span className="flex items-center gap-1 text-warning ml-2"><Bell className="h-3.5 w-3.5" />{result.skipped} skipped</span>}
          </div>
        )}
      </div>
      <div className="p-4 space-y-3">
        <div className="flex items-start gap-2 rounded-lg bg-surface-raised px-3 py-2 text-xs text-navy/60">
          <Bell className="h-3.5 w-3.5 mt-0.5 shrink-0 text-navy/40" />
          <span><strong className="text-navy/70">How to export:</strong> Zoho Inventory → Items → ☰ → Export Items → CSV</span>
        </div>
        <div
          onDrop={(e) => { e.preventDefault(); const f = e.dataTransfer.files[0]; if (f) handleFile(f); }}
          onDragOver={(e) => e.preventDefault()}
          onClick={() => fileRef.current?.click()}
          className={cn(
            "flex flex-col items-center justify-center gap-2 rounded-lg border-2 border-dashed p-6 cursor-pointer transition-colors",
            parsedItems.length > 0 ? "border-brand-300 bg-brand-50" : "border-surface-border hover:border-brand-300 hover:bg-brand-50/30",
          )}
        >
          <input ref={fileRef} type="file" accept=".csv" className="hidden" onChange={(e) => { const f = e.target.files?.[0]; if (f) handleFile(f); }} />
          <Upload className={cn("h-6 w-6", parsedItems.length > 0 ? "text-brand-500" : "text-navy/30")} />
          {parsedItems.length > 0 ? (
            <div className="text-center">
              <p className="text-sm font-medium text-brand-600">{fileName}</p>
              <p className="text-xs text-navy/40">{parsedItems.length} items parsed · Click to change file</p>
            </div>
          ) : (
            <div className="text-center">
              <p className="text-sm text-navy/60">Drop Zoho Items CSV here or <span className="text-brand-500">browse</span></p>
              <p className="text-xs text-navy/40 mt-0.5">Zoho Inventory CSV export format</p>
            </div>
          )}
        </div>
        {parseError && (
          <div className="flex items-start gap-2 rounded-lg border border-danger/30 bg-danger-bg p-3 text-sm text-danger">
            <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
            {parseError}
          </div>
        )}
        {parsedItems.length > 0 && !result && (
          <div className="rounded-lg border border-surface-border overflow-hidden">
            <div className="border-b border-surface-border px-3 py-2 bg-surface-raised">
              <p className="text-xs font-medium text-navy/70">{parsedItems.length} items ready — preview:</p>
            </div>
            <div className="overflow-auto max-h-48">
              <table className="min-w-full text-xs">
                <thead className="sticky top-0 bg-surface-raised border-b border-surface-border">
                  <tr>
                    {["Name", "SKU", "Barcode", "Unit", "Price", "Category", "Stock"].map((h) => (
                      <th key={h} className="px-3 py-2 text-left font-semibold text-navy/70 whitespace-nowrap">{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {parsedItems.map((item, i) => (
                    <tr key={i} className="border-b border-surface-border hover:bg-surface-raised">
                      <td className="px-3 py-2 font-medium text-navy max-w-[200px] truncate" title={item.name}>{item.name}</td>
                      <td className="px-3 py-2 text-navy/70">{item.sku ?? "—"}</td>
                      <td className="px-3 py-2 text-navy/70">{item.barcode ?? "—"}</td>
                      <td className="px-3 py-2 text-navy/70">{item.unit}</td>
                      <td className="px-3 py-2 text-navy/70">${item.pricePerUnit}</td>
                      <td className="px-3 py-2 text-navy/70">{item.category ?? "—"}</td>
                      <td className="px-3 py-2 text-navy/70">{item.currentStock ?? "0"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )}
        <button
          onClick={handleImport}
          disabled={parsedItems.length === 0 || importProducts.isPending || !!result}
          className="w-full rounded-lg bg-brand-500 py-2 text-sm font-medium text-white hover:bg-brand-600 disabled:opacity-40 transition-colors"
        >
          {importProducts.isPending ? (
            <span className="flex items-center justify-center gap-2">
              <div className="h-4 w-4 animate-spin rounded-full border-2 border-white border-t-transparent" />
              Importing...
            </span>
          ) : result ? "Import complete ✓" : parsedItems.length > 0 ? `Import ${parsedItems.length} Items` : "Import Products (Items)"}
        </button>
        {result && result.errors.length > 0 && (
          <div className="rounded-lg border border-warning/30 bg-warning-bg/50 px-3 py-2">
            <button
              onClick={() => setShowErrors((v) => !v)}
              className="flex w-full items-center justify-between text-xs font-medium text-warning"
            >
              <span>{result.errors.length} error{result.errors.length > 1 ? "s" : ""} during import</span>
              {showErrors ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}
            </button>
            {showErrors && (
              <ul className="mt-2 space-y-0.5 text-xs text-navy/60 max-h-32 overflow-y-auto">
                {result.errors.slice(0, 20).map((e, i) => (
                  <li key={i} className="truncate">• Row {e.row}: {e.name} — {e.reason}</li>
                ))}
                {result.errors.length > 20 && <li className="text-navy/40">...and {result.errors.length - 20} more</li>}
              </ul>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

const IMPORT_SECTIONS = [
  {
    id: "contacts",
    label: "Customers (Contacts)",
    description: "Import customers from Zoho Contacts CSV export",
    endpoint: "/import/contacts",
    icon: UsersIcon,
    color: "text-brand-500 bg-brand-50",
    zohoExportPath: "Zoho Invoices → Contacts → ⋮ → Export Contacts",
  },
  {
    id: "inventory",
    label: "Inventory Stock Levels",
    description: "Sync current stock quantities from Zoho Stock Summary Report (Item Name, SKU, Closing Stock)",
    endpoint: "/import/inventory",
    icon: BarChart3,
    color: "text-teal-500 bg-teal-50",
    zohoExportPath: "Zoho Inventory → Reports → Stock Summary → Export as CSV",
  },
  {
    id: "invoices",
    label: "Invoices",
    description: "Import invoices and line items from Zoho Invoice CSV export",
    endpoint: "/import/invoices",
    icon: Upload,
    color: "text-orange-500 bg-orange-50",
    zohoExportPath: "Zoho Invoices → Invoices → ⋮ → Export Invoices",
  },
  {
    id: "payments",
    label: "Customer Payments",
    description: "Import payment history from Zoho Customer Payments CSV",
    endpoint: "/import/payments",
    icon: CheckCircle2,
    color: "text-success bg-success-bg",
    zohoExportPath: "Zoho Invoices → Customer Payments → ⋮ → Export",
  },
  {
    id: "expenses",
    label: "Expenses",
    description: "Import expense records from Zoho Expense CSV export",
    endpoint: "/import/expenses",
    icon: Building2,
    color: "text-danger bg-danger-bg",
    zohoExportPath: "Zoho Expense → My Expenses → Export",
  },
] as const;

interface ImportResult {
  imported?: number;
  updated?: number;
  created?: number;
  skipped: number;
  errors: string[];
}

function ImportCard({ section }: { section: typeof IMPORT_SECTIONS[number] }) {
  const { toast } = useToast();
  const [file, setFile] = React.useState<File | null>(null);
  const [result, setResult] = React.useState<ImportResult | null>(null);
  const [loading, setLoading] = React.useState(false);
  const [showErrors, setShowErrors] = React.useState(false);
  const inputRef = React.useRef<HTMLInputElement>(null);
  const Icon = section.icon;

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const f = e.target.files?.[0];
    if (f) { setFile(f); setResult(null); setShowErrors(false); }
  };

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault();
    const f = e.dataTransfer.files?.[0];
    if (f && f.name.endsWith(".csv")) { setFile(f); setResult(null); }
  };

  const handleImport = async () => {
    if (!file) return;
    setLoading(true);
    try {
      const formData = new FormData();
      formData.append("file", file);
      const res = await apiClient.post(section.endpoint, formData, {
        headers: { "Content-Type": "multipart/form-data" },
        timeout: 300_000,
      });
      setResult(res.data);
      // Inventory returns { updated, created, skipped }; others return { imported, skipped }
      const total = res.data.imported ?? ((res.data.updated ?? 0) + (res.data.created ?? 0));
      const detail = res.data.updated !== undefined
        ? `${res.data.updated} updated, ${res.data.created ?? 0} new, ${res.data.skipped} skipped`
        : `${total} imported, ${res.data.skipped} skipped`;
      toast({ title: `${section.label} imported`, description: detail, variant: "success" });
    } catch (err: any) {
      toast({ title: "Import failed", description: err?.response?.data?.message ?? "Please check your file format and try again", variant: "error" });
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="rounded-xl border border-surface-border bg-white overflow-hidden">
      <div className="flex items-center gap-3 border-b border-surface-border p-4">
        <span className={cn("flex h-10 w-10 shrink-0 items-center justify-center rounded-lg", section.color)}>
          <Icon className="h-5 w-5" />
        </span>
        <div className="flex-1 min-w-0">
          <p className="font-semibold text-navy">{section.label}</p>
          <p className="text-xs text-navy/60">{section.description}</p>
        </div>
        {result && (
          <div className="flex items-center gap-1.5 text-xs shrink-0">
            {result.updated !== undefined ? (
              <>
                <span className="flex items-center gap-1 text-success"><CheckCircle2 className="h-3.5 w-3.5" />{result.updated} updated</span>
                {(result.created ?? 0) > 0 && <span className="flex items-center gap-1 text-brand-500 ml-1">+{result.created} new</span>}
              </>
            ) : (
              <span className="flex items-center gap-1 text-success"><CheckCircle2 className="h-3.5 w-3.5" />{result.imported ?? 0} imported</span>
            )}
            {result.skipped > 0 && <span className="flex items-center gap-1 text-warning ml-2"><Bell className="h-3.5 w-3.5" />{result.skipped} skipped</span>}
          </div>
        )}
      </div>
      <div className="p-4 space-y-3">
        <div className="flex items-start gap-2 rounded-lg bg-surface-raised px-3 py-2 text-xs text-navy/60">
          <Bell className="h-3.5 w-3.5 mt-0.5 shrink-0 text-navy/40" />
          <span><strong className="text-navy/70">How to export:</strong> {section.zohoExportPath}</span>
        </div>
        <div
          onDrop={handleDrop}
          onDragOver={(e) => e.preventDefault()}
          onClick={() => inputRef.current?.click()}
          className={cn(
            "flex flex-col items-center justify-center gap-2 rounded-lg border-2 border-dashed p-6 cursor-pointer transition-colors",
            file ? "border-brand-300 bg-brand-50" : "border-surface-border hover:border-brand-300 hover:bg-brand-50/30",
          )}
        >
          <input ref={inputRef} type="file" accept=".csv" className="hidden" onChange={handleFileChange} />
          <Upload className={cn("h-6 w-6", file ? "text-brand-500" : "text-navy/30")} />
          {file ? (
            <div className="text-center">
              <p className="text-sm font-medium text-brand-600">{file.name}</p>
              <p className="text-xs text-navy/40">{(file.size / 1024).toFixed(1)} KB · Click to change</p>
            </div>
          ) : (
            <div className="text-center">
              <p className="text-sm text-navy/60">Drop CSV file here or <span className="text-brand-500">browse</span></p>
              <p className="text-xs text-navy/40 mt-0.5">Zoho CSV export format</p>
            </div>
          )}
        </div>
        <button
          onClick={handleImport}
          disabled={!file || loading}
          className="w-full rounded-lg bg-brand-500 py-2 text-sm font-medium text-white hover:bg-brand-600 disabled:opacity-40 transition-colors"
        >
          {loading ? (
            <span className="flex items-center justify-center gap-2">
              <div className="h-4 w-4 animate-spin rounded-full border-2 border-white border-t-transparent" />
              Importing... (this may take a moment)
            </span>
          ) : `Import ${section.label}`}
        </button>
        {result && result.errors.length > 0 && (
          <div className="rounded-lg border border-warning/30 bg-warning-bg/50 px-3 py-2">
            <button
              onClick={() => setShowErrors((v) => !v)}
              className="flex w-full items-center justify-between text-xs font-medium text-warning"
            >
              <span>{result.errors.length} error{result.errors.length > 1 ? "s" : ""} during import</span>
              {showErrors ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}
            </button>
            {showErrors && (
              <ul className="mt-2 space-y-0.5 text-xs text-navy/60 max-h-32 overflow-y-auto">
                {result.errors.slice(0, 20).map((e, i) => <li key={i} className="truncate">• {e}</li>)}
                {result.errors.length > 20 && <li className="text-navy/40">...and {result.errors.length - 20} more</li>}
              </ul>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

function ImportTab() {
  return (
    <div className="space-y-6 py-6">
      <div>
        <h2 className="text-lg font-semibold text-navy">Import from Zoho</h2>
        <p className="mt-1 text-sm text-navy/60">
          Import your data from Zoho exports. Follow the order below for best results:{" "}
          <strong className="text-navy">Customers → Inventory → Invoices → Payments → Expenses</strong>
        </p>
      </div>
      <div className="flex items-center gap-3 rounded-xl bg-brand-50 border border-brand-200 px-4 py-3">
        <Bell className="h-4 w-4 text-brand-500 shrink-0" />
        <p className="text-sm text-brand-700">
          <strong>Recommended import order:</strong> Products → Customers → Inventory → Invoices → Payments → Expenses.
          Payments require matching invoices; Invoices require customers to exist first.
        </p>
      </div>
      <div className="grid grid-cols-2 gap-5">
        <ProductsImportCard />
        {IMPORT_SECTIONS.map((section) => (
          <ImportCard key={section.id} section={section} />
        ))}
      </div>
    </div>
  );
}

// ─── TAB 5: AI & Integrations ─────────────────────────────────────────────────

function AIIntegrationsTab() {
  const { toast } = useToast();
  const qc = useQueryClient();
  const [showKey, setShowKey] = React.useState(false);
  const [keyInput, setKeyInput] = React.useState("");
  const [isEditing, setIsEditing] = React.useState(false);

  const { data: anthropicStatus, isLoading } = useQuery({
    queryKey: ["settings", "anthropic"],
    queryFn: () => apiClient.get("/settings/anthropic").then((r) => r.data),
  });

  const saveKey = useMutation({
    mutationFn: (apiKey: string) =>
      apiClient.patch("/settings/anthropic", { apiKey }).then((r) => r.data),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["settings", "anthropic"] });
      setKeyInput("");
      setIsEditing(false);
      toast({ title: "API key saved", description: "Claude AI scanning is now active.", variant: "success" });
    },
    onError: () => toast({ title: "Failed to save API key", variant: "error" }),
  });

  const removeKey = useMutation({
    mutationFn: () =>
      apiClient.patch("/settings/anthropic", { apiKey: "" }).then((r) => r.data),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["settings", "anthropic"] });
      toast({ title: "API key removed", variant: "success" });
    },
    onError: () => toast({ title: "Failed to remove key", variant: "error" }),
  });

  const isConfigured = anthropicStatus?.configured === true;
  const keyPreview = anthropicStatus?.keyPreview ?? null;

  return (
    <div className="space-y-5">
      <Card title="Claude AI (Invoice Scanner)">
        <div className="space-y-5">
          {/* Status row */}
          <div className="flex items-center justify-between rounded-lg border border-surface-border bg-surface-raised p-4">
            <div className="flex items-center gap-3">
              <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-gradient-to-br from-[#CC785C] to-[#E8936A] font-bold text-white text-sm">
                AI
              </div>
              <div>
                <p className="text-sm font-semibold text-navy">Anthropic Claude</p>
                <p className="text-xs text-navy/50">
                  {isLoading
                    ? "Checking status..."
                    : isConfigured
                    ? `Key configured${keyPreview ? ` · ${keyPreview}` : ""}`
                    : "No API key configured"}
                </p>
              </div>
            </div>
            {isConfigured ? (
              <Badge variant="success" label="Active" />
            ) : (
              <Badge variant="warning" label="Not configured" />
            )}
          </div>

          {/* Description */}
          <div className="text-sm text-navy/60 space-y-1">
            <p>
              RouteFlow uses Claude to intelligently extract supplier names, invoice numbers, line items,
              and totals from scanned documents — saving manual data entry.
            </p>
            <p>
              Each operator uses their own API key so AI costs are billed directly to your Anthropic account.
            </p>
          </div>

          {/* Get key link */}
          <a
            href="https://console.anthropic.com/settings/keys"
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-1.5 text-sm font-medium text-brand-500 hover:text-brand-600 transition-colors"
          >
            <ExternalLink className="h-3.5 w-3.5" />
            Get your API key from console.anthropic.com
          </a>

          {/* Key input */}
          {!isEditing && !isConfigured ? (
            <Button
              variant="secondary"
              size="sm"
              leftIcon={<Sparkles className="h-4 w-4" />}
              onClick={() => setIsEditing(true)}
            >
              Add API Key
            </Button>
          ) : isEditing ? (
            <div className="space-y-3">
              <div className="relative">
                <input
                  type={showKey ? "text" : "password"}
                  value={keyInput}
                  onChange={(e) => setKeyInput(e.target.value)}
                  placeholder="sk-ant-api03-..."
                  className="h-10 w-full rounded border border-surface-border bg-white px-3 pr-10 text-sm font-mono text-navy placeholder:text-navy/30 focus:border-brand-500 focus:outline-none focus:ring-2 focus:ring-brand-500"
                />
                <button
                  type="button"
                  onClick={() => setShowKey((v) => !v)}
                  className="absolute right-3 top-1/2 -translate-y-1/2 text-navy/40 hover:text-navy transition-colors"
                >
                  {showKey ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                </button>
              </div>
              <div className="flex items-center gap-2">
                <Button
                  size="sm"
                  loading={saveKey.isPending}
                  disabled={!keyInput.trim()}
                  onClick={() => saveKey.mutate(keyInput.trim())}
                >
                  Save Key
                </Button>
                <Button
                  variant="secondary"
                  size="sm"
                  onClick={() => { setIsEditing(false); setKeyInput(""); }}
                >
                  Cancel
                </Button>
              </div>
            </div>
          ) : (
            <div className="flex items-center gap-2">
              <Button
                variant="secondary"
                size="sm"
                leftIcon={<Sparkles className="h-4 w-4" />}
                onClick={() => setIsEditing(true)}
              >
                Replace Key
              </Button>
              <Button
                variant="danger"
                size="sm"
                leftIcon={<Trash2 className="h-4 w-4" />}
                loading={removeKey.isPending}
                onClick={() => removeKey.mutate()}
              >
                Remove Key
              </Button>
            </div>
          )}

          {/* Instructions */}
          <div className="rounded-lg border border-brand-200 bg-brand-50 px-4 py-3 text-sm text-brand-700 space-y-1">
            <p className="font-medium">How to get your API key:</p>
            <ol className="ml-4 list-decimal space-y-1 text-brand-600">
              <li>Go to <strong>console.anthropic.com</strong> and sign in (or create a free account)</li>
              <li>Navigate to <strong>Settings → API Keys</strong></li>
              <li>Click <strong>Create Key</strong>, name it &quot;RouteFlow&quot;, and copy it</li>
              <li>Paste the key above and click Save</li>
            </ol>
          </div>
        </div>
      </Card>
    </div>
  );
}

// ─── TAB: Email Settings ──────────────────────────────────────────────────────

const EMAIL_PROVIDERS = [
  {
    id: "gmail",
    label: "Gmail",
    description: "Send from your Gmail or Google Workspace address",
    logo: (
      <svg viewBox="0 0 24 24" className="h-5 w-5" aria-hidden="true">
        <path d="M24 5.457v13.909c0 .904-.732 1.636-1.636 1.636h-3.819V11.73L12 16.64l-6.545-4.91v9.273H1.636A1.636 1.636 0 0 1 0 19.366V5.457c0-2.023 2.309-3.178 3.927-1.964L5.455 4.64 12 9.548l6.545-4.910 1.528-1.145C21.69 2.28 24 3.434 24 5.457z" fill="#EA4335"/>
      </svg>
    ),
    smtpHost: "smtp.gmail.com",
    smtpPort: 587,
    smtpSecure: false,
    userLabel: "Gmail address",
    userPlaceholder: "you@gmail.com",
    passwordLabel: "App Password",
    passwordPlaceholder: "xxxx xxxx xxxx xxxx",
    helpTitle: "You need a Google App Password",
    helpSteps: [
      "Go to myaccount.google.com → Security",
      "Turn on 2-Step Verification if not already on",
      'Under "How you sign in to Google", click App Passwords',
      'Select "Mail" and your device, then click Generate',
      "Copy the 16-character password and paste it here",
    ],
    helpLink: "https://myaccount.google.com/apppasswords",
    helpLinkLabel: "Open App Passwords →",
  },
  {
    id: "godaddy",
    label: "GoDaddy",
    description: "Send from your GoDaddy-hosted business email",
    logo: (
      <svg viewBox="0 0 24 24" className="h-5 w-5" aria-hidden="true">
        <path d="M12 0C5.373 0 0 5.373 0 12s5.373 12 12 12 12-5.373 12-12S18.627 0 12 0zm0 2.4c5.302 0 9.6 4.298 9.6 9.6S17.302 21.6 12 21.6 2.4 17.302 2.4 12 6.698 2.4 12 2.4z" fill="#1BDBDB"/>
      </svg>
    ),
    smtpHost: "smtpout.secureserver.net",
    smtpPort: 465,
    smtpSecure: true,
    userLabel: "GoDaddy email address",
    userPlaceholder: "you@yourbusiness.com",
    passwordLabel: "Email password",
    passwordPlaceholder: "Your GoDaddy email password",
    helpTitle: "Use your GoDaddy email credentials",
    helpSteps: [
      "Use the full email address you created in GoDaddy",
      "Use the password you set for that email account",
      'If you forgot it, reset it in GoDaddy → Email & Office → Manage',
    ],
    helpLink: "https://email.godaddy.com",
    helpLinkLabel: "Open GoDaddy Email →",
  },
] as const;

type ProviderId = typeof EMAIL_PROVIDERS[number]["id"];

function EmailSettingsTab() {
  const { toast } = useToast();
  const qc = useQueryClient();
  const [showPassword, setShowPassword] = React.useState(false);
  const [isTesting, setIsTesting] = React.useState(false);
  const [isSaving, setIsSaving] = React.useState(false);
  const [selectedProvider, setSelectedProvider] = React.useState<ProviderId | "">("");
  const [emailAddress, setEmailAddress] = React.useState("");
  const [password, setPassword] = React.useState("");
  const [fromName, setFromName] = React.useState("");

  const { data: savedSettings } = useQuery({
    queryKey: ["settings", "email"],
    queryFn: () => apiClient.get("/settings/email").then((r) => r.data),
  });

  // Detect provider from saved SMTP host
  React.useEffect(() => {
    if (!savedSettings) return;
    const host = savedSettings.smtpHost ?? "";
    if (host.includes("gmail")) setSelectedProvider("gmail");
    else if (host.includes("secureserver")) setSelectedProvider("godaddy");
    setEmailAddress(savedSettings.smtpUser ?? "");
    setFromName(savedSettings.fromName ?? "");
    // Don't pre-fill password — it's masked server-side
  }, [savedSettings]);

  const provider = EMAIL_PROVIDERS.find((p) => p.id === selectedProvider);

  const handleSave = async () => {
    if (!provider) { toast({ title: "Select an email provider first", variant: "error" }); return; }
    if (!emailAddress) { toast({ title: "Enter your email address", variant: "error" }); return; }
    if (!password && !savedSettings?.configured) { toast({ title: "Enter your password", variant: "error" }); return; }

    setIsSaving(true);
    try {
      await apiClient.post("/settings/email", {
        fromName: fromName || emailAddress,
        fromEmail: emailAddress,
        smtpHost: provider.smtpHost,
        smtpPort: provider.smtpPort,
        smtpUser: emailAddress,
        smtpPassword: password || undefined, // don't overwrite if blank
        smtpSecure: provider.smtpSecure,
      });
      qc.invalidateQueries({ queryKey: ["settings", "email"] });
      toast({ title: "Email settings saved", variant: "success" });
    } catch {
      toast({ title: "Failed to save settings", variant: "error" });
    } finally {
      setIsSaving(false);
    }
  };

  const handleTest = async () => {
    if (!emailAddress) { toast({ title: "Save your settings first", variant: "error" }); return; }
    setIsTesting(true);
    try {
      const { data } = await apiClient.post("/settings/email/test", { toEmail: emailAddress });
      if (data.success) {
        toast({ title: "Test email sent!", description: `Check ${emailAddress} for the test message.`, variant: "success" });
      } else {
        toast({ title: "Test failed", description: data.message, variant: "error" });
      }
    } catch {
      toast({ title: "Test failed", description: "Could not connect. Check your credentials.", variant: "error" });
    } finally {
      setIsTesting(false);
    }
  };

  return (
    <div className="space-y-6 max-w-xl">

      {/* Step 1 — Pick provider */}
      <div className="space-y-2">
        <p className="text-sm font-semibold text-navy">Step 1 — Choose your email provider</p>
        <div className="grid grid-cols-2 gap-3">
          {EMAIL_PROVIDERS.map((p) => (
            <button
              key={p.id}
              type="button"
              onClick={() => setSelectedProvider(p.id)}
              className={cn(
                "flex items-center gap-3 rounded-xl border-2 px-4 py-3.5 text-left transition-all",
                selectedProvider === p.id
                  ? "border-brand-500 bg-brand-50 shadow-sm"
                  : "border-surface-border bg-white hover:border-brand-300 hover:bg-surface-raised",
              )}
            >
              <span className="shrink-0">{p.logo}</span>
              <div>
                <p className="text-sm font-semibold text-navy">{p.label}</p>
                <p className="text-xs text-navy/50 leading-tight mt-0.5">{p.description}</p>
              </div>
            </button>
          ))}
        </div>
      </div>

      {/* Step 2 — Credentials (only once provider is chosen) */}
      {provider && (
        <>
          <div className="space-y-4">
            <p className="text-sm font-semibold text-navy">Step 2 — Enter your credentials</p>

            {/* Display name */}
            <div className="space-y-1">
              <label className="block text-sm font-medium text-navy">Your name / business name</label>
              <input
                type="text"
                placeholder="e.g. Acme Foods"
                value={fromName}
                onChange={(e) => setFromName(e.target.value)}
                className="h-10 w-full rounded border border-surface-border bg-white px-3 text-sm text-navy placeholder:text-navy/40 focus:outline-none focus:ring-2 focus:ring-brand-500"
              />
              <p className="text-xs text-navy/40">This is what customers see as the sender name</p>
            </div>

            {/* Email address */}
            <div className="space-y-1">
              <label className="block text-sm font-medium text-navy">{provider.userLabel}</label>
              <input
                type="email"
                placeholder={provider.userPlaceholder}
                value={emailAddress}
                onChange={(e) => setEmailAddress(e.target.value)}
                autoComplete="off"
                className="h-10 w-full rounded border border-surface-border bg-white px-3 text-sm text-navy placeholder:text-navy/40 focus:outline-none focus:ring-2 focus:ring-brand-500"
              />
            </div>

            {/* Password */}
            <div className="space-y-1">
              <label className="block text-sm font-medium text-navy">{provider.passwordLabel}</label>
              <div className="relative">
                <input
                  type={showPassword ? "text" : "password"}
                  placeholder={savedSettings?.configured ? "Leave blank to keep current password" : provider.passwordPlaceholder}
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  autoComplete="new-password"
                  className="h-10 w-full rounded border border-surface-border bg-white px-3 pr-10 text-sm text-navy placeholder:text-navy/40 focus:outline-none focus:ring-2 focus:ring-brand-500"
                />
                <button
                  type="button"
                  onClick={() => setShowPassword((v) => !v)}
                  className="absolute inset-y-0 right-0 flex items-center pr-3 text-navy/40 hover:text-navy"
                  tabIndex={-1}
                >
                  {showPassword ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                </button>
              </div>
            </div>
          </div>

          {/* Help box */}
          <div className="rounded-xl border border-blue-200 bg-blue-50 px-4 py-4 space-y-2">
            <p className="text-sm font-semibold text-blue-900">{provider.helpTitle}</p>
            <ol className="space-y-1 pl-1">
              {provider.helpSteps.map((step, i) => (
                <li key={i} className="flex items-start gap-2 text-sm text-blue-800">
                  <span className="mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center rounded-full bg-blue-200 text-[10px] font-bold text-blue-800">{i + 1}</span>
                  {step}
                </li>
              ))}
            </ol>
            <a
              href={provider.helpLink}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-block mt-1 text-xs font-medium text-blue-700 underline underline-offset-2 hover:text-blue-900"
            >
              {provider.helpLinkLabel}
            </a>
          </div>

          {/* Actions */}
          <div className="flex items-center gap-3">
            <Button
              type="button"
              onClick={handleSave}
              loading={isSaving}
              leftIcon={<CheckCircle2 className="h-4 w-4" />}
            >
              Save
            </Button>
            {savedSettings?.configured && (
              <Button
                type="button"
                variant="secondary"
                loading={isTesting}
                leftIcon={<Send className="h-4 w-4" />}
                onClick={handleTest}
              >
                Send Test Email
              </Button>
            )}
          </div>
        </>
      )}

      {/* Configured indicator */}
      {savedSettings?.configured && !provider && (
        <div className="flex items-center gap-2 rounded-lg bg-success-bg px-4 py-3 text-sm font-medium text-success">
          <CheckCircle2 className="h-4 w-4 shrink-0" />
          Email is configured and ready to send
        </div>
      )}
    </div>
  );
}

// ─── Sessions helpers ─────────────────────────────────────────────────────────

interface SessionItem {
  id: string;
  createdAt: string;
  lastUsedAt: string | null;
  expiresAt: string;
  userAgent: string | null;
  ipAddress: string | null;
  deviceName: string;
}

function DeviceIconInline({ ua }: { ua: string | null }) {
  if (!ua) return <Monitor className="h-5 w-5" />;
  if (/iPhone|iPad|iOS/i.test(ua)) return <Smartphone className="h-5 w-5" />;
  if (/Android/i.test(ua)) return <Smartphone className="h-5 w-5" />;
  if (/Macintosh|Mac OS/i.test(ua)) return <Laptop className="h-5 w-5" />;
  if (/Windows/i.test(ua)) return <Monitor className="h-5 w-5" />;
  return <Globe className="h-5 w-5" />;
}

function formatRelativeTime(iso: string | null | undefined): string {
  if (!iso) return "Never";
  const diff = Date.now() - new Date(iso).getTime();
  const minutes = Math.floor(diff / 60_000);
  if (minutes < 1) return "Just now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

function parseBrowserFromUA(ua: string | null): string {
  if (!ua) return "Unknown browser";
  if (/Edg\//i.test(ua)) return "Edge";
  if (/Chrome/i.test(ua) && !/Chromium/i.test(ua)) return "Chrome";
  if (/Firefox/i.test(ua)) return "Firefox";
  if (/Safari/i.test(ua) && !/Chrome/i.test(ua)) return "Safari";
  if (/Opera|OPR/i.test(ua)) return "Opera";
  return "Browser";
}

function SessionsCard() {
  const { toast } = useToast();
  const [sessions, setSessions] = React.useState<SessionItem[]>([]);
  const [loading, setLoading] = React.useState(true);
  const [revoking, setRevoking] = React.useState<string | null>(null);
  const [confirmRevokeAll, setConfirmRevokeAll] = React.useState(false);
  const [revokingAll, setRevokingAll] = React.useState(false);

  const loadSessions = React.useCallback(async () => {
    setLoading(true);
    try {
      const res = await apiClient.get<SessionItem[]>("/auth/sessions");
      setSessions(res.data);
    } catch {
      toast({ title: "Failed to load sessions", variant: "error" });
    } finally {
      setLoading(false);
    }
  }, [toast]);

  React.useEffect(() => { loadSessions(); }, [loadSessions]);

  const handleRevoke = async (sessionId: string) => {
    setRevoking(sessionId);
    try {
      await apiClient.delete(`/auth/sessions/${sessionId}`);
      setSessions((prev) => prev.filter((s) => s.id !== sessionId));
      toast({ title: "Session revoked", variant: "success" });
    } catch {
      toast({ title: "Failed to revoke session", variant: "error" });
    } finally {
      setRevoking(null);
    }
  };

  const handleRevokeAll = async () => {
    setRevokingAll(true);
    setConfirmRevokeAll(false);
    try {
      await Promise.all(sessions.map((s) => apiClient.delete(`/auth/sessions/${s.id}`).catch(() => null)));
      setSessions([]);
      toast({ title: "All sessions revoked", variant: "success" });
    } catch {
      toast({ title: "Failed to revoke all sessions", variant: "error" });
    } finally {
      setRevokingAll(false);
    }
  };

  return (
    <Card title="Active Sessions">
      <div className="space-y-4">
        <p className="text-sm text-navy/60">
          These are all devices currently signed into your account. Revoke any session you don&apos;t recognize.
        </p>

        {sessions.length > 1 && (
          <div className="flex justify-end">
            {confirmRevokeAll ? (
              <div className="flex items-center gap-3 rounded-lg border border-warning bg-warning-bg px-3 py-2">
                <AlertTriangle className="h-4 w-4 shrink-0 text-warning" />
                <span className="text-xs text-navy/80">Sign out all sessions?</span>
                <button
                  onClick={handleRevokeAll}
                  disabled={revokingAll}
                  className="rounded bg-danger px-2 py-0.5 text-xs font-semibold text-white hover:opacity-90 disabled:opacity-50"
                >
                  Yes
                </button>
                <button
                  onClick={() => setConfirmRevokeAll(false)}
                  className="text-xs text-navy/60 underline"
                >
                  Cancel
                </button>
              </div>
            ) : (
              <Button
                size="sm"
                variant="ghost"
                leftIcon={<LogOutIcon className="h-4 w-4" />}
                onClick={() => setConfirmRevokeAll(true)}
                disabled={revokingAll}
              >
                Sign out all
              </Button>
            )}
          </div>
        )}

        {loading && (
          <div className="flex justify-center py-6">
            <Loader2 className="h-5 w-5 animate-spin text-brand-500" />
          </div>
        )}

        {!loading && sessions.length === 0 && (
          <p className="text-sm text-navy/50">No active sessions found.</p>
        )}

        {!loading && sessions.length > 0 && (
          <ul className="divide-y divide-surface-border">
            {sessions.map((session) => (
              <li key={session.id} className="flex items-start justify-between gap-3 py-3">
                <div className="flex items-start gap-3">
                  <div className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-surface-raised text-navy/50">
                    <DeviceIconInline ua={session.userAgent} />
                  </div>
                  <div className="min-w-0">
                    <p className="text-sm font-medium text-navy">
                      {session.deviceName}
                      {" · "}
                      <span className="font-normal text-navy/60">{parseBrowserFromUA(session.userAgent)}</span>
                    </p>
                    {session.ipAddress && (
                      <p className="mt-0.5 text-xs text-navy/40">{session.ipAddress}</p>
                    )}
                    <div className="mt-0.5 flex flex-wrap gap-x-3 gap-y-0.5 text-xs text-navy/40">
                      <span>
                        <Clock className="mr-0.5 inline-block h-3 w-3" />
                        Signed in {formatRelativeTime(session.createdAt)}
                      </span>
                      {session.lastUsedAt && (
                        <span>Active {formatRelativeTime(session.lastUsedAt)}</span>
                      )}
                    </div>
                  </div>
                </div>
                <button
                  onClick={() => handleRevoke(session.id)}
                  disabled={revoking === session.id}
                  className="mt-1 shrink-0 rounded border border-surface-border px-2 py-1 text-xs font-medium text-navy/60 transition-colors hover:border-danger hover:bg-danger-bg hover:text-danger disabled:opacity-50"
                >
                  {revoking === session.id ? (
                    <Loader2 className="h-3.5 w-3.5 animate-spin" />
                  ) : (
                    "Revoke"
                  )}
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </Card>
  );
}

// ─── TAB: My Account ──────────────────────────────────────────────────────────

function MyAccountTab() {
  const { toast } = useToast();
  const [isLinking, setIsLinking] = React.useState(false);

  // Fetch current user profile (includes googleLinked boolean)
  const { data: me, isLoading } = useQuery({
    queryKey: ["users", "me"],
    queryFn: () => apiClient.get("/users/me").then((r) => r.data),
  });

  const googleLinked: boolean = me?.googleLinked ?? false;
  const canToggleDriver = me?.role === "OPERATOR" || me?.role === "TENANT_ADMIN";
  const toggleDriverPermit = useToggleDriverPermit();

  const handleLinkGoogle = async () => {
    setIsLinking(true);
    try {
      const apiUrl =
        process.env.NEXT_PUBLIC_API_URL ?? "https://routeflowapi-production.up.railway.app/api/v1";
      const token = typeof window !== "undefined" ? localStorage.getItem("accessToken") : null;
      const res = await fetch(`${apiUrl}/auth/google/link`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        toast({ title: "Google link failed", description: body.message ?? "Please try again.", variant: "error" });
        setIsLinking(false);
        return;
      }
      const { url } = await res.json();
      if (url) window.location.href = url;
    } catch {
      toast({ title: "Google link failed", description: "Please try again.", variant: "error" });
      setIsLinking(false);
    }
  };

  const handleToggleDriver = async () => {
    if (!me?.id) return;
    try {
      await toggleDriverPermit.mutateAsync(me.id);
      toast({
        title: me.canActAsDriver ? "Driver access disabled" : "Driver access enabled",
        description: me.canActAsDriver
          ? "Sign out and back in to apply."
          : "Sign out and back in to access driver features.",
        variant: "success",
      });
    } catch {
      toast({ title: "Failed to update driver access", variant: "error" });
    }
  };

  return (
    <div className="space-y-5">
      {canToggleDriver && (
        <Card title="Driver Access">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-3">
              <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg border border-surface-border bg-surface-raised">
                <Truck className="h-5 w-5 text-navy/60" />
              </div>
              <div>
                <p className="text-sm font-semibold text-navy">Act as driver</p>
                <p className="text-xs text-navy/50">
                  Lets you switch between operator and driver views without a separate account.
                </p>
              </div>
            </div>
            <button
              onClick={handleToggleDriver}
              disabled={isLoading || toggleDriverPermit.isPending}
              className="shrink-0"
              aria-label="Toggle driver access"
            >
              {me?.canActAsDriver ? (
                <ToggleRight className="h-7 w-7 text-brand-500" />
              ) : (
                <ToggleLeft className="h-7 w-7 text-navy/30" />
              )}
            </button>
          </div>
          {me?.canActAsDriver && (
            <p className="mt-3 rounded-md bg-surface-raised px-3 py-2 text-xs text-navy/50">
              A mode switcher will appear on your dashboard. Sign out and back in after toggling to refresh your session.
            </p>
          )}
        </Card>
      )}

      <Card title="Google Sign-In">
        <div className="space-y-4">
          <p className="text-sm text-navy/60">
            Connect your Google account to sign in without a password.
          </p>

          <div className="flex items-center justify-between rounded-lg border border-surface-border bg-surface-raised p-4">
            <div className="flex items-center gap-3">
              {/* Google logo */}
              <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg border border-surface-border bg-white p-2">
                <svg viewBox="0 0 48 48" className="h-5 w-5">
                  <path fill="#EA4335" d="M24 9.5c3.5 0 6.6 1.2 9 3.2l6.7-6.7C35.5 2.2 30 0 24 0 14.6 0 6.6 5.5 2.7 13.5l7.8 6C12.3 13.3 17.7 9.5 24 9.5z"/>
                  <path fill="#4285F4" d="M46.6 24.5c0-1.6-.1-3.1-.4-4.5H24v8.5h12.7c-.6 3-2.3 5.5-4.8 7.2l7.5 5.8C43.8 37.3 46.6 31.4 46.6 24.5z"/>
                  <path fill="#FBBC05" d="M10.5 28.1A14.5 14.5 0 0 1 9.5 24c0-1.4.2-2.8.6-4.1L2.3 14A24 24 0 0 0 0 24c0 3.9.9 7.5 2.5 10.8l8-6.7z"/>
                  <path fill="#34A853" d="M24 48c6.5 0 11.9-2.1 15.9-5.8l-7.5-5.8c-2.2 1.5-5 2.4-8.4 2.4-6.3 0-11.6-4.2-13.5-9.8l-8 6.2C6.5 42.3 14.6 48 24 48z"/>
                </svg>
              </div>
              <div>
                <p className="text-sm font-semibold text-navy">Google</p>
                <p className="text-xs text-navy/50">
                  {isLoading ? "Checking status…" : googleLinked ? "Connected — you can sign in with Google" : "Not connected"}
                </p>
              </div>
            </div>
            {isLoading ? null : googleLinked ? (
              <span className="inline-flex items-center gap-1.5 rounded-full bg-success-bg px-3 py-1 text-xs font-medium text-success">
                <CheckCircle2 className="h-3.5 w-3.5" />
                Connected
              </span>
            ) : (
              <Button
                size="sm"
                variant="secondary"
                leftIcon={<LinkIcon className="h-4 w-4" />}
                loading={isLinking}
                onClick={handleLinkGoogle}
              >
                Connect Google
              </Button>
            )}
          </div>

          {!googleLinked && !isLoading && (
            <p className="text-xs text-navy/50">
              After connecting, you can sign in to RouteFlow with your Google account in addition to your username and password.
            </p>
          )}
        </div>
      </Card>

      <SessionsCard />
    </div>
  );
}

// ─── TAB: Invoicing ──────────────────────────────────────────────────────────

const TERMS_OPTIONS = [
  { value: "Due on Receipt", label: "Due on Receipt" },
  { value: "Net 15", label: "Net 15" },
  { value: "Net 30", label: "Net 30" },
  { value: "Net 45", label: "Net 45" },
  { value: "Net 60", label: "Net 60" },
];

function InvoicingTab() {
  const { toast } = useToast();
  const qc = useQueryClient();
  const { data: invoiceSettings, isLoading } = useInvoiceSettings();
  const updateSettings = useUpdateInvoiceSettings();

  const { data: savedSettings } = useQuery({
    queryKey: ["settings"],
    queryFn: () => apiClient.get("/settings").then((r) => r.data),
  });

  const [invoiceNotes, setInvoiceNotes] = React.useState("");
  const [invoiceTerms, setInvoiceTerms] = React.useState("");
  const [savingDefaults, setSavingDefaults] = React.useState(false);

  React.useEffect(() => {
    if (savedSettings) {
      setInvoiceNotes(savedSettings.invoiceNotes ?? "");
      setInvoiceTerms(savedSettings.invoiceTerms ?? "");
    }
  }, [savedSettings]);

  const handleTermsChange = (value: string) => {
    updateSettings.mutate(
      { defaultTerms: value },
      {
        onSuccess: () =>
          toast({
            title: "Invoice settings saved",
            description: "Default terms updated successfully.",
            variant: "success",
          }),
        onError: () =>
          toast({
            title: "Failed to save",
            description: "Could not update invoice settings.",
            variant: "error",
          }),
      },
    );
  };

  const handleSaveDefaults = async () => {
    setSavingDefaults(true);
    try {
      await apiClient.patch("/settings", { invoiceNotes, invoiceTerms });
      qc.invalidateQueries({ queryKey: ["settings"] });
      toast({ title: "Invoice defaults saved", variant: "success" });
    } catch {
      toast({ title: "Failed to save", variant: "error" });
    } finally {
      setSavingDefaults(false);
    }
  };

  return (
    <div className="space-y-5">
      <Card title="Default Invoice Terms">
        <div className="space-y-4">
          <p className="text-sm text-navy/60">
            Automatically applied to invoices created from deliveries
          </p>

          <div className="flex items-center gap-4 rounded-lg border border-surface-border bg-surface-raised p-4">
            <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-brand-50">
              <FileText className="h-5 w-5 text-brand-500" />
            </div>
            <div className="flex-1 space-y-1">
              <p className="text-sm font-semibold text-navy">Payment Terms</p>
              <select
                className="w-full rounded-lg border border-surface-border bg-white px-3 py-2 text-sm text-navy focus:border-brand-500 focus:outline-none focus:ring-1 focus:ring-brand-500"
                value={invoiceSettings?.defaultTerms ?? "Net 30"}
                onChange={(e) => handleTermsChange(e.target.value)}
                disabled={isLoading || updateSettings.isPending}
              >
                {TERMS_OPTIONS.map((opt) => (
                  <option key={opt.value} value={opt.value}>
                    {opt.label}
                  </option>
                ))}
              </select>
            </div>
          </div>
        </div>
      </Card>

      <Card title="Invoice Defaults">
        <div className="space-y-4">
          <div>
            <label className="text-sm font-medium text-navy">Customer Notes</label>
            <textarea
              value={invoiceNotes}
              onChange={(e) => setInvoiceNotes(e.target.value)}
              rows={5}
              placeholder={
                "Thank you for your business.\n\nPlease write check in favor of\nYOUR COMPANY NAME\nZelle: billing@yourcompany.com"
              }
              className="mt-1 w-full rounded border border-surface-border px-3 py-2 text-sm text-navy focus:outline-none focus:ring-2 focus:ring-brand-500"
            />
            <p className="mt-1 text-xs text-navy/40">
              Printed on every new invoice under &quot;Notes&quot;. Preserves line breaks.
            </p>
          </div>
          <div>
            <label className="text-sm font-medium text-navy">Terms &amp; Conditions</label>
            <textarea
              value={invoiceTerms}
              onChange={(e) => setInvoiceTerms(e.target.value)}
              rows={8}
              placeholder="Your standard terms & conditions shown on every invoice."
              className="mt-1 w-full rounded border border-surface-border px-3 py-2 text-sm text-navy focus:outline-none focus:ring-2 focus:ring-brand-500"
            />
            <p className="mt-1 text-xs text-navy/40">
              Printed on every new invoice under &quot;Terms &amp; Conditions&quot;. Preserves line breaks.
            </p>
          </div>
          <div className="flex justify-end">
            <Button onClick={handleSaveDefaults} loading={savingDefaults}>
              Save Defaults
            </Button>
          </div>
        </div>
      </Card>
    </div>
  );
}

// ─── Page ─────────────────────────────────────────────────────────────────────

export default function SettingsPage() {
  const { setTitle } = usePageTitle();
  const { toast } = useToast();

  React.useEffect(() => { setTitle("Settings"); }, [setTitle]);

  // Show success toast when redirected back from Google link flow
  React.useEffect(() => {
    if (typeof window === "undefined") return;
    const params = new URLSearchParams(window.location.search);
    if (params.get("linked") === "google") {
      toast({ title: "Google account connected!", description: "You can now sign in with Google.", variant: "success" });
      // Clean the query string without triggering a navigation
      const url = new URL(window.location.href);
      url.searchParams.delete("linked");
      window.history.replaceState({}, "", url.toString());
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Determine default tab from URL (e.g., /settings?tab=account)
  const defaultTab = React.useMemo(() => {
    if (typeof window === "undefined") return "profile";
    return new URLSearchParams(window.location.search).get("tab") ?? "profile";
  }, []);

  return (
    <div className="space-y-0 p-6">
      <h1 className="mb-5 text-2xl font-bold text-navy">Settings</h1>

      <Tabs.Root defaultValue={defaultTab} className="flex flex-col">
        <Tabs.List className="flex border-b border-surface-border">
          <TabTrigger value="profile" icon={<Building2 className="h-4 w-4" />}>
            Business Profile
          </TabTrigger>
          <TabTrigger value="notifications" icon={<Bell className="h-4 w-4" />}>
            Notifications
          </TabTrigger>
          <TabTrigger value="users" icon={<UsersIcon className="h-4 w-4" />}>
            User Management
          </TabTrigger>
          <TabTrigger value="import" icon={<Download className="h-4 w-4" />}>
            Import
          </TabTrigger>
          <TabTrigger value="email" icon={<Mail className="h-4 w-4" />}>
            Email
          </TabTrigger>
          <TabTrigger value="invoicing" icon={<FileText className="h-4 w-4" />}>
            Invoicing
          </TabTrigger>
          <TabTrigger value="account" icon={<UserCircle className="h-4 w-4" />}>
            My Account
          </TabTrigger>
        </Tabs.List>

        <Tabs.Content value="profile" className="mt-6 max-w-2xl focus:outline-none">
          <BusinessProfileTab />
        </Tabs.Content>

        <Tabs.Content value="notifications" className="mt-6 max-w-2xl focus:outline-none">
          <NotificationsTab />
        </Tabs.Content>

        <Tabs.Content value="users" className="mt-6 focus:outline-none">
          <UserManagementTab />
        </Tabs.Content>

        <Tabs.Content value="import" className="mt-0 focus:outline-none">
          <ImportTab />
        </Tabs.Content>

        <Tabs.Content value="email" className="mt-6 max-w-2xl focus:outline-none">
          <EmailSettingsTab />
        </Tabs.Content>

        <Tabs.Content value="invoicing" className="mt-6 max-w-2xl focus:outline-none">
          <InvoicingTab />
        </Tabs.Content>

        <Tabs.Content value="account" className="mt-6 max-w-2xl focus:outline-none">
          <MyAccountTab />
        </Tabs.Content>
      </Tabs.Root>
    </div>
  );
}
