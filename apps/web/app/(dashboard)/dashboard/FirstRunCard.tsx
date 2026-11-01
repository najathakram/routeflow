"use client";

import * as React from "react";
import Link from "next/link";
import { Button, Card } from "@routeflow/ui/web";
import { API_ERROR_CODES } from "@routeflow/types";
import { STORE_STATE_HREF } from "@/components/RestrictionRemedyActions";
import {
  firstRunErrorCode,
  useAnswerFirstRun,
  type FirstRunAnswer,
  type FirstRunStatus,
} from "@/lib/api/first-run";

/** The one address a person writes to when they want the setup changed later (COPY 2p). */
const CHANGE_LATER_EMAIL = "hello@routeflow.info";

const TICKS: { key: keyof FirstRunAnswer; label: string }[] = [
  { key: "delivery", label: "We deliver with our own trucks" },
  { key: "shipping", label: "We ship by carrier" },
  { key: "counter", label: "Customers pick up or buy at the counter" },
];

/** What a refused answer says. A closed question is not an error to the person: the card just goes away on the re-read. */
export function firstRunErrorLine(error: unknown): string | null {
  const code = firstRunErrorCode(error);
  if (code === API_ERROR_CODES.FIRST_RUN_CLOSED) return null;
  if (code === API_ERROR_CODES.FULFILMENT_CARRIER_IN_TRANSIT) {
    return "Orders are with the carrier right now. Try again once they're delivered.";
  }
  if (code === API_ERROR_CODES.FIRST_RUN_EMPTY) return "Choose at least one.";
  // Not every refusal can be retried (a 403 stays a 403), so this line promises nothing but a way to reach us.
  return `We couldn't set up your account. If this keeps happening, email ${CHANGE_LATER_EMAIL}.`;
}

function NextStep({ href, children }: { href: string; children: React.ReactNode }) {
  return (
    <li>
      <Link href={href} className="font-medium text-brand-700 underline">
        {children}
      </Link>
    </li>
  );
}

/**
 * W1 (COPY 2p): the first question on a new account. Three ticks, one button. Nothing else on the page asks
 * until it is answered, and it never shows on an account that already has a setup (the API sends no state).
 * After the answer it turns into the next steps and the Workspace ID, which is what a person types to sign in.
 */
export function FirstRunCard({ status }: { status: FirstRunStatus | undefined }) {
  const answer = useAnswerFirstRun();
  const [ticks, setTicks] = React.useState<FirstRunAnswer>({});
  const [tried, setTried] = React.useState(false);
  const [result, setResult] = React.useState<"applied" | "kept" | null>(null);

  if (!status?.state) return null;
  const pending = status.state === "pending" && result === null;
  const answered = result !== null || status.state === "answered";
  if (!pending && !answered) return null;
  // After the first order the steps have done their job.
  if (answered && status.hasOrder) return null;

  if (pending) {
    const none = !ticks.delivery && !ticks.shipping && !ticks.counter;
    const errorLine = answer.isError ? firstRunErrorLine(answer.error) : null;
    const submit = () => {
      setTried(true);
      if (none) return;
      answer.mutate(
        {
          delivery: !!ticks.delivery,
          shipping: !!ticks.shipping,
          counter: !!ticks.counter,
        },
        { onSuccess: (res) => setResult(res.outcome) },
      );
    };
    return (
      <Card data-testid="first-run-card">
        <h2 id="first-run-title" className="text-base font-semibold text-navy">
          How do orders reach your customers?
        </h2>
        <fieldset
          aria-labelledby="first-run-title"
          className="mt-3"
          aria-describedby={tried && none ? "first-run-none" : undefined}
        >
          {TICKS.map(({ key, label }) => (
            <label
              key={key}
              className="flex min-h-[44px] cursor-pointer items-center gap-2 text-sm text-navy"
            >
              <input
                type="checkbox"
                className="h-4 w-4"
                checked={!!ticks[key]}
                onChange={(e) => setTicks((t) => ({ ...t, [key]: e.target.checked }))}
              />
              {label}
            </label>
          ))}
        </fieldset>
        {tried && none && (
          <p id="first-run-none" role="alert" className="mt-2 text-sm text-danger">
            Choose at least one.
          </p>
        )}
        {errorLine && (
          <p role="alert" className="mt-2 text-sm text-danger">
            {errorLine}
          </p>
        )}
        <div className="mt-4">
          <Button onClick={submit} loading={answer.isPending}>
            Set up my account
          </Button>
        </div>
        <p className="mt-3 text-xs text-navy/70">
          Need to change this later? Email{" "}
          <a href={`mailto:${CHANGE_LATER_EMAIL}`} className="underline">
            {CHANGE_LATER_EMAIL}
          </a>
          .
        </p>
      </Card>
    );
  }

  const delivers = status.delivery;
  const counter = status.counter;
  return (
    <Card data-testid="first-run-done">
      {/* A kept setup is not "ready": the owner is told it may be half set up (COPY 2q), so the heading never claims it. */}
      <h2 className="text-base font-semibold text-navy">
        {result === "kept"
          ? "Your account is already set up, so we left it as it is."
          : "Your account is ready."}
      </h2>
      <p className="mt-1 text-sm text-navy/70">
        Your Workspace ID is <span className="font-mono font-medium">{status.workspaceId}</span>.
        You&apos;ll need it to sign in.
      </p>
      <ul className="mt-3 list-disc space-y-1 pl-5 text-sm">
        <NextStep href="/products">Add your products</NextStep>
        <NextStep href="/customers">Add your customers</NextStep>
        <NextStep href="/orders/new">Take your first order</NextStep>
        {delivers && <NextStep href={STORE_STATE_HREF}>Add your business address</NextStep>}
        {delivers && <NextStep href="/drivers">Add a driver</NextStep>}
        {delivers && <NextStep href="/routes/create">Plan your first route</NextStep>}
        {counter && <NextStep href="/orders/counter-sale">Start a counter sale</NextStep>}
      </ul>
    </Card>
  );
}
