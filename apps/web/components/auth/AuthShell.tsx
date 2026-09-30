import "./auth-shell.css";
import type { ReactNode } from "react";
import Link from "next/link";
import { Brand } from "@/components/brand";
import { AUTH_AI_CHIP, AUTH_ORBIT, AUTH_STORY, AUTH_TAGLINE, type AuthAudience } from "./auth-copy";

export interface AuthShellProps {
  audience: AuthAudience;
  kicker: string;
  title: string;
  lead?: ReactNode;
  backHref?: string;
  backLabel?: string;
  logoUrl?: string | null;
  logoAlt?: string;
  footer?: ReactNode;
  children: ReactNode;
}

export function AuthShell({
  audience,
  kicker,
  title,
  lead,
  backHref = "/",
  backLabel = "Back to website",
  logoUrl,
  logoAlt,
  footer,
  children,
}: AuthShellProps) {
  const story = AUTH_STORY[audience];
  return (
    <main id="main-content" className="rf-auth">
      <section className="rf-auth-story">
        {/* `standalone` carries the brand type metrics: the auth shell never
            loads the `.rf-marketing` cascade that styles `.brand-signature`. */}
        <Brand tone="light" standalone periodColor="#7DDCD8" />
        <div className="rf-auth-story-copy">
          <span className="rf-kicker">{story.kicker}</span>
          <h2>{story.heading}</h2>
          <p>{story.paragraph}</p>
        </div>
        <div className="rf-auth-orbit" aria-hidden="true">
          {/* Element roles mirror the redesign source (auth-preview.tsx:51-69):
              the ported `.rf-auth-orbit strong` / `.rf-auth-orbit span` rules
              were written for THIS mapping. */}
          <div>
            <span>{AUTH_ORBIT.orderLabel}</span>
            <strong>{AUTH_ORBIT.orderStatus}</strong>
            <div className="rf-auth-track">
              <i />
              <i />
              <i />
              <i />
            </div>
            <span>{AUTH_ORBIT.steps.join(" → ")}</span>
          </div>
          <div className="rf-auth-ai">
            <span>
              {AUTH_AI_CHIP.title}
              <br />
              <small>{AUTH_AI_CHIP.body}</small>
            </span>
          </div>
        </div>
        <span className="rf-auth-bottom">{AUTH_TAGLINE}</span>
      </section>
      <section className="rf-auth-form">
        <Link href={backHref} className="rf-back">
          ← {backLabel}
        </Link>
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
      </section>
    </main>
  );
}
