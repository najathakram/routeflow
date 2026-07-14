"use client";

import * as React from "react";
import { Bell, Loader2, Lock, Pencil } from "lucide-react";
import { Badge, Button, Card, Input, Modal, Textarea, cn, useToast } from "@routeflow/ui/web";
import { useAuth } from "@/lib/auth-context";
import { useNotificationsStatus, useSendTestNotification } from "@/lib/api/notifications";
import {
  useMessagingConfig,
  useToggleRule,
  useUpdateTemplate,
  usePreviewTemplate,
  useUpdateMessagingSettings,
  extractTemplateVars,
  type MessageChannel,
  type MatrixCell,
  type MatrixEvent,
  type MessagingSettings,
  type WaApprovalStatus,
} from "@/lib/api/messaging";

/**
 * Settings → Notifications (P6-6): the real event×channel rules matrix +
 * template editor + quiet hours, replacing the old dummy checkbox list. The
 * genuine push-status card (device registration + send-test) is kept as-is.
 */

const CHANNELS: MessageChannel[] = ["INTERNAL", "WHATSAPP", "SMS", "EMAIL", "PORTAL"];

const CHANNEL_LABELS: Record<MessageChannel, string> = {
  INTERNAL: "Internal",
  WHATSAPP: "WhatsApp",
  SMS: "SMS",
  EMAIL: "Email",
  PORTAL: "Portal",
};

const WA_STATUS_BADGE: Record<
  WaApprovalStatus,
  { variant: "success" | "warning" | "danger" | "neutral"; label: string }
> = {
  NONE: { variant: "neutral", label: "No WA template" },
  PENDING: { variant: "warning", label: "Pending approval" },
  APPROVED: { variant: "success", label: "Approved" },
  REJECTED: { variant: "danger", label: "Rejected" },
};

/** Sample values covering every `{{var}}` used across the seeded default
 * templates, so the preview panel always renders something meaningful
 * without a round trip through real order/invoice data. */
const SAMPLE_VARS: Record<string, string> = {
  customerName: "Jane Doe",
  orderNumber: "ORD-1042",
  deliveryDate: "Jul 15",
  orderTotal: "$128.50",
  driverName: "Sam",
  changeSummary: "2 items removed",
  invoiceNumber: "INV-2031",
  invoiceTotal: "$540.00",
  dueDate: "Jul 20",
  amountDue: "$540.00",
  expiryDate: "Aug 1",
  productName: "Acme Widget",
  quantity: "3",
  reason: "No answer at door",
  amount: "$85.00",
};

// ─── Mini switch (MerchFlagToggle's role="switch" idiom, compact) ─────────────

function MiniSwitch({
  checked,
  disabled,
  onToggle,
  ariaLabel,
}: {
  checked: boolean;
  disabled?: boolean;
  onToggle: () => void;
  ariaLabel: string;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={ariaLabel}
      disabled={disabled}
      onClick={onToggle}
      className={cn(
        "relative inline-flex h-5 w-9 flex-none items-center rounded-full transition-colors disabled:cursor-not-allowed disabled:opacity-50",
        checked ? "bg-brand-500" : "bg-navy/20",
      )}
    >
      <span
        className={cn(
          "inline-block h-4 w-4 transform rounded-full bg-white shadow transition-transform",
          checked ? "translate-x-4" : "translate-x-0.5",
        )}
      />
    </button>
  );
}

// ─── Main tab ───────────────────────────────────────────────────────────────

export function NotificationsSettingsTab() {
  const { user } = useAuth();
  const isAdmin = user?.role === "TENANT_ADMIN";
  const { toast } = useToast();
  const { data, isLoading } = useMessagingConfig();
  const toggle = useToggleRule();

  const [openEventKey, setOpenEventKey] = React.useState<string | null>(null);
  const [selectedChannel, setSelectedChannel] = React.useState<MessageChannel | null>(null);

  const openEvent = data?.events.find((e) => e.eventKey === openEventKey) ?? null;

  const openEditor = (event: MatrixEvent) => {
    const firstChannel = event.channels.find((c) => !c.locked)?.channel ?? null;
    setOpenEventKey(event.eventKey);
    setSelectedChannel(firstChannel);
  };
  const closeEditor = () => {
    setOpenEventKey(null);
    setSelectedChannel(null);
  };

  const handleToggle = (cell: MatrixCell) => {
    if (!cell.ruleId) return;
    toggle.mutate(
      { ruleId: cell.ruleId, enabled: !cell.enabled },
      {
        onError: (err: any) =>
          toast({
            title: "Failed to update",
            description: err?.response?.data?.message ?? "Could not update the rule",
            variant: "error",
          }),
      },
    );
  };

  if (isLoading || !data) {
    return (
      <div className="flex items-center justify-center py-10">
        <Loader2 className="h-6 w-6 animate-spin text-navy/50" />
      </div>
    );
  }

  return (
    <div className="space-y-5">
      <Card title="Notification rules">
        <div className="mb-4 flex flex-wrap items-center justify-between gap-2">
          <p className="text-xs text-navy/70">
            Toggle which channels fire for each event. Locked cells are blocked by policy and
            can&apos;t be enabled.
          </p>
          {data.msgsMeter && (
            <p className="whitespace-nowrap text-xs font-medium text-navy/70">
              {data.msgsMeter.used}
              {data.msgsMeter.included != null ? ` / ${data.msgsMeter.included}` : ""} messages used
              this period
            </p>
          )}
        </div>
        {!isAdmin && (
          <p className="mb-3 text-xs text-navy/50">
            Only Tenant Admins can change notification rules and templates.
          </p>
        )}

        <div className="overflow-x-auto">
          <table className="w-full min-w-[640px] text-sm">
            <thead>
              <tr className="border-b border-surface-border text-left text-xs font-semibold uppercase tracking-wide text-navy/60">
                <th className="py-2 pr-2">Event</th>
                {CHANNELS.map((channel) => (
                  <th key={channel} className="px-2 py-2 text-center">
                    {CHANNEL_LABELS[channel]}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {data.events.map((event) => (
                <tr key={event.eventKey} className="border-b border-surface-border last:border-0">
                  <td className="py-2 pr-2">
                    <div className="flex items-center gap-1.5">
                      <span className="text-navy">{event.label}</span>
                      <button
                        type="button"
                        onClick={() => openEditor(event)}
                        aria-label={`Edit ${event.label} template`}
                        className="rounded p-1 text-navy/50 hover:bg-surface-raised hover:text-navy"
                      >
                        <Pencil className="h-3.5 w-3.5" />
                      </button>
                    </div>
                  </td>
                  {CHANNELS.map((channel) => {
                    const cell = event.channels.find((c) => c.channel === channel);
                    if (!cell) {
                      return (
                        <td key={channel} className="px-2 py-2 text-center text-navy/30">
                          —
                        </td>
                      );
                    }
                    if (cell.locked) {
                      return (
                        <td key={channel} className="px-2 py-2 text-center">
                          <span
                            title="Invoices can't be sent over WhatsApp or SMS"
                            aria-label="Locked: invoices can't be sent over WhatsApp or SMS"
                            className="inline-flex text-navy/40"
                          >
                            <Lock className="h-4 w-4" aria-hidden="true" />
                          </span>
                        </td>
                      );
                    }
                    return (
                      <td key={channel} className="px-2 py-2 text-center align-top">
                        <div className="flex flex-col items-center gap-1">
                          <MiniSwitch
                            checked={cell.enabled}
                            disabled={!isAdmin || toggle.isPending}
                            ariaLabel={`${cell.enabled ? "Disable" : "Enable"} ${event.label} via ${CHANNEL_LABELS[channel]}`}
                            onToggle={() => handleToggle(cell)}
                          />
                          {channel === "WHATSAPP" && cell.template && (
                            <Badge
                              variant={WA_STATUS_BADGE[cell.template.waApprovalStatus].variant}
                              label={WA_STATUS_BADGE[cell.template.waApprovalStatus].label}
                              className="whitespace-nowrap"
                            />
                          )}
                        </div>
                      </td>
                    );
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Card>

      <QuietHoursCard settings={data.settings} isAdmin={isAdmin} />

      <PushStatusCard />

      {openEvent && (
        <TemplateEditorModal
          event={openEvent}
          selectedChannel={selectedChannel}
          onSelectChannel={setSelectedChannel}
          isAdmin={isAdmin}
          onClose={closeEditor}
        />
      )}
    </div>
  );
}

// ─── Template editor modal ─────────────────────────────────────────────────

function TemplateEditorModal({
  event,
  selectedChannel,
  onSelectChannel,
  isAdmin,
  onClose,
}: {
  event: MatrixEvent;
  selectedChannel: MessageChannel | null;
  onSelectChannel: (channel: MessageChannel) => void;
  isAdmin: boolean;
  onClose: () => void;
}) {
  const { toast } = useToast();
  const updateTemplate = useUpdateTemplate();
  const preview = usePreviewTemplate();
  const bodyRef = React.useRef<HTMLTextAreaElement>(null);

  const pillChannels = event.channels.filter((c) => !c.locked);
  const cell = event.channels.find((c) => c.channel === selectedChannel) ?? null;
  const template = cell?.template ?? null;

  const [body, setBody] = React.useState(template?.body ?? "");
  const [waTemplateName, setWaTemplateName] = React.useState(template?.waTemplateName ?? "");
  const [isActive, setIsActive] = React.useState(template?.isActive ?? true);

  // Reset local edit state whenever the selected channel's template changes
  // (i.e. switching channel pills, or the modal opening on a fresh template).
  React.useEffect(() => {
    setBody(template?.body ?? "");
    setWaTemplateName(template?.waTemplateName ?? "");
    setIsActive(template?.isActive ?? true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [template?.id]);

  const variables = React.useMemo(() => extractTemplateVars(body), [body]);

  // Splice a `{{var}}` token into the body at the textarea's cursor/selection,
  // then re-focus and place the caret just after the inserted token.
  const insertVariable = (name: string) => {
    const token = `{{${name}}}`;
    const el = bodyRef.current;
    const start = el?.selectionStart ?? body.length;
    const end = el?.selectionEnd ?? body.length;
    setBody(body.slice(0, start) + token + body.slice(end));
    requestAnimationFrame(() => {
      const node = bodyRef.current;
      if (!node) return;
      node.focus();
      const caret = start + token.length;
      node.setSelectionRange(caret, caret);
    });
  };

  const [previewResult, setPreviewResult] = React.useState<{ rendered: string } | null>(null);
  React.useEffect(() => {
    if (!body) {
      setPreviewResult(null);
      return;
    }
    const handle = setTimeout(() => {
      preview.mutate(
        { body, vars: SAMPLE_VARS },
        { onSuccess: (result) => setPreviewResult(result) },
      );
    }, 400);
    return () => clearTimeout(handle);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [body]);

  const save = () => {
    if (!template) return;
    updateTemplate.mutate(
      {
        id: template.id,
        dto: {
          body,
          ...(selectedChannel === "WHATSAPP" ? { waTemplateName } : {}),
          isActive,
        },
      },
      {
        onSuccess: () => {
          toast({ title: "Template saved", variant: "success" });
          onClose();
        },
        onError: (err: any) =>
          toast({
            title: "Failed to save",
            description: err?.response?.data?.message ?? "Could not save the template",
            variant: "error",
          }),
      },
    );
  };

  return (
    <Modal
      open
      onClose={onClose}
      title={`${event.label} template`}
      className="max-w-2xl"
      footer={
        template && isAdmin ? (
          <>
            <Button variant="secondary" onClick={onClose}>
              Cancel
            </Button>
            <Button onClick={save} loading={updateTemplate.isPending}>
              Save
            </Button>
          </>
        ) : undefined
      }
    >
      <div className="space-y-4">
        <div className="flex flex-wrap gap-1.5">
          {pillChannels.map((c) => (
            <button
              key={c.channel}
              type="button"
              onClick={() => onSelectChannel(c.channel)}
              className={cn(
                "rounded-full border px-3 py-1 text-xs font-medium transition-colors",
                c.channel === selectedChannel
                  ? "border-brand-500 bg-brand-50 text-brand-700"
                  : "border-surface-border text-navy/70 hover:bg-surface-raised",
              )}
            >
              {CHANNEL_LABELS[c.channel]}
            </button>
          ))}
        </div>

        {template && (
          <>
            <Textarea
              ref={bodyRef}
              label="Message body"
              value={body}
              onChange={(e) => setBody(e.target.value)}
              disabled={!isAdmin}
              rows={5}
            />

            <div className="flex flex-wrap gap-1.5">
              {variables.length === 0 ? (
                <span className="text-xs text-navy/50">No variables in this template.</span>
              ) : (
                variables.map((v) => (
                  <button
                    key={v}
                    type="button"
                    disabled={!isAdmin}
                    onClick={() => insertVariable(v)}
                    aria-label={`Insert {{${v}}} variable`}
                    className="rounded-full bg-surface-raised px-2 py-0.5 font-mono text-[11px] text-navy/70 transition-colors hover:bg-brand-50 hover:text-brand-700 disabled:cursor-not-allowed disabled:opacity-50 disabled:hover:bg-surface-raised disabled:hover:text-navy/70"
                  >
                    {`{{${v}}}`}
                  </button>
                ))
              )}
            </div>

            <div className="rounded-lg border border-surface-border bg-surface-raised/40 p-3">
              <p className="mb-1 text-[11px] font-semibold uppercase tracking-wide text-navy/60">
                Preview
              </p>
              <p className="whitespace-pre-wrap text-sm text-navy">
                {preview.isPending ? "Rendering…" : (previewResult?.rendered ?? body)}
              </p>
            </div>

            {selectedChannel === "WHATSAPP" && (
              <div className="space-y-2 rounded-lg border border-surface-border p-3">
                <Input
                  label="Meta template name"
                  value={waTemplateName}
                  onChange={(e) => setWaTemplateName(e.target.value)}
                  disabled={!isAdmin}
                  placeholder="e.g. order_confirmed_v1"
                />
                <div className="flex items-center gap-2">
                  <Badge
                    variant={WA_STATUS_BADGE[template.waApprovalStatus].variant}
                    label={WA_STATUS_BADGE[template.waApprovalStatus].label}
                  />
                  <p className="text-[11px] text-navy/50">
                    Meta approval is managed elsewhere; this name links to the approved template.
                  </p>
                </div>
              </div>
            )}

            <div className="flex items-center gap-2">
              <MiniSwitch
                checked={isActive}
                disabled={!isAdmin}
                ariaLabel={isActive ? "Deactivate template" : "Activate template"}
                onToggle={() => setIsActive((v) => !v)}
              />
              <span className="text-sm text-navy">Template active</span>
            </div>
          </>
        )}
      </div>
    </Modal>
  );
}

// ─── Quiet hours ────────────────────────────────────────────────────────────

function QuietHoursCard({ settings, isAdmin }: { settings: MessagingSettings; isAdmin: boolean }) {
  const { toast } = useToast();
  const update = useUpdateMessagingSettings();

  const [enabled, setEnabled] = React.useState(settings.quietHoursEnabled);
  const [start, setStart] = React.useState(settings.quietHoursStart);
  const [end, setEnd] = React.useState(settings.quietHoursEnd);

  React.useEffect(() => {
    setEnabled(settings.quietHoursEnabled);
    setStart(settings.quietHoursStart);
    setEnd(settings.quietHoursEnd);
  }, [settings.quietHoursEnabled, settings.quietHoursStart, settings.quietHoursEnd]);

  const dirty =
    enabled !== settings.quietHoursEnabled ||
    start !== settings.quietHoursStart ||
    end !== settings.quietHoursEnd;

  const save = () => {
    update.mutate(
      { quietHoursEnabled: enabled, quietHoursStart: start, quietHoursEnd: end },
      {
        onSuccess: () => toast({ title: "Quiet hours updated", variant: "success" }),
        onError: (err: any) =>
          toast({
            title: "Failed to update quiet hours",
            description: err?.response?.data?.message,
            variant: "error",
          }),
      },
    );
  };

  return (
    <Card title="Quiet hours">
      <p className="mb-3 text-xs text-navy/70">
        Customer-facing messages are held outside this window; internal alerts still send.
      </p>
      <div className="flex flex-wrap items-center gap-4">
        <div className="flex items-center gap-2">
          <MiniSwitch
            checked={enabled}
            disabled={!isAdmin}
            ariaLabel={enabled ? "Disable quiet hours" : "Enable quiet hours"}
            onToggle={() => setEnabled((v) => !v)}
          />
          <span className="text-sm text-navy">Enabled</span>
        </div>
        <label className="flex items-center gap-2 text-sm text-navy">
          From
          <input
            type="time"
            value={start}
            disabled={!isAdmin || !enabled}
            onChange={(e) => setStart(e.target.value)}
            aria-label="Quiet hours start"
            className="rounded border border-surface-border px-2 py-1 text-sm text-navy disabled:opacity-50"
          />
        </label>
        <label className="flex items-center gap-2 text-sm text-navy">
          To
          <input
            type="time"
            value={end}
            disabled={!isAdmin || !enabled}
            onChange={(e) => setEnd(e.target.value)}
            aria-label="Quiet hours end"
            className="rounded border border-surface-border px-2 py-1 text-sm text-navy disabled:opacity-50"
          />
        </label>
      </div>
      {isAdmin && (
        <div className="mt-4 flex justify-end">
          <Button size="sm" onClick={save} loading={update.isPending} disabled={!dirty}>
            Save
          </Button>
        </div>
      )}
    </Card>
  );
}

// ─── Push notifications (kept from the old tab; fake checkbox list removed) ──

function PushStatusCard() {
  const { toast } = useToast();
  const { data: notificationsStatus } = useNotificationsStatus();
  const sendTest = useSendTestNotification();

  const handleTestNotification = () => {
    sendTest.mutate(undefined, {
      onSuccess: (result) =>
        toast({
          title: "Test notification sent",
          description: `Sent to ${result.sent} of ${result.deviceCount} device(s).`,
          variant: "success",
        }),
      onError: (err: any) => toast({ title: "Failed", description: err.message, variant: "error" }),
    });
  };

  return (
    <Card title="Push notifications">
      <div className="space-y-4">
        <div className="flex items-center justify-between rounded-lg border border-surface-border bg-surface-raised p-4">
          <div className="flex items-center gap-3">
            <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-brand-50">
              <Bell className="h-5 w-5 text-brand-500" />
            </div>
            <div>
              <p className="text-sm font-semibold text-navy">Driver App Notifications</p>
              <p className="text-xs text-navy/70">
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
          <div className="text-sm text-navy/70">
            <p>
              Push notifications allow drivers to receive real-time alerts for new orders and route
              assignments. Contact your system administrator to enable this feature.
            </p>
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
  );
}
