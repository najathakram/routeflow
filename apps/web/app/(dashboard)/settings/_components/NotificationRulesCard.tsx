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
import type { EmailSender } from "./useEmailSender";
import { MiniSwitch } from "./MiniSwitch";

/**
 * #1965 (spec 10): the notification rules as a grouped, stacked list (a <ul>, not a table, so it
 * wraps at 390px). It shows what the tenant can control, says who receives each message and which
 * address emails go out from, and says nothing in a row that belongs in a header:
 *  - channels that are not built are named ONCE, inside "Coming soon";
 *  - a channel that exists but isn't set up is stated once, above the list, and its switches are muted;
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

/** One line per event: who gets it, and when. Closed copy keyed by the event code. */
const EVENT_DESCRIPTION: Record<string, string> = {
  ORDER_CONFIRMED: "Sent when an order is confirmed.",
  OUT_FOR_DELIVERY: "Sent when the driver starts the route with this order.",
  ORDER_SHIPPED: "Sent when an order is marked shipped with a carrier (UPS, FedEx and so on).",
  READY_FOR_PICKUP: "Sent when a pickup order is ready for the customer to collect.",
  SHIPMENT_TRACKING_ADDED:
    "Sent once, when a tracking number is first added to an order that has already shipped.",
  DELIVERED: "Sent when the order is delivered.",
  CANCELLED: "Sent when an order is cancelled.",
  ORDER_CHANGED_AT_DOOR: "Sent when a driver changes the order at the door.",
  LICENSE_EXPIRING: "Sent before a customer's licence expires.",
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
  sender,
  onEdit,
}: {
  data: MessagingConfig;
  isAdmin: boolean;
  sender: EmailSender | null;
  onEdit: (event: MatrixEvent) => void;
}) {
  const { toast } = useToast();
  const toggle = useToggleRule();
  // A payload from an API that predates channelStatus (web/API deploy skew): channel availability is
  // unknown, so the rules list is not shown at all rather than guessed at or thrown on.
  const status = data.channelStatus as MessagingConfig["channelStatus"] | undefined;
  if (!status) return null;

  const triggered = data.events.filter((e) => e.hasTrigger);
  const comingSoon = data.events.filter((e) => !e.hasTrigger);
  const hasInternal = triggered.some((e) => e.channels.some((c) => c.channel === "INTERNAL"));

  // Channels that can show a switch: live ones and set-up-pending ones (muted). Never "not built".
  const columns: MessageChannel[] = [
    ...CHANNEL_ORDER.filter((c) => status[c as keyof typeof status] !== "NOT_BUILT"),
    ...(hasInternal ? (["INTERNAL"] as MessageChannel[]) : []),
  ];
  // An event with no usable cell in any shown channel (e.g. Invoice sent: portal-only, or only a
  // policy-locked cell) would be a dead row; the footnote explains invoices instead.
  const live = triggered.filter((e) =>
    e.channels.some((c) => !c.locked && columns.includes(c.channel)),
  );
  const notBuilt = CHANNEL_ORDER.filter((c) => status[c as keyof typeof status] === "NOT_BUILT");
  const notConfigured = CHANNEL_ORDER.filter(
    (c) => status[c as keyof typeof status] === "NOT_CONFIGURED",
  );
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

  const renderSwitch = (event: MatrixEvent, cell: MatrixCell, channel: MessageChannel) => {
    const label = CHANNEL_LABELS[channel];
    if (cell.locked) {
      return (
        <span
          role="img"
          tabIndex={0}
          title="Invoices are sent by email or the buyer portal only"
          aria-label="Invoices are sent by email or the buyer portal only"
          className="inline-flex rounded text-navy/60 focus-visible:outline focus-visible:outline-2 focus-visible:outline-brand-500"
        >
          <Info className="h-4 w-4" aria-hidden="true" />
        </span>
      );
    }
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
    if (cell.unavailable) return null;
    return (
      <MiniSwitch
        checked={cell.enabled}
        disabled={!isAdmin || toggle.isPending}
        ariaLabel={`${event.label} via ${label}`}
        onToggle={() => handleToggle(cell)}
      />
    );
  };

  const renderRow = (event: MatrixEvent) => {
    const description = EVENT_DESCRIPTION[event.eventKey];
    return (
      <li
        key={event.eventKey}
        data-event-row
        className="flex flex-wrap items-start justify-between gap-x-6 gap-y-2 py-3"
      >
        <div className="min-w-0 flex-1 basis-56">
          <div className="flex items-center gap-1.5">
            <span className="text-sm text-navy">{event.label}</span>
            {isAdmin && (
              <button
                type="button"
                onClick={() => onEdit(event)}
                aria-label={`Edit ${event.label} email text`}
                title="Edit email text"
                className="relative rounded p-1 text-navy/60 before:absolute before:-inset-2 before:content-[''] hover:bg-surface-raised hover:text-navy"
              >
                <Pencil className="h-3.5 w-3.5" aria-hidden="true" />
              </button>
            )}
          </div>
          {description && <p className="mt-0.5 text-xs text-navy/70">{description}</p>}
          <div className="mt-1.5">
            <Badge variant="neutral" label={AUDIENCE_LABEL[event.audience]} />
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-x-5 gap-y-2">
          {columns.map((channel) => {
            const cell = event.channels.find((c) => c.channel === channel);
            if (!cell) return null;
            const control = renderSwitch(event, cell, channel);
            if (!control) return null;
            return (
              <div key={channel} className="flex items-center gap-2">
                <span className="text-xs text-navy/70">{CHANNEL_LABELS[channel]}</span>
                {control}
                {channel === "WHATSAPP" && cell.template && !cell.locked && (
                  <Badge
                    variant={WA_STATUS_BADGE[cell.template.waApprovalStatus].variant}
                    label={WA_STATUS_BADGE[cell.template.waApprovalStatus].label}
                    className="whitespace-nowrap"
                  />
                )}
              </div>
            );
          })}
        </div>
      </li>
    );
  };

  const customerEvents = live.filter((e) => e.audience === "CUSTOMER");
  const staffEvents = live.filter((e) => e.audience === "STAFF");

  return (
    <Card title="Notification rules">
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <p className="text-xs text-navy/70">Choose which emails go out for each event.</p>
        {data.msgsMeter && metered && (
          <p className="whitespace-nowrap text-xs font-medium text-navy/70">
            {data.msgsMeter.used}
            {data.msgsMeter.included != null ? ` / ${data.msgsMeter.included}` : ""} messages used
            this period
          </p>
        )}
      </div>

      {sender && (
        <div
          data-sender-row
          className="mb-3 flex flex-wrap items-center gap-x-2 gap-y-1 rounded-lg border border-surface-border bg-surface-raised/40 px-3 py-2 text-sm text-navy/70"
        >
          <span>{`Sending from: ${sender.label}`}</span>
          {isAdmin && (
            <>
              <span aria-hidden="true">·</span>
              <Link
                href={CHANNEL_SETUP_HREF.EMAIL ?? "/settings?tab=email"}
                className="font-medium text-brand-700 hover:underline"
              >
                {sender.kind !== "default"
                  ? "Change sender →"
                  : sender.mailboxAvailable
                    ? "Use your own mailbox →"
                    : "Set up email →"}
              </Link>
            </>
          )}
        </div>
      )}

      {!isAdmin && (
        <p className="mb-3 flex items-center gap-1.5 text-xs">
          <Info className="h-3.5 w-3.5 flex-none text-navy/60" aria-hidden="true" />
          <span className="text-navy/70">Only admins can change notifications</span>
        </p>
      )}

      {notConfigured.map((channel) => {
        const href = CHANNEL_SETUP_HREF[channel];
        return (
          <p
            key={channel}
            className="mb-3 flex flex-wrap items-center gap-x-2 text-xs text-navy/70"
          >
            <span>{`${CHANNEL_LABELS[channel]} · Not set up`}</span>
            {isAdmin && href && (
              <Link href={href} className="font-medium text-brand-700 hover:underline">
                {`Set up ${CHANNEL_LABELS[channel]}`}
              </Link>
            )}
          </p>
        );
      })}

      <div className="space-y-5">
        {customerEvents.length > 0 && (
          <section aria-labelledby="notif-group-customer">
            <h3 id="notif-group-customer" className="text-xs font-semibold text-navy">
              {GROUP_TITLE.CUSTOMER}
            </h3>
            <ul className="mt-1 max-w-3xl divide-y divide-surface-border">
              {customerEvents.map(renderRow)}
            </ul>
          </section>
        )}

        <section aria-labelledby="notif-group-staff">
          <h3 id="notif-group-staff" className="text-xs font-semibold text-navy">
            {GROUP_TITLE.STAFF}
          </h3>
          {staffEvents.length > 0 ? (
            <ul className="mt-1 max-w-3xl divide-y divide-surface-border">
              {staffEvents.map(renderRow)}
            </ul>
          ) : (
            <p className="mt-1 text-xs text-navy/70">
              Your team isn&apos;t emailed about orders yet — coming soon.
            </p>
          )}
        </section>
      </div>

      <p className="mt-4 text-xs text-navy/70">
        Invoices are emailed when you press Send on an invoice.
      </p>

      {(comingSoon.length > 0 || notBuilt.length > 0) && (
        <details className="mt-4 rounded-lg border border-surface-border px-3 py-2">
          <summary className="cursor-pointer text-xs font-semibold text-navy/70">
            Coming soon
          </summary>
          <ul className="mt-2 space-y-1 text-sm text-navy/70">
            {comingSoon.map((event) => (
              <li key={event.eventKey}>
                <span>{event.label}</span>
                {/* per-product low-stock alerts are not built, but the daily digest (admin card below) is live */}
                {event.eventKey === "LOW_STOCK" && isAdmin && (
                  <>
                    {" · "}
                    <a
                      href="#low-stock-digest"
                      className="font-medium text-brand-600 underline-offset-2 hover:underline"
                    >
                      The daily low-stock digest is on below
                    </a>
                  </>
                )}
              </li>
            ))}
            {notBuilt.length > 0 && (
              <li>{joinList(notBuilt.map((c) => COMING_SOON_LABEL[c] ?? CHANNEL_LABELS[c]))}</li>
            )}
          </ul>
        </details>
      )}
    </Card>
  );
}
