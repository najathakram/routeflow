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
import { useUsers, useCreateOperator, useUpdateUser, useChangeUserStatus, useResetUserPassword, AppUser } from "@/lib/api/users";
import { useNotificationsStatus, useSendTestNotification } from "@/lib/api/notifications";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { apiClient } from "@/lib/api-client";

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
  businessName: z.string().min(1, "Required"),
  ownerName: z.string().min(1, "Required"),
  phone: z.string().min(7, "Enter a valid phone number"),
  email: z.string().email("Enter a valid email"),
  street: z.string().min(1, "Required"),
  city: z.string().min(1, "Required"),
  zip: z.string().regex(/^\d{5}(-\d{4})?$/, "Enter a valid ZIP code"),
  taxRate: z.coerce.number().min(0).max(100),
});
type ProfileFormValues = z.infer<typeof profileSchema>;

function BusinessProfileTab() {
  const { toast } = useToast();
  const qc = useQueryClient();
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

  const { register, handleSubmit, reset, formState: { errors, isSubmitting } } = useForm<ProfileFormValues>({
    resolver: zodResolver(profileSchema),
    defaultValues: {
      businessName: "",
      ownerName: "",
      phone: "",
      email: "",
      street: "",
      city: "",
      zip: "",
      taxRate: 10,
    },
  });

  React.useEffect(() => {
    if (savedSettings) {
      reset({
        businessName: savedSettings.businessName ?? "",
        ownerName: savedSettings.ownerName ?? "",
        phone: savedSettings.phone ?? "",
        email: savedSettings.email ?? "",
        street: savedSettings.street ?? "",
        city: savedSettings.city ?? "",
        zip: savedSettings.zip ?? "",
        taxRate: savedSettings.taxRate ?? 10,
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
          <Input label="Business Name" register={register("businessName")} error={errors.businessName?.message} />
          <Input label="Owner / Manager Name" register={register("ownerName")} error={errors.ownerName?.message} />
          <Input label="Phone" type="tel" register={register("phone")} error={errors.phone?.message} />
          <Input label="Email" type="email" register={register("email")} error={errors.email?.message} />
        </div>
      </Card>

      <Card title="Business Address">
        <div className="space-y-3">
          <Input label="Street" register={register("street")} error={errors.street?.message} />
          <div className="grid grid-cols-3 gap-3">
            <div className="col-span-2">
              <Input label="City" register={register("city")} error={errors.city?.message} />
            </div>
            <div>
              <label className="mb-1 block text-sm font-medium text-navy">State</label>
              <div className="flex h-10 items-center rounded border border-surface-border bg-surface-raised px-3 text-sm text-navy/60">TX</div>
            </div>
          </div>
          <div className="w-40">
            <Input label="ZIP Code" register={register("zip")} error={errors.zip?.message} />
          </div>
        </div>
      </Card>

      <Card title="Logo">
        <div className="flex items-center gap-5">
          {/* Preview */}
          <div className="flex h-20 w-20 shrink-0 items-center justify-center overflow-hidden rounded-xl border border-surface-border bg-surface-raised">
            {logoPreview ? (
              <img src={logoPreview} alt="Logo preview" className="h-full w-full object-cover" />
            ) : (
              <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-brand-500 text-base font-bold text-white">
                RF
              </div>
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
  role: z.enum(["OPERATOR", "DRIVER", "CUSTOMER"]),
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
      reset({ username: user.username, email: user.email, role: user.role });
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
        <Select
          label="Role"
          options={[
            { value: "DRIVER", label: "Driver" },
            { value: "OPERATOR", label: "Operator" },
            { value: "CUSTOMER", label: "Customer" },
          ]}
          register={register("role")}
          error={errors.role?.message}
        />
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
          <strong>Recommended import order:</strong> Customers → Inventory → Invoices → Payments → Expenses.
          Payments require matching invoices; Invoices require customers to exist first.
        </p>
      </div>
      <div className="grid grid-cols-2 gap-5">
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
              <li>Click <strong>Create Key</strong>, name it "RouteFlow", and copy it</li>
              <li>Paste the key above and click Save</li>
            </ol>
          </div>
        </div>
      </Card>
    </div>
  );
}

// ─── Page ─────────────────────────────────────────────────────────────────────

export default function SettingsPage() {
  const { setTitle } = usePageTitle();
  React.useEffect(() => { setTitle("Settings"); }, [setTitle]);

  return (
    <div className="space-y-0 p-6">
      <h1 className="mb-5 text-2xl font-bold text-navy">Settings</h1>

      <Tabs.Root defaultValue="profile" className="flex flex-col">
        <Tabs.List className="flex border-b border-surface-border">
          <TabTrigger value="profile" icon={<Building2 className="h-4 w-4" />}>
            Business Profile
          </TabTrigger>
          <TabTrigger value="notifications" icon={<Bell className="h-4 w-4" />}>
            Notifications
          </TabTrigger>
          <TabTrigger value="ai" icon={<Sparkles className="h-4 w-4" />}>
            AI &amp; Integrations
          </TabTrigger>
          <TabTrigger value="users" icon={<UsersIcon className="h-4 w-4" />}>
            User Management
          </TabTrigger>
          <TabTrigger value="import" icon={<Download className="h-4 w-4" />}>
            Import
          </TabTrigger>
        </Tabs.List>

        <Tabs.Content value="profile" className="mt-6 max-w-2xl focus:outline-none">
          <BusinessProfileTab />
        </Tabs.Content>

        <Tabs.Content value="notifications" className="mt-6 max-w-2xl focus:outline-none">
          <NotificationsTab />
        </Tabs.Content>

        <Tabs.Content value="ai" className="mt-6 max-w-2xl focus:outline-none">
          <AIIntegrationsTab />
        </Tabs.Content>

        <Tabs.Content value="users" className="mt-6 focus:outline-none">
          <UserManagementTab />
        </Tabs.Content>

        <Tabs.Content value="import" className="mt-0 focus:outline-none">
          <ImportTab />
        </Tabs.Content>
      </Tabs.Root>
    </div>
  );
}
