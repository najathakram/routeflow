"use client";

import * as React from "react";
import * as Tabs from "@radix-ui/react-tabs";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import {
  Upload,
  CheckCircle2,
  XCircle,
  RefreshCw,
  Bell,
  Pencil,
  ToggleLeft,
  ToggleRight,
  Copy,
  Check,
  Link as LinkIcon,
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
import { useUsers, useCreateOperator, useChangeUserStatus, AppUser } from "@/lib/api/users";

// ─── Helpers ──────────────────────────────────────────────────────────────────

function TabTrigger({ value, children }: { value: string; children: React.ReactNode }) {
  return (
    <Tabs.Trigger
      value={value}
      className={cn(
        "-mb-px border-b-2 px-5 py-3 text-sm font-medium transition-colors",
        "border-transparent text-navy/60 hover:text-navy",
        "data-[state=active]:border-brand-500 data-[state=active]:text-navy",
      )}
    >
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
  const [logoPreview, setLogoPreview] = React.useState<string | null>(null);
  const fileInputRef = React.useRef<HTMLInputElement>(null);

  const { register, handleSubmit, formState: { errors, isSubmitting } } = useForm<ProfileFormValues>({
    resolver: zodResolver(profileSchema),
    defaultValues: {
      businessName: "RouteFlow Operations LLC",
      ownerName: "Maria Operator",
      phone: "(512) 555-0101",
      email: "ops@routeflow.io",
      street: "1500 S MoPac Expy",
      city: "Austin",
      zip: "78746",
      taxRate: 8.25,
    },
  });

  const handleLogoChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const url = URL.createObjectURL(file);
    setLogoPreview(url);
  };

  const onSubmit = async (_data: ProfileFormValues) => {
    await new Promise((r) => setTimeout(r, 700));
    toast({ title: "Profile saved", description: "Your business profile has been updated.", variant: "success" });
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

// ─── TAB 2: Integrations ──────────────────────────────────────────────────────

const ZOHO_MOCK = {
  connected: true,
  lastSync: "Mar 9, 2026 · 9:14 AM",
  projectId: "routeflow-prod",
};

const FIREBASE_MOCK = {
  fcmProjectId: "routeflow-firebase-prod",
  senderId: "4827193048",
};

function IntegrationsTab() {
  const { toast } = useToast();
  const [zohoConnected, setZohoConnected] = React.useState(ZOHO_MOCK.connected);
  const [lastSync, setLastSync] = React.useState(ZOHO_MOCK.lastSync);
  const [isSyncing, setIsSyncing] = React.useState(false);
  const [isDisconnectOpen, setIsDisconnectOpen] = React.useState(false);

  const handleSync = async () => {
    setIsSyncing(true);
    await new Promise((r) => setTimeout(r, 1800));
    setIsSyncing(false);
    setLastSync("Just now");
    toast({ title: "Zoho sync complete", description: "Products and contacts updated.", variant: "success" });
  };

  const handleDisconnect = () => {
    setZohoConnected(false);
    setIsDisconnectOpen(false);
    toast({ title: "Zoho disconnected", variant: "info" });
  };

  const handleTestNotification = async () => {
    await new Promise((r) => setTimeout(r, 600));
    toast({ title: "Test notification sent", description: "Check your device for the push notification.", variant: "success" });
  };

  return (
    <div className="space-y-5">
      {/* Zoho CRM */}
      <Card title="Zoho CRM">
        <div className="space-y-4">
          {/* Status row */}
          <div className="flex items-center justify-between rounded-lg border border-surface-border bg-surface-raised p-4">
            <div className="flex items-center gap-3">
              <div
                className={cn(
                  "flex h-10 w-10 items-center justify-center rounded-lg font-bold text-white text-sm",
                  zohoConnected ? "bg-success" : "bg-navy/30",
                )}
              >
                Z
              </div>
              <div>
                <p className="text-sm font-semibold text-navy">Zoho CRM</p>
                <p className="text-xs text-navy/50">
                  {zohoConnected ? `Last synced: ${lastSync}` : "Not connected"}
                </p>
              </div>
            </div>
            <div className="flex items-center gap-2">
              {zohoConnected ? (
                <Badge variant="success" label="Connected" />
              ) : (
                <Badge variant="danger" label="Disconnected" />
              )}
            </div>
          </div>

          {/* Actions */}
          <div className="flex flex-wrap gap-2">
            {zohoConnected ? (
              <>
                <Button
                  variant="secondary"
                  size="sm"
                  leftIcon={<RefreshCw className={cn("h-4 w-4", isSyncing && "animate-spin")} />}
                  loading={isSyncing}
                  onClick={handleSync}
                >
                  Sync Now
                </Button>
                <Button
                  variant="danger"
                  size="sm"
                  leftIcon={<XCircle className="h-4 w-4" />}
                  onClick={() => setIsDisconnectOpen(true)}
                >
                  Disconnect
                </Button>
              </>
            ) : (
              <Button
                size="sm"
                leftIcon={<LinkIcon className="h-4 w-4" />}
                onClick={() => {
                  setZohoConnected(true);
                  setLastSync("Just now");
                  toast({ title: "Zoho connected", variant: "success" });
                }}
              >
                Connect Zoho
              </Button>
            )}
          </div>

          {/* OAuth placeholder */}
          {!zohoConnected && (
            <div className="rounded-lg border border-dashed border-surface-border p-4 text-center">
              <p className="text-sm text-navy/50">
                OAuth 2.0 flow will open here.{" "}
                <span className="cursor-pointer text-brand-500 hover:underline">
                  Configure OAuth credentials →
                </span>
              </p>
            </div>
          )}
        </div>
      </Card>

      {/* Firebase */}
      <Card title="Firebase (Push Notifications)">
        <div className="space-y-4">
          <div className="flex items-center justify-between rounded-lg border border-surface-border bg-surface-raised p-4">
            <div className="flex items-center gap-3">
              <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-[#FF6D00] font-bold text-white text-sm">
                F
              </div>
              <div>
                <p className="text-sm font-semibold text-navy">Firebase Cloud Messaging</p>
                <p className="text-xs text-navy/50">Project: {FIREBASE_MOCK.fcmProjectId}</p>
              </div>
            </div>
            <Badge variant="success" label="Connected" />
          </div>

          <div className="grid grid-cols-2 gap-4 text-sm">
            <div>
              <p className="text-xs text-navy/50 mb-1">FCM Project ID</p>
              <p className="font-mono text-navy">{FIREBASE_MOCK.fcmProjectId}</p>
            </div>
            <div>
              <p className="text-xs text-navy/50 mb-1">Sender ID</p>
              <p className="font-mono text-navy">{FIREBASE_MOCK.senderId}</p>
            </div>
          </div>

          <Button
            variant="secondary"
            size="sm"
            leftIcon={<Bell className="h-4 w-4" />}
            onClick={handleTestNotification}
          >
            Test Notification
          </Button>
        </div>
      </Card>

      {/* Disconnect confirm */}
      <Modal
        open={isDisconnectOpen}
        onClose={() => setIsDisconnectOpen(false)}
        title="Disconnect Zoho CRM?"
        description="This will stop product and contact syncing. You can reconnect at any time."
        footer={
          <>
            <Button variant="secondary" onClick={() => setIsDisconnectOpen(false)}>Cancel</Button>
            <Button variant="danger" onClick={handleDisconnect}>Disconnect</Button>
          </>
        }
      >
        <div className="flex items-center gap-3 rounded-lg border border-warning/30 bg-warning-bg p-3">
          <XCircle className="h-5 w-5 shrink-0 text-warning" />
          <p className="text-sm text-navy/80">
            Products will no longer sync from Zoho. Manually-set prices and stock levels will remain.
          </p>
        </div>
      </Modal>
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

function UserManagementTab() {
  const { data, isLoading } = useUsers();
  const changeStatus = useChangeUserStatus();
  const [isAddOpen, setIsAddOpen] = React.useState(false);
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
                        onClick={() => toast({ title: "Edit user — coming soon", variant: "info" })}
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
          <TabTrigger value="profile">Business Profile</TabTrigger>
          <TabTrigger value="integrations">Integrations</TabTrigger>
          <TabTrigger value="users">User Management</TabTrigger>
        </Tabs.List>

        <Tabs.Content value="profile" className="mt-6 max-w-2xl focus:outline-none">
          <BusinessProfileTab />
        </Tabs.Content>

        <Tabs.Content value="integrations" className="mt-6 max-w-2xl focus:outline-none">
          <IntegrationsTab />
        </Tabs.Content>

        <Tabs.Content value="users" className="mt-6 focus:outline-none">
          <UserManagementTab />
        </Tabs.Content>
      </Tabs.Root>
    </div>
  );
}
