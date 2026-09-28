"use client";

import * as React from "react";
import Link from "next/link";
import { Card, Skeleton } from "@routeflow/ui/web";
import { usePageTitle } from "@/lib/page-title-context";
import { useAuth } from "@/lib/auth-context";
import { getImpersonation, subscribeImpersonation } from "@/lib/impersonation";
import { signOffErrorCopy, useOnboardingSignOff, useTenantOnboarding } from "@/lib/api/onboarding";
import { GettingStartedView } from "./GettingStartedView";

/** #2159 S4 — the workspace's onboarding checklist and written sign-off. */
export default function GettingStartedPage() {
  const { setTitle } = usePageTitle();
  const { user } = useAuth();
  const { data, isLoading, isError } = useTenantOnboarding();
  const signOff = useOnboardingSignOff();
  const [impersonating, setImpersonating] = React.useState(false);

  React.useEffect(() => setTitle("Getting started"), [setTitle]);
  React.useEffect(() => {
    const read = () => setImpersonating(getImpersonation() !== null);
    read();
    return subscribeImpersonation(read);
  }, []);

  if (isLoading) {
    return (
      <div className="mx-auto flex max-w-3xl flex-col gap-3 p-4 sm:p-6" aria-busy="true">
        <Skeleton height={96} />
        <Skeleton height={160} />
      </div>
    );
  }
  if (isError || !data?.onboarding) {
    return (
      <div className="mx-auto max-w-3xl p-4 sm:p-6">
        <Card>
          <h2 className="text-lg font-semibold text-navy">No onboarding in progress</h2>
          <p className="mt-1 text-sm text-navy/70">
            There&apos;s nothing to set up here right now.{" "}
            <Link href="/dashboard" className="font-medium text-[#0B6E6B] hover:underline">
              Back to the dashboard
            </Link>
          </p>
        </Card>
      </div>
    );
  }

  return (
    <GettingStartedView
      onboarding={data.onboarding}
      canSignOff={user?.role === "TENANT_ADMIN" && !impersonating}
      signing={signOff.isPending}
      signOffError={signOff.isError ? signOffErrorCopy(signOff.error) : null}
      onSignOff={(signedName) => signOff.mutate({ signedName })}
    />
  );
}
