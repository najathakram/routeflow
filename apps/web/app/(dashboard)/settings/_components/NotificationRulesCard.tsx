"use client";

import * as React from "react";
import Link from "next/link";
import { Info, Pencil } from "lucide-react";
import { Badge, Card, useToast } from "@routeflow/ui/web";
import type { NotificationAudience } from "@routeflow/types";
import {
  useToggleRule,
  type MatrixCell,
  type MatrixEvent,
  type MessageChannel,
  type MessagingConfig,
  type WaApprovalStatus,
} from "@/lib/api/messaging";
import { MiniSwitch } from "./MiniSwitch";

/**
 * #1965 (spec 10): the notification rules as a grouped list. It shows what the tenant can control,
 * says who receives each message, and says nothing in a cell that belongs in a header:
 *  - channels that are not built appear ONCE ("… coming soon"), never as disabled columns;
 *  - a channel that exists but isn't set up gets ONE header link, and muted cells with a tooltip;
 *  - events with no firing site are listed under "Coming soon" with no switch.
 */

const CHANNEL_ORDER: MessageChannel[] = ["EMAIL", "WHATSAPP", "SMS", "PORTAL"];

const CHANNEL_LABELS: Record<MessageChannel, string> = {
  INTERNAL: "Internal",
  WHATSAPP: "WhatsApp",
  SMS: "SMS",
  EMAIL: "Email",
  PORTAL: "Portal",
};

// Where "Set up →" goes once a channel ships a setup page (none is configurable today).
// TODO(channel ships): the whatsapp/sms/portal keys are NOT settings SECTIONS yet, so they would land
// on the hub; point each at its real section in the same PR that makes that channel NOT_CONFIGURED.
const CHANNEL_SETUP_HREF: Partial<Record<MessageChannel, string>> = {
  EMAIL: "/settings?tab=email",
  WHATSAPP: "/settings?tab=whatsapp",
  SMS: "/settings?tab=sms",
  PORTAL: "/settings?tab=portal",
};

const AUDIENCE_LABEL: Record<NotificationAudience, string> = {
  CUSTOMER: "Your customer",
  STAFF: "Your team",
};

const GROUP_TITLE: Record<NotificationAudience, string> = {
  CUSTOMER: "Emails to your customers",
  STAFF: "Emails to your team",
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

const COMING_SOON_LABEL: Partial<Record<MessageChannel, string>> = {
  WHATSAPP: "WhatsApp",
  SMS: "SMS",
  PORTAL: "customer portal messages",
};

function joinList(items: string[]): string {
  if (items.length <= 1) return items.join("");
  return `${items.slice(0, -1).join(", ")} and ${items[items.length - 1]}`;
}

export function NotificationRulesCard({
  data,
  isAdmin,
  onEdit,
}: {
  data: MessagingConfig;
  isAdmin: boolean;
  onEdit: (event: MatrixEvent) => void;
}) {
  const { toast } = useToast();
  const toggle = useToggleRule();
  const status = data.channelStatus;

  const triggered = data.events.filter((e) => e.hasTrigger);
  const comingSoon = data.events.filter((e) => !e.hasTrigger);
  const hasInternal = triggered.some((e) => e.channels.some((c) => c.channel === "INTERNAL"));

  const columns: MessageChannel[] = [
    ...CHANNEL_ORDER.filter((c) => status[c as keyof typeof status] !== "NOT_BUILT"),
    ...(hasInternal ? (["INTERNAL"] as MessageChannel[]) : []),
  ];
  // An event with no cell in any visible column (e.g. Invoice sent: portal-only) would render a
  // dead row; the footnote explains invoices instead.
  const live = triggered.filter((e) =>
    e.channels.some((c) => !c.locked && columns.includes(c.channel)),
  );
  const notBuilt = CHANNEL_ORDER.filter((c) => status[c as keyof typeof status] === "NOT_BUILT");
  const metered = status.WHATSAPP === "LIVE" || status.SMS === "LIVE";

  const handleToggle = (cell: MatrixCell) => {
    if (!cell.ruleId) return;
    toggle.mutate(
      { ruleId: cell.ruleId, enabled: !cell.enabled },
      {
        onError: () => toast({ title: "Couldn't save, please try again", variant: "error" }),
      },
    );
  };

  const renderCell = (event: MatrixEvent, channel: MessageChannel) => {
    const cell = event.channels.find((c) => c.channel === channel);
    if (!cell) return <span className="text-navy/30">—</span>;
    if (cell.locked) {
      return (
        <span
          role="img"
          tabIndex={0}
          title="Invoices are sent by email or the buyer portal only"
          aria-label="Invoices are sent by email or the buyer portal only"
          className="inline-flex rounded text-navy/40 focus-visible:outline focus-visible:outline-2 focus-visible:outline-brand-500"
        >
          <Info className="h-4 w-4" aria-hidden="true" />
        </span>
      );
    }
    const label = CHANNEL_LABELS[channel];
    if (channel !== "INTERNAL" && status[channel as keyof typeof status] === "NOT_CONFIGURED") {
      return (
        <MiniSwitch
          checked={false}
          ariaDisabled
          title={`Set up ${label} to use this`}
          description={`Set up ${label} to use this`}
          ariaLabel={`${event.label} via ${label} (not set up)`}
          onToggle={() => undefined}
        />
      );
    }
    if (cell.unavailable) return <span className="text-navy/30">—</span>;
    return (
      <div className="flex flex-col items-center gap-1">
        <MiniSwitch
          checked={cell.enabled}
          disabled={!isAdmin || toggle.isPending}
          ariaLabel={`${event.label} via ${label}`}
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
    );
  };

  const groups = (["CUSTOMER", "STAFF"] as NotificationAudience[])
    .map((audience) => ({ audience, events: live.filter((e) => e.audience === audience) }))
    .filter((g) => g.events.length > 0);

  return (
    <Card title="Notification rules">
      <div className="mb-4 flex flex-wrap items-center justify-between gap-2">
        <p className="text-xs text-navy/70">Choose which emails go out for each event.</p>
        {data.msgsMeter && metered && (
          <p className="whitespace-nowrap text-xs font-medium text-navy/70">
            {data.msgsMeter.used}
            {data.msgsMeter.included != null ? ` / ${data.msgsMeter.included}` : ""} messages used
            this period
          </p>
        )}
      </div>
      {!isAdmin && (
        <p className="mb-3 text-xs text-navy/50">Only admins can change notifications</p>
      )}

      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-surface-border text-left text-xs font-semibold uppercase tracking-wide text-navy/60">
              <th scope="col" className="py-2 pr-2">
                Event
              </th>
              <th scope="col" className="px-2 py-2">
                Who receives this
              </th>
              {columns.map((channel) => {
                const notSetUp =
                  channel !== "INTERNAL" &&
                  status[channel as keyof typeof status] === "NOT_CONFIGURED";
                const href = CHANNEL_SETUP_HREF[channel];
                return (
                  <th key={channel} scope="col" className="px-2 py-2 text-center">
                    {notSetUp ? (
                      <div className="flex flex-col items-center normal-case">
                        <span>{`${CHANNEL_LABELS[channel]} · Not set up`}</span>
                        {href && (
                          <Link
                            href={href}
                            className="text-[11px] font-medium text-brand-700 hover:underline"
                          >
                            {`Set up ${CHANNEL_LABELS[channel]}`}
                          </Link>
                        )}
                      </div>
                    ) : (
                      CHANNEL_LABELS[channel]
                    )}
                  </th>
                );
              })}
            </tr>
          </thead>
          {groups.map((group) => (
            <tbody key={group.audience}>
              <tr>
                <th
                  scope="rowgroup"
                  colSpan={2 + columns.length}
                  className="pb-1 pt-4 text-left text-xs font-semibold text-navy"
                >
                  {GROUP_TITLE[group.audience]}
                </th>
              </tr>
              {group.events.map((event) => (
                <tr
                  key={event.eventKey}
                  data-event-row
                  className="border-b border-surface-border last:border-0"
                >
                  <td className="py-2 pr-2">
                    <div className="flex items-center gap-1.5">
                      <span className="text-navy">{event.label}</span>
                      <button
                        type="button"
                        onClick={() => onEdit(event)}
                        aria-label={`Edit ${event.label} template`}
                        className="rounded p-1 text-navy/50 hover:bg-surface-raised hover:text-navy"
                      >
                        <Pencil className="h-3.5 w-3.5" />
                      </button>
                    </div>
                  </td>
                  <td className="px-2 py-2">
                    <Badge
                      variant="neutral"
                      label={AUDIENCE_LABEL[event.audience]}
                      className="whitespace-nowrap"
                    />
                  </td>
                  {columns.map((channel) => (
                    <td key={channel} className="px-2 py-2 text-center align-middle">
                      {renderCell(event, channel)}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          ))}
        </table>
      </div>

      <div className="mt-3 space-y-1 text-xs text-navy/50">
        <p>Invoices are emailed when you press Send on an invoice.</p>
        <p>
          Emails send from your connected mailbox, then your SMTP setup, then RouteFlow&apos;s
          address.{" "}
          <Link href="/settings?tab=email" className="font-medium text-brand-700 hover:underline">
            Set up email
          </Link>
        </p>
        {!groups.some((g) => g.audience === "STAFF") && (
          <p>Your team isn&apos;t emailed about orders yet. Team emails are coming soon.</p>
        )}
        {notBuilt.length > 0 && (
          <p>{`${joinList(notBuilt.map((c) => COMING_SOON_LABEL[c] ?? CHANNEL_LABELS[c]))}: coming soon`}</p>
        )}
      </div>

      {comingSoon.length > 0 && (
        <details className="mt-4 rounded-lg border border-surface-border px-3 py-2">
          <summary className="cursor-pointer text-xs font-semibold text-navy/70">
            Coming soon
          </summary>
          <ul className="mt-2 space-y-1 text-sm text-navy/60">
            {comingSoon.map((event) => (
              <li key={event.eventKey}>{event.label}</li>
            ))}
          </ul>
        </details>
      )}
    </Card>
  );
}
