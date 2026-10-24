"use client";

import * as React from "react";
import type { AppLinks } from "@routeflow/types";
import { Card, Skeleton } from "@routeflow/ui/web";
import { usePageTitle } from "@/lib/page-title-context";
import { useAppLinks } from "@/lib/api/app-links";
import { isInShell } from "@/lib/in-shell";
import { GetTheAppView } from "./GetTheAppView";

const NO_LINKS: AppLinks = { androidApkUrl: null, playStoreUrl: null, iosUrl: null };

/** Row 559 — the install options for the native app, from the global links the super admin sets. */
export default function GetTheAppPage() {
  const { setTitle } = usePageTitle();
  const { data, isLoading } = useAppLinks();
  // The shell mark lives on <html>; read it after mount so SSR and first paint agree.
  const [inShell, setInShell] = React.useState(false);

  React.useEffect(() => setTitle("Get the app"), [setTitle]);
  React.useEffect(() => setInShell(isInShell()), []);

  if (isLoading) {
    return (
      <div className="mx-auto flex max-w-3xl flex-col gap-3 p-4 sm:p-6" aria-busy="true">
        <Card>
          <Skeleton height={96} />
        </Card>
      </div>
    );
  }

  // An older api without the route errors: show the empty copy (fails closed).
  return <GetTheAppView links={data ?? NO_LINKS} inShell={inShell} />;
}
