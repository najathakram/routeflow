import "./auth-shell.css";
import type { ReactNode } from "react";
import Link from "next/link";
import { SiteFrame } from "@/components/site-frame/SiteFrame";
import type { AuthAudience } from "./auth-copy";

export interface AuthShellProps {
  /** Which door this is. Pages still pass it; the shell no longer shows a story panel. */
  audience: AuthAudience;
  kicker: string;
  title: string;
  lead?: ReactNode;
  logoUrl?: string | null;
  logoAlt?: string;
  footer?: ReactNode;
  children: ReactNode;
}

// The sign-in, sign-up and password pages: the site's header and footer around one card. The
// header's logo and name already lead home, so the page has no back link of its own.
export function AuthShell({
  audience,
  kicker,
  title,
  lead,
  logoUrl,
  logoAlt,
  footer,
  children,
}: AuthShellProps) {
  return (
    <SiteFrame width="narrow" hideTrial={audience === "retailer"}>
      <div className="rf-auth">
        <div className="rf-auth-card">
          {logoUrl ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              className="rf-auth-tenant-logo"
              src={logoUrl}
              alt={logoAlt ?? "Workspace logo"}
              height={40}
            />
          ) : null}
          <span className="rf-kicker">{kicker}</span>
          <h1>{title}</h1>
          {lead ? <p className="rf-auth-lead">{lead}</p> : null}
          {children}
        </div>
        <div className="rf-auth-footer">
          {/* Always rendered, even with no `footer` prop, so the footer's
              `justify-content: space-between` keeps "Need help?" at the end
              instead of collapsing it to the left edge. */}
          <div className="rf-auth-footer-links">{footer}</div>
          <Link href="/contact">Need help?</Link>
        </div>
      </div>
    </SiteFrame>
  );
}
