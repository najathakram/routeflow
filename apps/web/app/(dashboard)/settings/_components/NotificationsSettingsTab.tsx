"use client";

import * as React from "react";
import { Bell } from "lucide-react";
import {
  Badge,
  Button,
  Card,
  Input,
  Modal,
  SkeletonRows,
  Textarea,
  cn,
  useToast,
} from "@routeflow/ui/web";
import { isAccountAdmin } from "@/lib/auth";
import { useAuth } from "@/lib/auth-context";
import { LowStockDigestToggle } from "./LowStockDigestToggle";
import { useNotificationsStatus, useSendTestNotification } from "@/lib/api/notifications";
import { MiniSwitch } from "./MiniSwitch";
import { NotificationRulesCard } from "./NotificationRulesCard";
import { DeliveryHealthStrip } from "./DeliveryHealthStrip";
import { useEmailSender } from "./useEmailSender";
import {
  useMessagingConfig,
  useUpdateTemplate,
  usePreviewTemplate,
  useUpdateMessagingSettings,
  extractTemplateVars,
  type MessageChannel,
  type MatrixEvent,
  type MessagingSettings,
  type WaApprovalStatus,
} from "@/lib/api/messaging";

/**
 * Settings → Notifications (P6-6): the real event×channel rules matrix +
 * template editor + quiet hours, replacing the old dummy checkbox list. The
 * genuine push-status card (device registration + send-test) is kept as-is.
 */

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

// ─── Main tab ───────────────────────────────────────────────────────────────

export function NotificationsSettingsTab() {
  const { user } = useAuth();
  const isAdmin = isAccountAdmin(user);
  const { data, isLoading, isError, refetch } = useMessagingConfig();
  const { sender } = useEmailSender(isAdmin);

  const [openEventKey, setOpenEventKey] = React.useState<string | null>(null);
  const [selectedChannel, setSelectedChannel] = React.useState<MessageChannel | null>(null);

  const openEvent = data?.events.find((e) => e.eventKey === openEventKey) ?? null;

  const isLiveChannel = (channel: MessageChannel) =>
    channel === "INTERNAL" || data?.channelStatus?.[channel] === "LIVE";

  const openEditor = (event: MatrixEvent) => {
    // Only channels that are built AND set up get a template editor; opens on the first live one (Email).
    const firstChannel =
      event.channels.find((c) => !c.locked && isLiveChannel(c.channel))?.channel ?? null;
    setOpenEventKey(event.eventKey);
    setSelectedChannel(firstChannel);
  };
  const closeEditor = () => {
    setOpenEventKey(null);
    setSelectedChannel(null);
  };

  if (isError && !data) {
    // Only the rules fetch failed: the push card is independent and keeps rendering. (Quiet hours
    // is read from the same /messaging/config response, so it cannot render without it.)
    return (
      <div className="space-y-5">
        <Card title="Notification rules">
          <div className="flex flex-wrap items-center gap-3">
            <p role="alert" className="text-sm text-navy">
              Couldn&apos;t load notification settings.
            </p>
            <Button variant="secondary" size="sm" className="min-h-11" onClick={() => refetch()}>
              Retry
            </Button>
          </div>
        </Card>
        <PushStatusCard />
      </div>
    );
  }

  if (isLoading || !data) {
    return (
      <Card title="Notification rules">
        <div role="status" aria-label="Loading notification settings">
          <table className="w-full">
            <tbody>
              <SkeletonRows rows={4} columns={["55%", "20%", "15%"]} />
            </tbody>
          </table>
        </div>
      </Card>
    );
  }

  return (
    <div className="space-y-5">
      {isError && (
        <p role="alert" className="text-xs text-danger">
          Couldn&apos;t refresh notification settings.
        </p>
      )}
      <DeliveryHealthStrip isAdmin={isAdmin} />

      <NotificationRulesCard data={data} isAdmin={isAdmin} sender={sender} onEdit={openEditor} />

      <QuietHoursCard settings={data.settings} isAdmin={isAdmin} />

      {isAdmin && <LowStockDigestToggle />}

      <PushStatusCard />

      {openEvent && (
        <TemplateEditorModal
          event={openEvent}
          selectedChannel={selectedChannel}
          isLiveChannel={isLiveChannel}
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
  isLiveChannel,
  onSelectChannel,
  isAdmin,
  onClose,
}: {
  event: MatrixEvent;
  selectedChannel: MessageChannel | null;
  isLiveChannel: (channel: MessageChannel) => boolean;
  onSelectChannel: (channel: MessageChannel) => void;
  isAdmin: boolean;
  onClose: () => void;
}) {
  const { toast } = useToast();
  const updateTemplate = useUpdateTemplate();
  const preview = usePreviewTemplate();
  const bodyRef = React.useRef<HTMLTextAreaElement>(null);

  const pillChannels = event.channels.filter((c) => !c.locked && isLiveChannel(c.channel));
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
        onError: () => toast({ title: "Couldn't save, please try again", variant: "error" }),
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
        onError: () => toast({ title: "Couldn't save, please try again", variant: "error" }),
      },
    );
  };

  return (
    <Card title="Quiet hours">
      <p className="mb-3 text-xs text-navy/70">
        The window is recorded for reporting; messages are not yet held or delayed during it.
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
            className="w-32 rounded border border-surface-border px-2 py-1 text-sm text-navy disabled:opacity-50"
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
            className="w-32 rounded border border-surface-border px-2 py-1 text-sm text-navy disabled:opacity-50"
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
      onError: () => toast({ title: "Couldn't send the test notification", variant: "error" }),
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
