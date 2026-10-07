"use client";

import * as React from "react";
import NextLink from "next/link";
import { useQueryClient } from "@tanstack/react-query";
import type {
  FulfilmentMode,
  FulfilmentModeOption,
  FulfilmentPreview,
  FulfilmentSettings,
  UpdateFulfilmentSettingsRequest,
} from "@routeflow/types";
import { Badge, Button, Card, Modal, Skeleton, useToast } from "@routeflow/ui/web";
import {
  FULFILMENT_REFUSAL,
  FULFILMENT_SETTINGS_KEY,
  fulfilmentRefusalOf,
  settingsFromStaleBody,
  useFulfilmentPreview,
  useFulfilmentSettings,
  useUpdateFulfilmentSettings,
} from "@/lib/api/fulfilment-settings";
import { useUsers } from "@/lib/api/users";
import { MiniSwitch } from "./MiniSwitch";

/**
 * Settings → Fulfillment (dark behind the API's FULFILMENT_SELF_SERVE; the page mounts this tab only
 * when GET /settings/fulfilment says `selfServe`). Two cards over the `fulfilment_model` and
 * `counter_sales` settings. Every change goes: choose -> Review Change (a server-built preview, nothing
 * written) -> Confirm Change (PATCH with the fingerprint that was reviewed). The server owns the effects
 * text and every refusal; this tab shows them and sends exactly what the admin chose.
 */
const COPY = {
  modes: {
    delivery: ["On our own trucks", "Orders go on your delivery routes."],
    ship: ["By carrier", "Orders ship with UPS, FedEx or another carrier."],
    both: ["Our trucks and by carrier", "Staff choose per order; customers choose in the portal."],
    pickup: ["Pickup at our store", "Customers collect orders. New Order opens the counter."],
    pickup_ship: [
      "Pickup and by carrier",
      "Customers collect or you ship. New Order opens the counter.",
    ],
    unset: [
      "No preference (today's setup)",
      "Staff choose trucks or carrier per order. Customers don't choose.",
    ],
  } satisfies Record<FulfilmentMode, [string, string]>,
  deliveryTitle: "Delivery method",
  deliveryIntro:
    "How new orders reach your customers. Orders you already have keep their delivery method.",
  counterTitle: "Counter sales",
  counterIntro: "Lets staff ring up walk-in customers and take payment on one screen.",
  counterSwitch: "Allow counter sales",
  counterAlways: "In-store businesses always have the counter.",
  openCounter: "Open the Counter",
  notOnPlan: "Not on your plan",
  needsPlan: "Needs Routes or Order delivery on your plan.",
  notYet: "Not available yet",
  planLink: "See Plan & Billing",
  review: "Review Change",
  confirm: "Confirm Change",
  saving: "Saving…",
  cancel: "Cancel",
  reviewAgain: "Review Again",
  loadFailed: "Couldn't load your fulfillment settings.",
  tryAgain: "Try Again",
  readOnly: "Only an admin can change these settings.",
  stale: "Someone changed this a moment ago. Review the new setting before you try again.",
  needsFleet: "Own delivery needs Routes or Order delivery on your plan.",
  saveFailed: "Couldn't save your change. Try again.",
  previewFailed: "Couldn't review that change. Try again.",
  savedModel: "Delivery method updated.",
  savedCounterOn: "Counter sales turned on.",
  savedCounterOff: "Counter sales turned off.",
  stays: "What stays the same",
} as const;

const PLAN_LINK = "/settings/billing";
const COUNTER_LINK = "/orders/counter-sale";

const modeTitle = (m: string) => COPY.modes[m as FulfilmentMode]?.[0] ?? m;
const onOff = (v: string) => (v === "on" ? "On" : "Off");

type ReviewError =
  { kind: "stale" } | { kind: "carrier"; count: number } | { kind: "fleet" } | { kind: "other" };

interface Review {
  request: UpdateFulfilmentSettingsRequest;
  preview: FulfilmentPreview;
  error: ReviewError | null;
}

function reviewTitle(request: UpdateFulfilmentSettingsRequest): string {
  if (request.fulfilmentModel !== undefined) return "Change delivery method?";
  return request.counterSales === "on" ? "Turn on counter sales?" : "Turn off counter sales?";
}

function changeLine(preview: FulfilmentPreview): string | null {
  const c = preview.changes[0];
  if (!c) return null;
  return c.key === "fulfilmentModel"
    ? `${modeTitle(c.from)} → ${modeTitle(c.to)}`
    : `Counter sales: ${onOff(c.from)} → ${onOff(c.to)}`;
}

function Skel() {
  return (
    <div data-testid="fulfilment-skeleton" className="space-y-5" aria-busy="true">
      <Card>
        <Skeleton width={160} height={18} className="mb-4" />
        <div className="space-y-3">
          {Array.from({ length: 6 }, (_, i) => (
            <div
              key={i}
              data-testid="fulfilment-skeleton-radio"
              className="flex items-start gap-3 rounded-lg border border-surface-border p-3"
            >
              <Skeleton shape="circle" width={16} height={16} />
              <div className="flex-1 space-y-2">
                <Skeleton width="45%" height={14} />
                <Skeleton width="80%" height={12} />
              </div>
            </div>
          ))}
        </div>
      </Card>
      <Card>
        <Skeleton width={140} height={18} className="mb-4" />
        <div data-testid="fulfilment-skeleton-switch" className="flex items-center gap-3">
          <Skeleton width={36} height={20} />
          <Skeleton width="50%" height={14} />
        </div>
      </Card>
    </div>
  );
}

/** Operators read the tab but cannot change it; name the admins who can, when the list is readable. */
function ReadOnlyNote() {
  const { data } = useUsers({ status: "ACTIVE" });
  const admins = (data?.data ?? []).filter((u) => u.role === "TENANT_ADMIN").map((u) => u.username);
  return (
    <p className="text-xs text-navy/60">
      {COPY.readOnly}
      {admins.length > 0 ? ` Your admins: ${admins.join(", ")}.` : ""}
    </p>
  );
}

function OptionRow({
  option,
  selected,
  disabled,
  onSelect,
}: {
  option: FulfilmentModeOption;
  selected: boolean;
  disabled: boolean;
  onSelect: () => void;
}) {
  const id = React.useId();
  const [title, hint] = COPY.modes[option.key];
  const blocked = !option.selectable;
  return (
    <div
      className={`flex items-start gap-3 rounded-lg border p-3 ${
        selected ? "border-brand-500 bg-brand-50/40" : "border-surface-border"
      } ${blocked ? "opacity-80" : ""}`}
    >
      <input
        type="radio"
        id={id}
        name="fulfilment-model"
        value={option.key}
        checked={selected}
        disabled={disabled || blocked}
        onChange={onSelect}
        aria-describedby={`${id}-hint`}
        className="mt-1 h-4 w-4 flex-none"
      />
      <div className="min-w-0 flex-1">
        <label htmlFor={id} className="block text-sm font-medium text-navy">
          {title}
        </label>
        <p id={`${id}-hint`} className="text-xs text-navy/60">
          {hint}
        </p>
        {blocked && option.blockedBy === "plan" && (
          <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1">
            <Badge variant="neutral">{COPY.notOnPlan}</Badge>
            <span className="text-xs text-navy/70">{COPY.needsPlan}</span>
            <NextLink
              href={PLAN_LINK}
              className="text-xs font-medium text-brand-600 underline underline-offset-2"
            >
              {COPY.planLink}
            </NextLink>
          </div>
        )}
        {blocked && option.blockedBy === "proposed" && (
          <div className="mt-2">
            <Badge variant="neutral">{COPY.notYet}</Badge>
          </div>
        )}
      </div>
    </div>
  );
}

export function FulfillmentSettingsTab() {
  const { toast } = useToast();
  const qc = useQueryClient();
  const { data, isLoading, isError, refetch } = useFulfilmentSettings();
  const previewMut = useFulfilmentPreview();
  const updateMut = useUpdateFulfilmentSettings();
  const [draft, setDraft] = React.useState<FulfilmentMode | null>(null);
  const [review, setReview] = React.useState<Review | null>(null);
  const opener = React.useRef<HTMLElement | null>(null);
  const reviewBtn = React.useRef<HTMLButtonElement>(null);
  const switchWrap = React.useRef<HTMLDivElement>(null);

  if (isLoading) return <Skel />;
  if (isError || !data) {
    return (
      <Card>
        <div className="flex flex-col gap-3 text-sm text-navy/70 sm:flex-row sm:items-center sm:justify-between">
          <span>{COPY.loadFailed}</span>
          <Button variant="secondary" size="sm" onClick={() => refetch()}>
            {COPY.tryAgain}
          </Button>
        </div>
      </Card>
    );
  }

  const settings: FulfilmentSettings = data;
  const canEdit = settings.canEdit;
  const stored = settings.fulfilmentModel.value;
  const selected = draft ?? stored;
  const counterOn = settings.counterSales.effective !== "off";
  const counterLocked = settings.counterSales.effective === "always";

  function openReview(request: UpdateFulfilmentSettingsRequest, from: HTMLElement | null) {
    opener.current = from;
    previewMut.mutate(request, {
      onSuccess: (preview) => {
        if (preview.changes.length === 0) {
          setDraft(null);
          return;
        }
        setReview({ request, preview, error: null });
      },
      onError: () => toast({ variant: "error", title: COPY.previewFailed }),
    });
  }

  function confirm() {
    if (!review) return;
    const { request, preview } = review;
    updateMut.mutate(
      { ...request, fingerprint: preview.fingerprint },
      {
        onSuccess: () => {
          toast({
            variant: "success",
            title:
              request.fulfilmentModel !== undefined
                ? COPY.savedModel
                : request.counterSales === "on"
                  ? COPY.savedCounterOn
                  : COPY.savedCounterOff,
          });
          setReview(null);
          setDraft(null);
        },
        onError: (err) => {
          const refusal = fulfilmentRefusalOf(err);
          if (refusal.code === FULFILMENT_REFUSAL.stale) {
            const fresh = refusal.data ? settingsFromStaleBody(refusal.data) : null;
            if (fresh) qc.setQueryData(FULFILMENT_SETTINGS_KEY, fresh);
            setReview({ ...review, error: { kind: "stale" } });
          } else if (refusal.code === FULFILMENT_REFUSAL.carrier) {
            const count = Number(refusal.data?.count ?? 0);
            setReview({ ...review, error: { kind: "carrier", count } });
          } else if (refusal.code === FULFILMENT_REFUSAL.needsFleet) {
            setReview({ ...review, error: { kind: "fleet" } });
          } else {
            setReview({ ...review, error: { kind: "other" } });
            toast({ variant: "error", title: COPY.saveFailed });
          }
        },
      },
    );
  }

  async function reviewAgain() {
    if (!review) return;
    const { request } = review;
    await refetch();
    previewMut.mutate(request, {
      onSuccess: (preview) => {
        if (preview.changes.length === 0) {
          setReview(null);
          setDraft(null);
          return;
        }
        setReview({ request, preview, error: null });
      },
      onError: () => toast({ variant: "error", title: COPY.previewFailed }),
    });
  }

  const err = review?.error ?? null;
  const pending = updateMut.isPending;
  const lastChange = settings.lastChange;

  return (
    <div className="space-y-5">
      <Card id="delivery-method" title={COPY.deliveryTitle}>
        <p className="mb-4 text-sm text-navy/70">{COPY.deliveryIntro}</p>
        <div role="radiogroup" aria-label={COPY.deliveryTitle} className="space-y-2">
          {settings.fulfilmentModel.options.map((option) => (
            <OptionRow
              key={option.key}
              option={option}
              selected={selected === option.key}
              disabled={!canEdit || previewMut.isPending}
              onSelect={() => setDraft(option.key)}
            />
          ))}
        </div>
        {canEdit ? (
          <div className="mt-4 flex">
            <Button
              ref={reviewBtn}
              className="w-full sm:w-auto"
              disabled={selected === stored || previewMut.isPending}
              onClick={() => openReview({ fulfilmentModel: selected }, reviewBtn.current)}
            >
              {COPY.review}
            </Button>
          </div>
        ) : (
          <div className="mt-4">
            <ReadOnlyNote />
          </div>
        )}
      </Card>

      <Card id="counter-sales" title={COPY.counterTitle}>
        <p className="mb-4 text-sm text-navy/70">{COPY.counterIntro}</p>
        <div className="flex items-center justify-between gap-4">
          <div className="min-w-0 text-sm font-medium text-navy">{COPY.counterSwitch}</div>
          <div
            ref={switchWrap}
            className="-m-1 flex min-h-[44px] min-w-[44px] flex-none items-center justify-center"
          >
            <MiniSwitch
              checked={counterOn}
              disabled={!canEdit || counterLocked || previewMut.isPending}
              ariaLabel={COPY.counterSwitch}
              onToggle={() =>
                openReview(
                  { counterSales: counterOn ? "off" : "on" },
                  switchWrap.current?.querySelector<HTMLElement>('[role="switch"]') ?? null,
                )
              }
            />
          </div>
        </div>
        {counterLocked && <p className="mt-2 text-xs text-navy/60">{COPY.counterAlways}</p>}
        {counterOn && (
          <p className="mt-3 text-sm">
            <NextLink
              href={COUNTER_LINK}
              className="font-medium text-brand-600 underline underline-offset-2"
            >
              {COPY.openCounter}
            </NextLink>
          </p>
        )}
      </Card>

      {lastChange && (
        <p className="text-xs text-navy/55">
          {`Last changed by ${
            lastChange.by === "business" && lastChange.name ? lastChange.name : "RouteFlow support"
          } on ${new Date(lastChange.at).toLocaleDateString("en-US", {
            year: "numeric",
            month: "short",
            day: "numeric",
          })}.`}
        </p>
      )}

      <Modal
        open={review !== null}
        onClose={() => {
          if (!pending) setReview(null);
        }}
        title={review ? reviewTitle(review.request) : undefined}
        onCloseAutoFocus={(e) => {
          e.preventDefault();
          opener.current?.focus();
        }}
        scroll
        footer={
          review && (
            <>
              <Button variant="secondary" onClick={() => setReview(null)} disabled={pending}>
                {COPY.cancel}
              </Button>
              {err?.kind === "stale" || err?.kind === "carrier" ? (
                <Button onClick={reviewAgain} disabled={previewMut.isPending}>
                  {COPY.reviewAgain}
                </Button>
              ) : err?.kind === "fleet" ? null : (
                <Button onClick={confirm} disabled={pending}>
                  {pending ? COPY.saving : COPY.confirm}
                </Button>
              )}
            </>
          )
        }
      >
        {review && (
          <div className="space-y-4">
            {err?.kind === "stale" && <p role="alert">{COPY.stale}</p>}
            {err?.kind === "carrier" && (
              <p role="alert">
                {err.count === 1
                  ? "1 order is with the carrier. Try again after it is delivered."
                  : `${err.count} orders are with the carrier. Try again after they are delivered.`}
              </p>
            )}
            {err?.kind === "fleet" && (
              <p role="alert">
                {COPY.needsFleet}{" "}
                <NextLink
                  href={PLAN_LINK}
                  className="font-medium text-brand-600 underline underline-offset-2"
                >
                  {COPY.planLink}
                </NextLink>
              </p>
            )}
            {err?.kind === "other" && <p role="alert">{COPY.saveFailed}</p>}
            {!err && (
              <>
                {changeLine(review.preview) && (
                  <p className="font-medium text-navy">{changeLine(review.preview)}</p>
                )}
                {review.preview.effects.length > 0 && (
                  <ul className="list-disc space-y-1 pl-5">
                    {review.preview.effects.map((e) => (
                      <li key={e.code}>{e.text}</li>
                    ))}
                  </ul>
                )}
                {review.preview.notChanged.length > 0 && (
                  <div>
                    <p className="mb-1 text-xs font-semibold uppercase tracking-wide text-navy/60">
                      {COPY.stays}
                    </p>
                    <ul className="list-disc space-y-1 pl-5 text-navy/70">
                      {review.preview.notChanged.map((t) => (
                        <li key={t}>{t}</li>
                      ))}
                    </ul>
                  </div>
                )}
              </>
            )}
          </div>
        )}
      </Modal>
    </div>
  );
}
