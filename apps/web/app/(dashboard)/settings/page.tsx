"use client";

import * as React from "react";
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
  ShieldCheck,
  Landmark,
  ArrowLeft,
  ChevronDown,
  Plug,
} from "lucide-react";
import {
  Input,
  Textarea,
  Select,
  Button,
  Badge,
  Modal,
  Card,
  PasswordInput,
  cn,
} from "@routeflow/ui/web";
import { useToast } from "@routeflow/ui/web";
import { usePageTitle } from "@/lib/page-title-context";
import {
  useUsers,
  useCreateOperator,
  useUpdateUser,
  useChangeUserStatus,
  useResetUserPassword,
  useToggleDriverPermit,
  AppUser,
} from "@/lib/api/users";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { apiClient } from "@/lib/api-client";
import { AddressAutocomplete } from "@/components/AddressAutocomplete";
import { useInvoiceSettings, useUpdateInvoiceSettings } from "@/lib/api/invoices";
import { useTenant } from "@/components/tenant-provider";
import { useMarginConfig, useUpdateMarginConfig } from "@/lib/api/margin";
import {
  useRemittanceConfig,
  useUpdateRemittanceConfig,
  type RemittanceConfig,
} from "@/lib/api/remittance";
import { useAuth } from "@/lib/auth-context";
import { changePassword, setPassword } from "@/lib/auth";
import { RegulatedSettingsTab } from "./_components/RegulatedSettingsTab";
import { NotificationsSettingsTab } from "./_components/NotificationsSettingsTab";
import { SettingsHub } from "./_components/SettingsHub";
import { SendingDomainCard } from "./_components/SendingDomainCard";
import { StripeConnectCard } from "./_components/StripeConnectCard";
import NextLink from "next/link";
import { useSearchParams, useRouter } from "next/navigation";

// ─── TAB 1: Business Profile ──────────────────────────────────────────────────

const profileSchema = z.object({
  businessName: z.string().min(1, "Required"),
  email: z.string().email("Enter a valid email"),
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
  const { branding, refresh: refreshBranding } = useTenant();
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
      toast({
        title: "Profile saved",
        description: "Your business profile has been updated.",
        variant: "success",
      });
    },
    onError: () => toast({ title: "Failed to save settings", variant: "error" }),
  });

  // Logo upload — POSTs the file to /tenants/me/config/branding/logo as
  // multipart with field name "logo". Server invalidates every cached invoice
  // PDF for this tenant on success (apps/api/src/tenants/tenants.service.ts
  // uploadLogo → invalidateInvoicePdfCache), so all existing invoices will
  // re-render with the new logo on next download.
  const uploadLogo = useMutation<{ logoKey: string; logoUrl: string }, Error, File>({
    mutationFn: async (file) => {
      const fd = new FormData();
      fd.append("logo", file);
      const r = await apiClient.post("/tenants/me/config/branding/logo", fd);
      return r.data;
    },
    onSuccess: async () => {
      // Pull the freshly stored logo URL into the TenantProvider so the
      // sidebar / login screen / any other consumer updates without a reload.
      await refreshBranding();
      toast({
        title: "Logo uploaded",
        description: "It will appear on new and existing invoices.",
        variant: "success",
      });
    },
    onError: (err: any) => {
      const msg = err?.response?.data?.message ?? "Try a PNG, JPG, or WEBP under 5 MB.";
      toast({ title: "Logo upload failed", description: msg, variant: "error" });
      // Drop the local preview so the saved logo (if any) shows instead of a stale one.
      setLogoPreview(null);
    },
  });

  const {
    register,
    handleSubmit,
    reset,
    watch,
    setValue,
    formState: { errors, isSubmitting },
  } = useForm<ProfileFormValues>({
    resolver: zodResolver(profileSchema),
    defaultValues: {
      businessName: "",
      email: "",
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
        businessName: savedSettings.businessName ?? "",
        email: savedSettings.email ?? "",
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
    // Show local preview immediately so the operator sees feedback while the
    // multipart upload is in flight.
    const url = URL.createObjectURL(file);
    setLogoPreview(url);
    uploadLogo.mutate(file);
    // Reset the file input so picking the same file again still triggers onChange.
    e.target.value = "";
  };

  const onSubmit = async (data: ProfileFormValues) => {
    await saveSettings.mutateAsync(data);
  };

  return (
    <form onSubmit={handleSubmit(onSubmit)} noValidate className="space-y-6">
      <Card title="Business Information">
        <div className="grid grid-cols-2 gap-4">
          <Input
            label="Business Name"
            register={register("businessName")}
            error={errors.businessName?.message}
          />
          <Input
            label="Account Email"
            type="email"
            register={register("email")}
            error={errors.email?.message}
          />
          <Input
            label="Owner / Manager Name"
            register={register("ownerName")}
            error={errors.ownerName?.message}
          />
          <Input
            label="Phone"
            type="tel"
            register={register("phone")}
            error={errors.phone?.message}
          />
          <div className="col-span-2">
            <Input
              label="Customer-Facing Email"
              type="email"
              placeholder="invoices@yourbusiness.com"
              register={register("customerEmail")}
              error={errors.customerEmail?.message}
            />
            <p className="mt-1 text-xs text-navy/70">
              Used for invoices, order updates, and customer communications.
            </p>
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
              <Input
                label="State"
                placeholder="TX"
                register={register("state")}
                error={errors.state?.message}
              />
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
              <img
                src={branding.logoUrl}
                alt={branding.businessName}
                className="h-full w-full object-contain p-2"
              />
            ) : (
              <img src="/logo.svg" alt="RouteFlow" className="h-10 w-10 object-contain" />
            )}
          </div>
          <div className="space-y-2">
            <p className="text-sm text-navy/70">
              PNG, JPG, or WEBP under 5 MB. Recommended size: 256 × 256 px.
              {/* SVG removed — the API rejects it (RF-076) because SVGs can
                  embed scripts and we serve logos inline. */}
            </p>
            <Button
              variant="secondary"
              size="sm"
              type="button"
              leftIcon={
                uploadLogo.isPending ? (
                  <Loader2 className="h-4 w-4 animate-spin" />
                ) : (
                  <Upload className="h-4 w-4" />
                )
              }
              onClick={() => fileInputRef.current?.click()}
              disabled={uploadLogo.isPending}
            >
              {uploadLogo.isPending ? "Uploading…" : "Choose File"}
            </Button>
            <input
              ref={fileInputRef}
              type="file"
              accept="image/png,image/jpeg,image/webp"
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
            <span className="absolute right-3 top-[34px] text-sm text-navy/70">%</span>
          </div>
        </div>
      </Card>

      <div className="flex justify-end">
        <Button type="submit" loading={isSubmitting} disabled={Object.keys(errors).length > 0}>
          Save Changes
        </Button>
      </div>
    </form>
  );
}

// ─── TAB 3: User Management ───────────────────────────────────────────────────

const addUserSchema = z.object({
  name: z.string().min(1, "Required"),
  role: z.enum(["OPERATOR", "DRIVER"]),
  username: z
    .string()
    .min(3, "At least 3 characters")
    .regex(/^[a-z0-9_.]+$/, "Lowercase letters, numbers, dots, underscores"),
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

function AddUserModal({
  isOpen,
  onClose,
  onCreated,
}: {
  isOpen: boolean;
  onClose: () => void;
  onCreated: (tempPassword: string) => void;
}) {
  const createOperator = useCreateOperator();
  const [tempPassword, setTempPassword] = React.useState<string | null>(null);
  const [copied, setCopied] = React.useState(false);

  const {
    register,
    handleSubmit,
    watch,
    setValue,
    reset,
    formState: { errors, isSubmitting, touchedFields },
  } = useForm<AddUserFormValues>({
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
    try {
      await navigator.clipboard.writeText(tempPassword);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      /* clipboard unavailable */
    }
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
            <Button variant="secondary" type="button" onClick={handleClose}>
              Cancel
            </Button>
            <Button
              type="submit"
              form="add-user-form"
              loading={isSubmitting || createOperator.isPending}
            >
              Create User
            </Button>
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
              <button
                onClick={copyPw}
                title="Copy"
                className="rounded p-2 text-navy/70 hover:bg-surface-raised hover:text-navy transition-colors"
              >
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
          <Input
            label="Full Name"
            placeholder="Jane Smith"
            register={register("name")}
            error={errors.name?.message}
          />
          <Select
            label="Role"
            options={[
              { value: "DRIVER", label: "Driver" },
              { value: "OPERATOR", label: "Operator" },
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
      )}
    </Modal>
  );
}

// ─── Edit User Modal ──────────────────────────────────────────────────────────

const editUserSchema = z.object({
  username: z
    .string()
    .min(3, "At least 3 characters")
    .regex(/^[a-z0-9_.]+$/, "Lowercase letters, numbers, dots, underscores"),
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

  const {
    register,
    handleSubmit,
    reset,
    formState: { errors, isSubmitting },
  } = useForm<EditUserFormValues>({
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
    try {
      await navigator.clipboard.writeText(tempPassword);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      /* clipboard unavailable */
    }
  };

  return (
    <Modal
      open={isOpen}
      onClose={onClose}
      title="Edit User"
      description="Update the user's details or reset their password."
      footer={
        <>
          <Button variant="secondary" type="button" onClick={onClose}>
            Cancel
          </Button>
          <Button
            type="submit"
            form="edit-user-form"
            loading={isSubmitting || updateUser.isPending}
          >
            Save Changes
          </Button>
        </>
      }
    >
      <form id="edit-user-form" onSubmit={handleSubmit(onSubmit)} noValidate className="space-y-4">
        {updateUser.error && <p className="text-sm text-danger">{updateUser.error.message}</p>}
        {user?.role === "TENANT_ADMIN" ? (
          <div>
            <label className="mb-1 block text-sm font-medium text-navy">Role</label>
            <div className="flex h-10 items-center rounded-md border border-surface-border bg-surface-secondary px-3 text-sm text-navy/70">
              Admin
            </div>
            <p className="mt-1 text-xs text-navy/70">Tenant admin role cannot be changed.</p>
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
            <p className="text-xs font-medium text-navy">
              New temporary password — share with user:
            </p>
            <div className="flex items-center gap-2">
              <code className="flex-1 rounded border border-surface-border bg-surface-raised px-3 py-1.5 font-mono text-sm font-bold tracking-widest text-navy">
                {tempPassword}
              </code>
              <button
                onClick={copyPw}
                title="Copy"
                className="rounded p-1.5 text-navy/70 hover:bg-surface-raised hover:text-navy transition-colors"
              >
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
        <p className="text-sm text-navy/70">
          {isLoading ? "Loading..." : `${data?.meta.total ?? 0} users total`}
        </p>
        <Button size="sm" onClick={() => setIsAddOpen(true)}>
          Add User
        </Button>
      </div>

      <div className="overflow-hidden rounded-lg border border-surface-border bg-white">
        <table className="w-full text-sm">
          <thead className="border-b border-surface-border bg-surface-raised">
            <tr>
              <th className="px-4 py-3 text-left text-xs font-medium text-navy/70">Username</th>
              <th className="px-4 py-3 text-left text-xs font-medium text-navy/70">Email</th>
              <th className="px-4 py-3 text-left text-xs font-medium text-navy/70">Role</th>
              <th className="px-4 py-3 text-left text-xs font-medium text-navy/70">Status</th>
              <th className="px-4 py-3 text-left text-xs font-medium text-navy/70">Created</th>
              <th className="px-4 py-3" />
            </tr>
          </thead>
          <tbody className="divide-y divide-surface-border">
            {isLoading ? (
              <tr>
                <td colSpan={6} className="px-4 py-8 text-center text-sm text-navy/70">
                  Loading users...
                </td>
              </tr>
            ) : users.length === 0 ? (
              <tr>
                <td colSpan={6} className="px-4 py-8 text-center text-sm text-navy/70">
                  No users found.
                </td>
              </tr>
            ) : (
              users.map((user) => (
                <tr key={user.id} className="hover:bg-surface-raised transition-colors">
                  <td className="px-4 py-3 font-mono text-xs text-navy/70">{user.username}</td>
                  <td className="px-4 py-3 text-navy/70">{user.email}</td>
                  <td className="px-4 py-3">
                    <RoleBadge role={user.role} />
                  </td>
                  <td className="px-4 py-3">
                    <Badge status={user.status === "ACTIVE" ? "ACTIVE" : "INACTIVE"} />
                  </td>
                  <td className="px-4 py-3 text-navy/70">
                    {new Date(user.createdAt).toLocaleDateString("en-US", {
                      month: "short",
                      day: "numeric",
                      year: "numeric",
                    })}
                  </td>
                  <td className="px-4 py-3">
                    <div className="flex items-center gap-1 justify-end">
                      <button
                        title="Edit user"
                        onClick={() => setEditingUser(user)}
                        className="rounded p-1.5 text-navy/70 hover:bg-surface-raised hover:text-navy transition-colors"
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
      toast({
        title: "API key saved",
        description: "Claude AI scanning is now active.",
        variant: "success",
      });
    },
    onError: () => toast({ title: "Failed to save API key", variant: "error" }),
  });

  const removeKey = useMutation({
    mutationFn: () => apiClient.patch("/settings/anthropic", { apiKey: "" }).then((r) => r.data),
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
                <p className="text-xs text-navy/70">
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
          <div className="text-sm text-navy/70 space-y-1">
            <p>
              RouteFlow uses Claude to intelligently extract supplier names, invoice numbers, line
              items, and totals from scanned documents — saving manual data entry.
            </p>
            <p>
              Each operator uses their own API key so AI costs are billed directly to your Anthropic
              account.
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
                  className="absolute right-3 top-1/2 -translate-y-1/2 text-navy/70 hover:text-navy transition-colors"
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
                  onClick={() => {
                    setIsEditing(false);
                    setKeyInput("");
                  }}
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
              <li>
                Go to <strong>console.anthropic.com</strong> and sign in (or create a free account)
              </li>
              <li>
                Navigate to <strong>Settings → API Keys</strong>
              </li>
              <li>
                Click <strong>Create Key</strong>, name it &quot;RouteFlow&quot;, and copy it
              </li>
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
        <path
          d="M24 5.457v13.909c0 .904-.732 1.636-1.636 1.636h-3.819V11.73L12 16.64l-6.545-4.91v9.273H1.636A1.636 1.636 0 0 1 0 19.366V5.457c0-2.023 2.309-3.178 3.927-1.964L5.455 4.64 12 9.548l6.545-4.910 1.528-1.145C21.69 2.28 24 3.434 24 5.457z"
          fill="#EA4335"
        />
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
    id: "microsoft365",
    label: "Microsoft 365 / Outlook",
    description: "Office 365, Outlook.com, and GoDaddy Microsoft 365 email",
    logo: (
      <svg viewBox="0 0 24 24" className="h-5 w-5" aria-hidden="true">
        <rect x="1" y="1" width="10" height="10" fill="#F25022" />
        <rect x="13" y="1" width="10" height="10" fill="#7FBA00" />
        <rect x="1" y="13" width="10" height="10" fill="#00A4EF" />
        <rect x="13" y="13" width="10" height="10" fill="#FFB900" />
      </svg>
    ),
    smtpHost: "smtp.office365.com",
    smtpPort: 587,
    smtpSecure: false,
    userLabel: "Email address",
    userPlaceholder: "you@yourbusiness.com",
    passwordLabel: "Password (or app password)",
    passwordPlaceholder: "Your email password",
    helpTitle: "SMTP sign-in must be enabled for your mailbox",
    helpSteps: [
      "Microsoft turns SMTP sign-in OFF by default — an admin must enable it once",
      "Microsoft 365 admin center → Users → Active users → select the user",
      'Open the "Mail" tab → "Manage email apps" → tick "Authenticated SMTP" → Save',
      "If you use 2-step verification, create an app password and use it here",
      "GoDaddy email is usually Microsoft 365 — this preset is the right one for it",
    ],
    helpLink: "https://aka.ms/smtp_auth_disabled",
    helpLinkLabel: "How to enable SMTP sign-in →",
  },
  {
    id: "godaddy",
    label: "GoDaddy Workspace (legacy)",
    description: "Older GoDaddy Workspace Email only — newer GoDaddy email is Microsoft 365",
    logo: (
      <svg viewBox="0 0 24 24" className="h-5 w-5" aria-hidden="true">
        <path
          d="M12 0C5.373 0 0 5.373 0 12s5.373 12 12 12 12-5.373 12-12S18.627 0 12 0zm0 2.4c5.302 0 9.6 4.298 9.6 9.6S17.302 21.6 12 21.6 2.4 17.302 2.4 12 6.698 2.4 12 2.4z"
          fill="#1BDBDB"
        />
      </svg>
    ),
    smtpHost: "smtpout.secureserver.net",
    smtpPort: 465,
    smtpSecure: true,
    userLabel: "GoDaddy email address",
    userPlaceholder: "you@yourbusiness.com",
    passwordLabel: "Email password",
    passwordPlaceholder: "Your GoDaddy email password",
    helpTitle: "Only for legacy Workspace Email",
    helpSteps: [
      'If your GoDaddy email is Microsoft 365 (most are now), pick "Microsoft 365 / Outlook" instead',
      "Use the full email address you created in GoDaddy and its password",
      "If you forgot it, reset it in GoDaddy → Email & Office → Manage",
    ],
    helpLink: "https://email.godaddy.com",
    helpLinkLabel: "Open GoDaddy Email →",
  },
  {
    id: "custom",
    label: "Other / custom SMTP",
    description: "Any provider — enter the SMTP details yourself",
    logo: <Mail className="h-5 w-5 text-navy/60" aria-hidden="true" />,
    smtpHost: "",
    smtpPort: 587,
    smtpSecure: false,
    userLabel: "Email address",
    userPlaceholder: "you@yourbusiness.com",
    passwordLabel: "Password",
    passwordPlaceholder: "Your email or app password",
    helpTitle: "Where to find these details",
    helpSteps: [
      'Search your provider\'s help for "SMTP settings" (host, port, SSL)',
      "Port 587 usually pairs with the secure toggle OFF (STARTTLS); port 465 with it ON (SSL)",
      "Providers with 2-step verification usually need an app password instead of your normal one",
    ],
    helpLink: "",
    helpLinkLabel: "",
  },
] as const;

type ProviderId = (typeof EMAIL_PROVIDERS)[number]["id"];

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
  // Custom-provider SMTP details (only used when the "custom" preset is selected).
  const [customHost, setCustomHost] = React.useState("");
  const [customPort, setCustomPort] = React.useState("587");
  const [customSecure, setCustomSecure] = React.useState(false);
  const [isVerifying, setIsVerifying] = React.useState(false);
  // Last connection-check outcome, shown inline so the guidance stays visible
  // (toast text disappears too fast for a multi-step fix like enabling SMTP auth).
  const [verifyResult, setVerifyResult] = React.useState<{
    ok: boolean;
    message: string;
  } | null>(null);

  const { data: savedSettings } = useQuery({
    queryKey: ["settings", "email"],
    queryFn: () => apiClient.get("/settings/email").then((r) => r.data),
  });

  // Detect provider from the saved SMTP host. Match the host EXACTLY against a preset's
  // host (not a loose substring) — otherwise a legitimate custom host that merely contains
  // a brand word (e.g. Google Workspace's "smtp-relay.gmail.com") would be reclassified to
  // a preset whose hardcoded host ("smtp.gmail.com") then overwrites the real one on save.
  React.useEffect(() => {
    if (!savedSettings) return;
    const host = (savedSettings.smtpHost ?? "").trim();
    const preset = host
      ? EMAIL_PROVIDERS.find((p) => p.smtpHost && p.smtpHost.toLowerCase() === host.toLowerCase())
      : undefined;
    if (preset) {
      setSelectedProvider(preset.id);
    } else if (host) {
      setSelectedProvider("custom");
      setCustomHost(host);
      setCustomPort(String(savedSettings.smtpPort ?? 587));
      setCustomSecure(!!savedSettings.smtpSecure);
    }
    setEmailAddress(savedSettings.smtpUser ?? "");
    setFromName(savedSettings.fromName ?? "");
    // Don't pre-fill password — it's masked server-side
  }, [savedSettings]);

  const provider = EMAIL_PROVIDERS.find((p) => p.id === selectedProvider);
  const isCustom = provider?.id === "custom";
  // The SMTP endpoint actually in play: preset values, or the custom fields.
  const effective = provider
    ? {
        host: isCustom ? customHost.trim() : provider.smtpHost,
        port: isCustom ? parseInt(customPort, 10) || 587 : provider.smtpPort,
        secure: isCustom ? customSecure : provider.smtpSecure,
      }
    : null;

  const handleVerifyConnection = async () => {
    if (!effective?.host || !emailAddress) {
      toast({ title: "Pick a provider and enter your email address first", variant: "error" });
      return;
    }
    setIsVerifying(true);
    setVerifyResult(null);
    try {
      // Blank password → the server re-uses the SAVED password for this same
      // mailbox+server, so a re-test after saving doesn't need retyping.
      const { data } = await apiClient.post("/settings/email/verify", {
        smtpHost: effective.host,
        smtpPort: effective.port,
        smtpSecure: effective.secure,
        smtpUser: emailAddress,
        smtpPassword: password || undefined,
      });
      setVerifyResult(data);
    } catch (e: any) {
      setVerifyResult({
        ok: false,
        message: e?.response?.data?.message || "The connection test failed. Try again.",
      });
    } finally {
      setIsVerifying(false);
    }
  };

  const handleSave = async () => {
    if (!provider || !effective) {
      toast({ title: "Select an email provider first", variant: "error" });
      return;
    }
    if (isCustom && !effective.host) {
      toast({ title: "Enter your provider's SMTP host", variant: "error" });
      return;
    }
    if (!emailAddress) {
      toast({ title: "Enter your email address", variant: "error" });
      return;
    }
    // A saved password only carries over for the SAME mailbox+server — switching
    // provider/host/address needs the password re-entered (the server clears the old
    // one rather than replay it against a different server).
    const mailboxChanged =
      savedSettings?.smtpConfigured &&
      (effective.host !== (savedSettings?.smtpHost ?? "") ||
        emailAddress !== (savedSettings?.smtpUser ?? ""));
    if (!password && (!savedSettings?.smtpConfigured || mailboxChanged)) {
      toast({
        title: "Enter your password",
        description: mailboxChanged
          ? "You changed the email address or server, so the password must be re-entered."
          : undefined,
        variant: "error",
      });
      return;
    }

    setIsSaving(true);
    try {
      await apiClient.post("/settings/email", {
        fromName: fromName || emailAddress,
        fromEmail: emailAddress,
        smtpHost: effective.host,
        smtpPort: effective.port,
        smtpUser: emailAddress,
        smtpPassword: password || undefined, // don't overwrite if blank
        smtpSecure: effective.secure,
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
    if (!emailAddress) {
      toast({ title: "Save your settings first", variant: "error" });
      return;
    }
    setIsTesting(true);
    try {
      const { data } = await apiClient.post("/settings/email/test", { toEmail: emailAddress });
      if (data.success) {
        // sendTestEmail() returns the generic "Test email sent successfully" when the
        // tenant's own SMTP delivered cleanly, but appends the mapped SMTP-diagnostic
        // reason (verbatim) when Resend had to rescue the send. Show that distinctly —
        // it's still a success, but the tenant's own mail is broken.
        const isFallbackWarning = !!data.message && data.message !== "Test email sent successfully";
        toast({
          title: isFallbackWarning ? "Sent via RouteFlow's mail service" : "Test email sent!",
          description: isFallbackWarning
            ? data.message
            : `Check ${emailAddress} for the test message.`,
          variant: isFallbackWarning ? "warning" : "success",
        });
      } else {
        toast({ title: "Test failed", description: data.message, variant: "error" });
      }
    } catch {
      toast({
        title: "Test failed",
        description: "Could not connect. Check your credentials.",
        variant: "error",
      });
    } finally {
      setIsTesting(false);
    }
  };

  return (
    <div className="space-y-6">
      {/* PRIMARY: each tenant sends through its own email account (BYO SMTP) — their
          address, their provider, no third-party account. The platform/domain path
          below is the optional alternative. */}
      <div className="max-w-xl overflow-hidden rounded-card border border-surface-border bg-white">
        <div className="border-b border-surface-border px-5 py-4">
          <p className="text-sm font-semibold text-navy">Send from your own email</p>
          <p className="mt-0.5 text-xs text-navy/60">
            Connect the email account your business already uses — invoices and reminders go out
            from that exact address.
          </p>
        </div>
        <div className="space-y-6 p-5">
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
                    <p className="text-xs text-navy/70 leading-tight mt-0.5">{p.description}</p>
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

                {/* Custom provider: the SMTP endpoint itself */}
                {isCustom && (
                  <div className="grid grid-cols-1 gap-3 sm:grid-cols-[1fr_110px_auto]">
                    <div className="space-y-1">
                      <label className="block text-sm font-medium text-navy">SMTP host</label>
                      <input
                        type="text"
                        placeholder="smtp.yourprovider.com"
                        value={customHost}
                        onChange={(e) => setCustomHost(e.target.value)}
                        className="h-10 w-full rounded border border-surface-border bg-white px-3 text-sm text-navy placeholder:text-navy/70 focus:outline-none focus:ring-2 focus:ring-brand-500"
                      />
                    </div>
                    <div className="space-y-1">
                      <label className="block text-sm font-medium text-navy">Port</label>
                      <input
                        type="number"
                        placeholder="587"
                        value={customPort}
                        onChange={(e) => setCustomPort(e.target.value)}
                        className="h-10 w-full rounded border border-surface-border bg-white px-3 text-sm text-navy placeholder:text-navy/70 focus:outline-none focus:ring-2 focus:ring-brand-500"
                      />
                    </div>
                    <label className="flex items-end gap-2 pb-2.5 text-sm text-navy">
                      <input
                        type="checkbox"
                        checked={customSecure}
                        onChange={(e) => setCustomSecure(e.target.checked)}
                        className="h-4 w-4 rounded border-surface-border"
                      />
                      SSL (465)
                    </label>
                  </div>
                )}

                {/* Display name */}
                <div className="space-y-1">
                  <label className="block text-sm font-medium text-navy">
                    Your name / business name
                  </label>
                  <input
                    type="text"
                    placeholder="e.g. Acme Foods"
                    value={fromName}
                    onChange={(e) => setFromName(e.target.value)}
                    className="h-10 w-full rounded border border-surface-border bg-white px-3 text-sm text-navy placeholder:text-navy/70 focus:outline-none focus:ring-2 focus:ring-brand-500"
                  />
                  <p className="text-xs text-navy/70">
                    This is what customers see as the sender name
                  </p>
                </div>

                {/* Email address */}
                <div className="space-y-1">
                  <label className="block text-sm font-medium text-navy">
                    {provider.userLabel}
                  </label>
                  <input
                    type="email"
                    placeholder={provider.userPlaceholder}
                    value={emailAddress}
                    onChange={(e) => setEmailAddress(e.target.value)}
                    autoComplete="off"
                    className="h-10 w-full rounded border border-surface-border bg-white px-3 text-sm text-navy placeholder:text-navy/70 focus:outline-none focus:ring-2 focus:ring-brand-500"
                  />
                  <p className="text-xs text-navy/70">
                    Emails send from this exact address — it must be the mailbox you sign in with
                    (providers reject a mismatched sender).
                  </p>
                </div>

                {/* Password */}
                <div className="space-y-1">
                  <label className="block text-sm font-medium text-navy">
                    {provider.passwordLabel}
                  </label>
                  <div className="relative">
                    <input
                      type={showPassword ? "text" : "password"}
                      placeholder={
                        savedSettings?.smtpConfigured
                          ? "Leave blank to keep current password"
                          : provider.passwordPlaceholder
                      }
                      value={password}
                      onChange={(e) => setPassword(e.target.value)}
                      autoComplete="new-password"
                      className="h-10 w-full rounded border border-surface-border bg-white px-3 pr-10 text-sm text-navy placeholder:text-navy/70 focus:outline-none focus:ring-2 focus:ring-brand-500"
                    />
                    <button
                      type="button"
                      onClick={() => setShowPassword((v) => !v)}
                      className="absolute inset-y-0 right-0 flex items-center pr-3 text-navy/70 hover:text-navy"
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
                      <span className="mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center rounded-full bg-blue-200 text-[10px] font-bold text-blue-800">
                        {i + 1}
                      </span>
                      {step}
                    </li>
                  ))}
                </ol>
                {provider.helpLink && (
                  <a
                    href={provider.helpLink}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="inline-block mt-1 text-xs font-medium text-blue-700 underline underline-offset-2 hover:text-blue-900"
                  >
                    {provider.helpLinkLabel}
                  </a>
                )}
              </div>

              {/* Connection-check result — inline (not a toast) so multi-step fixes
                  like enabling M365 SMTP auth stay readable while the operator acts. */}
              {verifyResult && (
                <div
                  className={cn(
                    "flex items-start gap-2 rounded-lg px-4 py-3 text-sm",
                    verifyResult.ok ? "bg-success-bg text-success" : "bg-danger-bg text-danger",
                  )}
                >
                  {verifyResult.ok ? (
                    <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0" />
                  ) : (
                    <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
                  )}
                  <span>{verifyResult.message}</span>
                </div>
              )}

              {/* Actions */}
              <div className="flex flex-wrap items-center gap-3">
                <Button
                  type="button"
                  variant="secondary"
                  onClick={handleVerifyConnection}
                  loading={isVerifying}
                  leftIcon={<Plug className="h-4 w-4" />}
                >
                  Test connection
                </Button>
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
      </div>

      {/* OPTIONAL: RouteFlow-managed sending (platform transactional service with a
          verified domain) — for tenants who don't want to touch their mail account. */}
      <details className="group max-w-xl overflow-hidden rounded-card border border-surface-border bg-white [&_summary]:list-none">
        <summary className="flex cursor-pointer items-center justify-between gap-2 px-5 py-4 text-sm font-medium text-navy hover:bg-surface-secondary/40">
          <span>Optional — let RouteFlow send for you (verified domain)</span>
          <ChevronDown className="h-4 w-4 text-navy/40 transition-transform group-open:rotate-180" />
        </summary>
        <div className="border-t border-surface-border p-4">
          <SendingDomainCard />
        </div>
      </details>
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

  React.useEffect(() => {
    loadSessions();
  }, [loadSessions]);

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
      await Promise.all(
        sessions.map((s) => apiClient.delete(`/auth/sessions/${s.id}`).catch(() => null)),
      );
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
        <p className="text-sm text-navy/70">
          These are all devices currently signed into your account. Revoke any session you
          don&apos;t recognize.
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
                  className="text-xs text-navy/70 underline"
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
          <p className="text-sm text-navy/70">No active sessions found.</p>
        )}

        {!loading && sessions.length > 0 && (
          <ul className="divide-y divide-surface-border">
            {sessions.map((session) => (
              <li key={session.id} className="flex items-start justify-between gap-3 py-3">
                <div className="flex items-start gap-3">
                  <div className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-surface-raised text-navy/70">
                    <DeviceIconInline ua={session.userAgent} />
                  </div>
                  <div className="min-w-0">
                    <p className="text-sm font-medium text-navy">
                      {session.deviceName}
                      {" · "}
                      <span className="font-normal text-navy/70">
                        {parseBrowserFromUA(session.userAgent)}
                      </span>
                    </p>
                    {session.ipAddress && (
                      <p className="mt-0.5 text-xs text-navy/70">{session.ipAddress}</p>
                    )}
                    <div className="mt-0.5 flex flex-wrap gap-x-3 gap-y-0.5 text-xs text-navy/70">
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
                  className="mt-1 shrink-0 rounded border border-surface-border px-2 py-1 text-xs font-medium text-navy/70 transition-colors hover:border-danger hover:bg-danger-bg hover:text-danger disabled:opacity-50"
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

// ─── Password card (My Account) ───────────────────────────────────────────────

const passwordCardSchema = z
  .object({
    currentPassword: z.string(),
    // Mirrors the server policy: min 8, upper + lower + digit-or-special.
    newPassword: z
      .string()
      .min(8, "At least 8 characters")
      .regex(
        /^(?=.*[a-z])(?=.*[A-Z])(?=.*[\d\W])/,
        "Must include an uppercase letter, a lowercase letter, and a number or symbol",
      ),
    confirmPassword: z.string().min(1, "Please confirm your new password"),
  })
  .refine((d) => d.newPassword === d.confirmPassword, {
    message: "Passwords do not match",
    path: ["confirmPassword"],
  });

type PasswordCardValues = z.infer<typeof passwordCardSchema>;

/**
 * Set/change password. `hasPassword` comes fresh from GET /users/me (the JWT
 * copy goes stale) — false means a Google-only account setting its FIRST
 * password, so no current-password field is shown; the server independently
 * verifies the account really has none before accepting.
 */
function PasswordCard() {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [open, setOpen] = React.useState(false);
  const [apiError, setApiError] = React.useState<string | null>(null);

  const { data: me, isLoading } = useQuery({
    queryKey: ["users", "me"],
    queryFn: () => apiClient.get("/users/me").then((r) => r.data),
  });
  // Undefined while loading or on an older API — fall back to change mode.
  const hasPassword: boolean = me?.hasPassword ?? true;

  const {
    register,
    handleSubmit,
    reset,
    formState: { errors, isSubmitting },
  } = useForm<PasswordCardValues>({
    resolver: zodResolver(passwordCardSchema),
    defaultValues: { currentPassword: "", newPassword: "", confirmPassword: "" },
  });

  const onSubmit = async (data: PasswordCardValues) => {
    setApiError(null);
    if (hasPassword && !data.currentPassword) {
      setApiError("Current password is required.");
      return;
    }
    try {
      if (hasPassword) await changePassword(data.currentPassword, data.newPassword);
      else await setPassword(data.newPassword);
      toast({
        title: hasPassword ? "Password changed" : "Password set",
        description: "All other sessions have been signed out.",
        variant: "success",
      });
      reset();
      setOpen(false);
      // Flip hasPassword + refresh the sessions list (all others were revoked).
      void queryClient.invalidateQueries({ queryKey: ["users", "me"] });
      void queryClient.invalidateQueries({ queryKey: ["auth", "sessions"] });
    } catch (err: unknown) {
      const msg =
        (err as { response?: { data?: { message?: string } } })?.response?.data?.message ??
        "Failed to update password.";
      setApiError(typeof msg === "string" ? msg : "Failed to update password.");
    }
  };

  return (
    <Card title="Password">
      <div className="space-y-4">
        <div className="flex items-center justify-between gap-3">
          <p className="text-sm text-navy/70">
            {isLoading
              ? "Checking account…"
              : hasPassword
                ? "Change your account password. Other sessions are signed out afterwards."
                : "You sign in with Google. Set a password to also sign in with your username."}
          </p>
          {!open && (
            <Button
              size="sm"
              variant="secondary"
              onClick={() => setOpen(true)}
              disabled={isLoading}
            >
              {hasPassword ? "Change password" : "Set password"}
            </Button>
          )}
        </div>

        {open && (
          <form
            onSubmit={handleSubmit(onSubmit)}
            className="flex max-w-sm flex-col gap-4"
            noValidate
          >
            {apiError && (
              <p className="rounded-lg bg-danger-bg px-3 py-2 text-sm text-danger">{apiError}</p>
            )}
            {hasPassword && (
              <PasswordInput
                label="Current password"
                autoComplete="current-password"
                register={register("currentPassword")}
                error={errors.currentPassword?.message}
              />
            )}
            <PasswordInput
              label="New password"
              autoComplete="new-password"
              register={register("newPassword")}
              error={errors.newPassword?.message}
            />
            <PasswordInput
              label="Confirm new password"
              autoComplete="new-password"
              register={register("confirmPassword")}
              error={errors.confirmPassword?.message}
            />
            <div className="flex gap-2">
              <Button type="submit" loading={isSubmitting}>
                {hasPassword ? "Change password" : "Set password"}
              </Button>
              <Button
                type="button"
                variant="ghost"
                disabled={isSubmitting}
                onClick={() => {
                  reset();
                  setApiError(null);
                  setOpen(false);
                }}
              >
                Cancel
              </Button>
            </div>
          </form>
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
        toast({
          title: "Google link failed",
          description: body.message ?? "Please try again.",
          variant: "error",
        });
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
                <Truck className="h-5 w-5 text-navy/70" />
              </div>
              <div>
                <p className="text-sm font-semibold text-navy">Act as driver</p>
                <p className="text-xs text-navy/70">
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
            <p className="mt-3 rounded-md bg-surface-raised px-3 py-2 text-xs text-navy/70">
              A mode switcher will appear on your dashboard. Sign out and back in after toggling to
              refresh your session.
            </p>
          )}
        </Card>
      )}

      <Card title="Google Sign-In">
        <div className="space-y-4">
          <p className="text-sm text-navy/70">
            Connect your Google account to sign in without a password.
          </p>

          <div className="flex items-center justify-between rounded-lg border border-surface-border bg-surface-raised p-4">
            <div className="flex items-center gap-3">
              {/* Google logo */}
              <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg border border-surface-border bg-white p-2">
                <svg viewBox="0 0 48 48" className="h-5 w-5">
                  <path
                    fill="#EA4335"
                    d="M24 9.5c3.5 0 6.6 1.2 9 3.2l6.7-6.7C35.5 2.2 30 0 24 0 14.6 0 6.6 5.5 2.7 13.5l7.8 6C12.3 13.3 17.7 9.5 24 9.5z"
                  />
                  <path
                    fill="#4285F4"
                    d="M46.6 24.5c0-1.6-.1-3.1-.4-4.5H24v8.5h12.7c-.6 3-2.3 5.5-4.8 7.2l7.5 5.8C43.8 37.3 46.6 31.4 46.6 24.5z"
                  />
                  <path
                    fill="#FBBC05"
                    d="M10.5 28.1A14.5 14.5 0 0 1 9.5 24c0-1.4.2-2.8.6-4.1L2.3 14A24 24 0 0 0 0 24c0 3.9.9 7.5 2.5 10.8l8-6.7z"
                  />
                  <path
                    fill="#34A853"
                    d="M24 48c6.5 0 11.9-2.1 15.9-5.8l-7.5-5.8c-2.2 1.5-5 2.4-8.4 2.4-6.3 0-11.6-4.2-13.5-9.8l-8 6.2C6.5 42.3 14.6 48 24 48z"
                  />
                </svg>
              </div>
              <div>
                <p className="text-sm font-semibold text-navy">Google</p>
                <p className="text-xs text-navy/70">
                  {isLoading
                    ? "Checking status…"
                    : googleLinked
                      ? "Connected — you can sign in with Google"
                      : "Not connected"}
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
            <p className="text-xs text-navy/70">
              After connecting, you can sign in to RouteFlow with your Google account in addition to
              your username and password.
            </p>
          )}
        </div>
      </Card>

      <PasswordCard />

      <SessionsCard />
    </div>
  );
}

// ─── TAB: Costing & margins (pos-cost-roles-spec §1) ──────────────────────────

function CostingTab() {
  const { toast } = useToast();
  const { user } = useAuth();
  const isAdmin = user?.role === "TENANT_ADMIN";
  const { data: config, isLoading } = useMarginConfig();
  const update = useUpdateMarginConfig();

  const [method, setMethod] = React.useState<"WEIGHTED_AVERAGE" | "FIFO" | "LAST_COST">(
    "WEIGHTED_AVERAGE",
  );
  const [floorPct, setFloorPct] = React.useState("15");

  React.useEffect(() => {
    if (config) {
      setMethod(config.costingMethod);
      setFloorPct(String(Math.round((config.defaultMarginFloor ?? 0.15) * 1000) / 10));
    }
  }, [config]);

  const save = () => {
    const floor = Math.max(0, Math.min(99, parseFloat(floorPct) || 0)) / 100;
    update.mutate(
      { costingMethod: method, defaultMarginFloor: floor },
      {
        onSuccess: () => toast({ title: "Costing settings saved", variant: "success" }),
        onError: () =>
          toast({
            title: "Could not save",
            description: "Only admins can change costing settings.",
            variant: "error",
          }),
      },
    );
  };

  if (isLoading) return <p className="text-sm text-navy/70">Loading…</p>;

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-lg font-semibold text-navy">Costing &amp; margins</h2>
        <p className="mt-1 text-sm text-navy/70">
          How product cost is figured, and the minimum margin the sale builder warns below.
        </p>
      </div>

      <div className="space-y-5 rounded-card border border-line bg-paper p-5 shadow-card">
        <div className="max-w-xs">
          <Select
            label="Costing method"
            value={method}
            onChange={(e) => setMethod(e.target.value as typeof method)}
            disabled={!isAdmin}
            options={[
              { value: "WEIGHTED_AVERAGE", label: "Weighted average" },
              { value: "FIFO", label: "FIFO (first in, first out)" },
              { value: "LAST_COST", label: "Last cost" },
            ]}
          />
          <p className="mt-1.5 text-xs text-navy/50">
            Weighted average, in one line: buy 50 more at a new price and every unit re-averages.
            History never rewrites.
          </p>
        </div>

        <div className="max-w-xs">
          <label className="text-xs font-semibold text-navy">Default margin floor</label>
          <div className="mt-1 flex items-center gap-2">
            <input
              type="number"
              min={0}
              max={99}
              step="0.5"
              value={floorPct}
              onChange={(e) => setFloorPct(e.target.value)}
              disabled={!isAdmin}
              className="w-24 rounded-ctl border border-line-strong bg-paper px-2.5 py-1.5 text-sm text-navy focus:outline-none focus:ring-2 focus:ring-accent disabled:opacity-60"
            />
            <span className="text-sm text-navy/70">%</span>
          </div>
          <p className="mt-1.5 text-xs text-navy/50">
            The sale builder turns a line red below this margin and offers a one-tap fix. Set
            per-category floors from a product&apos;s category later.
          </p>
        </div>

        {isAdmin ? (
          <Button variant="primary" loading={update.isPending} onClick={save}>
            Save changes
          </Button>
        ) : (
          <p className="text-xs text-navy/50">Only admins can change costing settings.</p>
        )}
      </div>
    </div>
  );
}

// ─── TAB: How to pay / remittance (P5-14) ─────────────────────────────────────

function RemittanceTab() {
  const { toast } = useToast();
  const { user } = useAuth();
  const isAdmin = user?.role === "TENANT_ADMIN";
  const { data: config, isLoading } = useRemittanceConfig();
  const update = useUpdateRemittanceConfig();

  const [form, setForm] = React.useState<RemittanceConfig>({});

  React.useEffect(() => {
    if (config) setForm(config);
  }, [config]);

  const set =
    (key: keyof RemittanceConfig) =>
    (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) =>
      setForm((f) => ({ ...f, [key]: e.target.value }));

  const save = () => {
    update.mutate(form, {
      onSuccess: () => toast({ title: "Payment info saved", variant: "success" }),
      onError: () =>
        toast({
          title: "Could not save",
          description: "Only admins can change how-to-pay settings.",
          variant: "error",
        }),
    });
  };

  if (isLoading) return <p className="text-sm text-navy/70">Loading…</p>;

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-lg font-semibold text-navy">How buyers pay you</h2>
        <p className="mt-1 text-sm text-navy/70">
          Remit-to details and payment instructions shown on your buyers&apos; Payments page.
        </p>
      </div>

      <Card className="space-y-5 p-5">
        <h3 className="text-sm font-semibold text-navy">Remit-to details</h3>
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <Input
            label="Pay to"
            value={form.payToName ?? ""}
            onChange={set("payToName")}
            disabled={!isAdmin}
          />
          <Input
            label="Bank name"
            value={form.bankName ?? ""}
            onChange={set("bankName")}
            disabled={!isAdmin}
          />
          <Input
            label="Account name"
            value={form.accountName ?? ""}
            onChange={set("accountName")}
            disabled={!isAdmin}
          />
          <Input
            label="Account number"
            value={form.accountNumber ?? ""}
            onChange={set("accountNumber")}
            disabled={!isAdmin}
          />
          <Input
            label="Routing number"
            value={form.routingNumber ?? ""}
            onChange={set("routingNumber")}
            disabled={!isAdmin}
          />
        </div>
        <Textarea
          label="Mailing address (for checks)"
          rows={3}
          value={form.mailingAddress ?? ""}
          onChange={set("mailingAddress")}
          disabled={!isAdmin}
        />
      </Card>

      <Card className="space-y-5 p-5">
        <h3 className="text-sm font-semibold text-navy">Payment instructions</h3>
        <Textarea
          label="Paying by check"
          rows={3}
          value={form.checkInstructions ?? ""}
          onChange={set("checkInstructions")}
          disabled={!isAdmin}
        />
        <Textarea
          label="ACH instructions"
          rows={3}
          value={form.achInstructions ?? ""}
          onChange={set("achInstructions")}
          disabled={!isAdmin}
        />
        <Textarea
          label="Wire instructions"
          rows={3}
          value={form.wireInstructions ?? ""}
          onChange={set("wireInstructions")}
          disabled={!isAdmin}
        />
        <Textarea
          label="Notes"
          rows={3}
          value={form.notes ?? ""}
          onChange={set("notes")}
          disabled={!isAdmin}
        />
      </Card>

      {isAdmin ? (
        <Button variant="primary" loading={update.isPending} onClick={save}>
          Save changes
        </Button>
      ) : (
        <p className="text-xs text-navy/50">Only admins can change how-to-pay settings.</p>
      )}
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
  const [invoicePrefix, setInvoicePrefix] = React.useState("");
  const [paymentDueDays, setPaymentDueDays] = React.useState("");
  const [savingDefaults, setSavingDefaults] = React.useState(false);

  React.useEffect(() => {
    if (savedSettings) {
      setInvoiceNotes(savedSettings.invoiceNotes ?? "");
      setInvoiceTerms(savedSettings.invoiceTerms ?? "");
      setInvoicePrefix(savedSettings.invoicePrefix ?? "");
      setPaymentDueDays(savedSettings.paymentDueDays ?? "");
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
      await apiClient.patch("/settings", {
        invoiceNotes,
        invoiceTerms,
        invoicePrefix,
        paymentDueDays,
      });
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
          <p className="text-sm text-navy/70">
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

      <Card title="Invoice Numbering">
        <div className="grid grid-cols-2 gap-4">
          <div>
            <label className="mb-1.5 block text-sm font-medium text-navy">
              Invoice Number Prefix
            </label>
            <input
              type="text"
              value={invoicePrefix}
              onChange={(e) => setInvoicePrefix(e.target.value)}
              placeholder="INV-"
              maxLength={10}
              className="h-10 w-full rounded-lg border border-surface-border bg-white px-3 text-sm text-navy placeholder:text-navy/30 focus:border-transparent focus:outline-none focus:ring-2 focus:ring-brand-500"
            />
            <p className="mt-1 text-xs text-navy/70">
              Prepended to invoice numbers (e.g. INV-, 2026-).
            </p>
          </div>
          <div>
            <label className="mb-1.5 block text-sm font-medium text-navy">Payment Due Days</label>
            <input
              type="number"
              value={paymentDueDays}
              onChange={(e) => setPaymentDueDays(e.target.value)}
              placeholder="30"
              min="0"
              max="365"
              className="h-10 w-full rounded-lg border border-surface-border bg-white px-3 text-sm text-navy placeholder:text-navy/30 focus:border-transparent focus:outline-none focus:ring-2 focus:ring-brand-500"
            />
            <p className="mt-1 text-xs text-navy/70">
              Default days until payment is due (0 = due on receipt).
            </p>
          </div>
        </div>
        <div className="mt-4 flex justify-end">
          <Button onClick={handleSaveDefaults} loading={savingDefaults} size="sm">
            Save Numbering
          </Button>
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
            <p className="mt-1 text-xs text-navy/70">
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
            <p className="mt-1 text-xs text-navy/70">
              Printed on every new invoice under &quot;Terms &amp; Conditions&quot;. Preserves line
              breaks.
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

function SettingsPageInner() {
  const { setTitle } = usePageTitle();
  const { toast } = useToast();
  const { user } = useAuth();
  const isAdmin = user?.role === "TENANT_ADMIN";

  React.useEffect(() => {
    setTitle("Settings");
  }, [setTitle]);

  // Show success toast when redirected back from Google link flow
  React.useEffect(() => {
    if (typeof window === "undefined") return;
    const params = new URLSearchParams(window.location.search);
    if (params.get("linked") === "google") {
      toast({
        title: "Google account connected!",
        description: "You can now sign in with Google.",
        variant: "success",
      });
      // Clean the query string without triggering a navigation
      const url = new URL(window.location.href);
      url.searchParams.delete("linked");
      window.history.replaceState({}, "", url.toString());
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const searchParams = useSearchParams();
  const router = useRouter();
  const activeTab = searchParams.get("tab");

  // The in-tab importer was retired in favor of the richer standalone page — keep
  // the old `?tab=import` deep-link working by redirecting to it.
  React.useEffect(() => {
    if (activeTab === "import") router.replace("/settings/import");
  }, [activeTab, router]);

  // Full-hub model: no `?tab=` → the grouped-card hub; a tab → that ONE screen with a
  // "← All settings" back link (the old tab strip is retired). Every screen component
  // is reused unchanged, so the individual settings behave exactly as before, and the
  // existing deep-links (?tab=email from invoices, ?tab=regulated from compliance)
  // still land directly on their screen. Regulated stays admin-only.
  const SECTIONS: Record<string, { title: string; node: React.ReactNode; width?: string }> = {
    profile: { title: "Business profile", node: <BusinessProfileTab />, width: "max-w-3xl" },
    notifications: {
      title: "Notifications",
      node: <NotificationsSettingsTab />,
      width: "max-w-4xl",
    },
    users: { title: "User management", node: <UserManagementTab /> },
    email: { title: "Email (SMTP)", node: <EmailSettingsTab />, width: "max-w-3xl" },
    invoicing: { title: "Invoicing", node: <InvoicingTab />, width: "max-w-3xl" },
    costing: { title: "Costing", node: <CostingTab />, width: "max-w-3xl" },
    remittance: { title: "How to pay", node: <RemittanceTab />, width: "max-w-3xl" },
    integrations: { title: "Integrations", node: <AIIntegrationsTab />, width: "max-w-3xl" },
    account: { title: "My account", node: <MyAccountTab />, width: "max-w-3xl" },
    ...(isAdmin
      ? {
          regulated: {
            title: "Regulated sections",
            node: <RegulatedSettingsTab />,
            width: "max-w-3xl",
          },
        }
      : {}),
  };

  const section = activeTab ? SECTIONS[activeTab] : undefined;

  return (
    // Centred, width-capped column so settings forms don't strand the whole
    // right half of wide screens empty.
    <div className="mx-auto max-w-5xl p-6">
      {!section ? (
        <>
          <h1 className="mb-5 text-2xl font-bold text-navy">Settings</h1>
          <SettingsHub isAdmin={isAdmin} />
          {/* Stripe Connect lives on the hub itself (not behind a `?tab=`) because the
              OAuth callback returns the operator to bare `/settings?stripe=...` and the
              card renders that banner. */}
          <div className="mt-5 max-w-3xl">
            <StripeConnectCard />
          </div>
        </>
      ) : (
        <>
          <NextLink
            href="/settings"
            className="mb-4 inline-flex items-center gap-1.5 text-sm font-medium text-navy/60 transition-colors hover:text-brand-600"
          >
            <ArrowLeft className="h-4 w-4" /> All settings
          </NextLink>
          <h1 className="mb-5 text-2xl font-bold text-navy">{section.title}</h1>
          <div className={section.width ?? ""}>{section.node}</div>
        </>
      )}
    </div>
  );
}

export default function SettingsPage() {
  // useSearchParams requires a Suspense boundary during prerender (Next 14 App Router).
  return (
    <React.Suspense
      fallback={
        <div className="mx-auto max-w-5xl p-6">
          <h1 className="mb-5 text-2xl font-bold text-navy">Settings</h1>
        </div>
      }
    >
      <SettingsPageInner />
    </React.Suspense>
  );
}
