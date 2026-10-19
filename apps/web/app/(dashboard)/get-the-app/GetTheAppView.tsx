import * as React from "react";
import Link from "next/link";
import type { AppLinks } from "@routeflow/types";
import { hasAnyAppLink } from "@routeflow/types";
import { Card } from "@routeflow/ui/web";

export interface GetTheAppViewProps {
  links: AppLinks;
  /** True inside the RouteFlow app shell: the user already has the app. */
  inShell: boolean;
}

const BUTTON =
  "inline-flex min-h-[44px] w-full items-center justify-center rounded-lg bg-[#0B6E6B] px-4 py-2.5 text-sm font-semibold text-white hover:bg-[#095b59] sm:w-auto";

/** True when the link is an Apple TestFlight invite (no store URL is spelled out in source). */
function isTestFlight(url: string): boolean {
  try {
    const host = new URL(url).hostname;
    return host.startsWith("testflight.") && host.endsWith(".apple.com");
  } catch {
    return false;
  }
}

function Option({
  title,
  note,
  children,
}: {
  title: string;
  note?: string;
  children: React.ReactNode;
}) {
  return (
    <Card>
      <h2 className="text-base font-semibold text-navy">{title}</h2>
      {note && <p className="mt-1 text-sm text-navy/70">{note}</p>}
      <div className="mt-3">{children}</div>
    </Card>
  );
}

/**
 * The install options that are ready, nothing else. Pure: the page passes the links the server
 * returned and whether it runs inside the app shell. No URL is built here; each button is the
 * server-validated https link as given.
 */
export function GetTheAppView({ links, inShell }: GetTheAppViewProps) {
  if (inShell) {
    return (
      <div className="mx-auto max-w-3xl p-4 sm:p-6">
        <Card>
          <p className="text-sm text-navy">You&apos;re already using the app.</p>
        </Card>
      </div>
    );
  }

  if (!hasAnyAppLink(links)) {
    return (
      <div className="mx-auto max-w-3xl p-4 sm:p-6">
        <Card>
          <p className="text-sm text-navy">The app isn&apos;t available yet. Check back soon.</p>
          <p className="mt-2 text-sm">
            <Link href="/dashboard" className="font-medium text-[#0B6E6B] hover:underline">
              Back to the dashboard
            </Link>
          </p>
        </Card>
      </div>
    );
  }

  return (
    <div className="mx-auto flex max-w-3xl flex-col gap-4 p-4 sm:p-6">
      <p className="text-sm text-navy/70">Install RouteFlow on your phone or tablet.</p>
      {links.androidApkUrl && (
        <Option title="Android" note="Allow installs from your browser when Android asks.">
          {/* Cross-origin `download` is ignored by browsers, so the APK is a plain link. */}
          <a href={links.androidApkUrl} className={BUTTON}>
            Download for Android
          </a>
        </Option>
      )}
      {links.playStoreUrl && (
        <Option title="Google Play">
          <a href={links.playStoreUrl} target="_blank" rel="noopener noreferrer" className={BUTTON}>
            Get it on Google Play
          </a>
        </Option>
      )}
      {links.iosUrl && (
        <Option
          title="iPhone and iPad"
          note={isTestFlight(links.iosUrl) ? "Opens TestFlight" : undefined}
        >
          <a href={links.iosUrl} target="_blank" rel="noopener noreferrer" className={BUTTON}>
            Get it for iPhone
          </a>
        </Option>
      )}
    </div>
  );
}
