"use client";

import * as React from "react";
import type { TenantOnboardingView } from "@routeflow/types";
import { ONBOARDING_STAGE_CUSTOMER_LABEL, ONBOARDING_STAGE_VALUES } from "@routeflow/types";
import { Badge, Button, Card, Input, cn } from "@routeflow/ui/web";
import { fmtCalendarDate } from "@/lib/formatting";

/** Customer-facing names for the back office's stages (#2159 S4) — shared with mobile. */
export const STAGE_LABEL = ONBOARDING_STAGE_CUSTOMER_LABEL;

export interface GettingStartedViewProps {
  onboarding: TenantOnboardingView;
  /** Only the workspace admin, signed in as themselves, sees the sign-off form. */
  canSignOff: boolean;
  signing: boolean;
  signOffError: string | null;
  onSignOff: (signedName: string) => void;
}

/**
 * The workspace's "Getting started" checklist: where onboarding stands, the steps that are
 * the customer's to do, and the written sign-off. Stateless apart from the typed name, so
 * it can be pinned without the page's data hooks.
 */
export function GettingStartedView({
  onboarding,
  canSignOff,
  signing,
  signOffError,
  onSignOff,
}: GettingStartedViewProps) {
  const [name, setName] = React.useState("");
  const current = ONBOARDING_STAGE_VALUES.indexOf(onboarding.stage);
  const live = onboarding.status === "LIVE";
  const byStage = ONBOARDING_STAGE_VALUES.map((stage) => ({
    stage,
    steps: onboarding.steps.filter((s) => s.stage === stage),
  })).filter((g) => g.steps.length > 0);
  const signOff = onboarding.signOff;

  return (
    <div className="mx-auto flex max-w-3xl flex-col gap-6 p-4 sm:p-6">
      <Card>
        <h2 className="text-lg font-semibold text-navy">
          {live ? "You're live" : `Now: ${STAGE_LABEL[onboarding.stage]}`}
        </h2>
        <p className="mt-1 text-sm text-navy/70">
          {live
            ? "Onboarding is complete. Your RouteFlow team is still here if you need anything."
            : onboarding.status === "ON_HOLD"
              ? "Onboarding is paused for now. Your onboarding lead will pick it back up with you."
              : "Here's where your onboarding stands and what we need from you."}
          {onboarding.targetGoLiveOn && !live && (
            <> Target go-live: {fmtCalendarDate(onboarding.targetGoLiveOn)}.</>
          )}
        </p>
        <ol className="mt-4 flex flex-wrap gap-2" aria-label="Onboarding stages">
          {ONBOARDING_STAGE_VALUES.map((stage, i) => {
            const state = live || i < current ? "done" : i === current ? "current" : "upcoming";
            return (
              <li
                key={stage}
                aria-current={state === "current" ? "step" : undefined}
                className={cn(
                  "rounded-full px-3 py-1 text-xs",
                  state === "done" && "bg-emerald-50 text-emerald-800",
                  state === "current" && "bg-[#0B6E6B] font-medium text-white",
                  state === "upcoming" && "bg-surface-raised text-navy/60",
                )}
              >
                {STAGE_LABEL[stage]}
              </li>
            );
          })}
        </ol>
      </Card>

      {byStage.map(({ stage, steps }) => (
        <Card key={stage}>
          <h3 className="text-base font-semibold text-navy">{STAGE_LABEL[stage]}</h3>
          <ul className="mt-3 divide-y divide-surface-border">
            {steps.map((s) => (
              <li key={s.key} className="flex items-start justify-between gap-3 py-3">
                <div className="min-w-0">
                  <p className="text-sm text-navy">
                    {s.title}
                    {!s.required && <span className="text-navy/50"> (optional)</span>}
                  </p>
                  {s.check && s.status === "PENDING" && (
                    <p
                      className={cn(
                        "mt-0.5 text-xs",
                        s.check.ok ? "text-emerald-700" : "text-amber-700",
                      )}
                    >
                      {s.check.detail}
                    </p>
                  )}
                </div>
                <Badge variant={s.status === "PENDING" ? "neutral" : "success"}>
                  {s.status === "PENDING" ? "To do" : s.status === "DONE" ? "Done" : "Not needed"}
                </Badge>
              </li>
            ))}
          </ul>
        </Card>
      ))}

      {signOff && (
        <Card data-testid="onboarding-sign-off">
          <h3 className="text-base font-semibold text-navy">Sign-off</h3>
          {signOff.status === "DONE" ? (
            <p className="mt-1 text-sm text-navy/70">
              Signed off
              {signOff.signedName ? ` by ${signOff.signedName}` : ""}
              {signOff.signedAt ? ` on ${fmtCalendarDate(signOff.signedAt.slice(0, 10))}` : ""}.
            </p>
          ) : !signOff.available ? (
            <p className="mt-1 text-sm text-navy/70">
              Once training is done and you&apos;re happy with the setup, the workspace admin signs
              off here. We&apos;ll let you know when it&apos;s time.
            </p>
          ) : !canSignOff ? (
            <p className="mt-1 text-sm text-navy/70">
              Sign-off is open. Your workspace admin needs to sign in and give it here.
            </p>
          ) : (
            <form
              className="mt-2 flex flex-col gap-3"
              onSubmit={(e) => {
                e.preventDefault();
                onSignOff(name);
              }}
            >
              <p className="text-sm text-navy/70">
                By signing off you confirm your team has been trained and the workspace is set up
                the way you agreed. Type your full name to sign.
              </p>
              <Input
                id="onboarding-signed-name"
                label="Your full name"
                value={name}
                onChange={(e) => setName(e.target.value)}
                autoComplete="name"
                maxLength={120}
                error={signOffError ?? undefined}
              />
              <div>
                <Button type="submit" loading={signing} disabled={name.trim().length < 2}>
                  Sign off
                </Button>
              </div>
            </form>
          )}
        </Card>
      )}
    </div>
  );
}
