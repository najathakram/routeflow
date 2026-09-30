# Build plan — auth-redesign

Standalone: agents see only this directory's artifacts (`discovery.md`, `spec.md`, `ux-spec.md`,
`test-plan.md`) plus the repo. Workdir `C:/ClaudeCode/routeflow/.claude/worktrees/rf-F09`, branch
`feat/auth-redesign` (stacks on `feat/marketing-port`). Formatter: `npx prettier --write <files>` from
`apps/web`. Lint: `npm run lint -w apps/web` (errors only count; the workspace eslint binary crashes on a
hoist skew — always through npm). NEVER run `next build` on this host (root `react` 19 vs `react-dom` 18
hoist → `ReactCurrentDispatcher` crash; production proof is the Docker image, out of the engine's scope).
Never run Playwright. Never edit anything under `app/(marketing)/**`, `globals.css`,
`packages/config/tailwind.config.ts`, `middleware.ts`, `packages/ui/**`, any `*.test.tsx` outside the two new
test files, or `e2e/07-auth-password.spec.ts`.

The redesign source is READ-ONLY reference: `C:/Users/nakram/Documents/Codex/2026-09-06/rev/work/routeflow-redesign`
(`components/auth-preview.tsx`, `app/workspace.css` lines 13–300). Read with the Read tool only; never run
a command there, never `git` there, never add it to `safe.directory`.

## Work packages (file ownership is disjoint; `dependsOn` only where a file is shared)

### P1 `auth-shell` — the shared shell (effort `high`; presentation, but every auth page depends on it)

Files: `apps/web/components/auth/AuthShell.tsx`, `apps/web/components/auth/auth-shell.css`,
`apps/web/components/auth/auth-copy.ts`, `apps/web/components/auth/index.ts`.
Satisfies R1, R4, R5, R6, R7, R12. Proven by T1, T2c, T2f.

`auth-copy.ts` — transcribe verbatim from `auth-preview.tsx:33-75` (both audiences):

```ts
export type AuthAudience = "distributor" | "retailer";
export const AUTH_STORY: Record<
  AuthAudience,
  { kicker: string; heading: string; paragraph: string }
> = {
  distributor: {
    kicker: "For distributors",
    heading: "A clearer picture of your business.",
    paragraph: "<verbatim>",
  },
  retailer: {
    kicker: "For retailers",
    heading: "Stock your shelves. Stay in control.",
    paragraph: "<verbatim>",
  },
};
export const AUTH_ORBIT = {
  orderLabel: "Order RF-1042",
  orderStatus: "Ready for the next stop.",
  steps: ["Order", "Route", "Delivery", "Invoice"] as const,
};
export const AUTH_AI_CHIP = {
  title: "AI purchase-invoice scanning",
  body: "Multiple vendors. Easier inventory and costing.",
};
export const AUTH_TAGLINE = "One brand. One connected workflow.";
```

(If the source's exact strings differ from the ones above, the SOURCE wins — copy it and report the
difference as a deviation.)

`AuthShell.tsx` (client-safe, no hooks required; keep it a server-compatible component — `Brand` is a
`Link`, fine):

```tsx
import "./auth-shell.css";
import { Brand } from "@/components/brand";
import Link from "next/link";
import { AUTH_AI_CHIP, AUTH_ORBIT, AUTH_STORY, AUTH_TAGLINE, type AuthAudience } from "./auth-copy";

export interface AuthShellProps {
  audience: AuthAudience;
  kicker: string;
  title: string;
  lead?: React.ReactNode;
  backHref?: string;
  backLabel?: string;
  logoUrl?: string | null;
  logoAlt?: string;
  footer?: React.ReactNode;
  children: React.ReactNode;
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
        <Brand tone="light" />
        <div className="rf-auth-story-copy">
          <span className="rf-kicker">{story.kicker}</span>
          <h2>{story.heading}</h2>
          <p>{story.paragraph}</p>
        </div>
        <div className="rf-auth-orbit" aria-hidden="true">
          <div>
            <strong>{AUTH_ORBIT.orderLabel}</strong>
            <span>{AUTH_ORBIT.orderStatus}</span>
            <div className="rf-auth-track">
              <i />
              <i />
              <i />
              <i />
            </div>
            <small>{AUTH_ORBIT.steps.join(" → ")}</small>
          </div>
          <div className="rf-auth-ai">
            <strong>{AUTH_AI_CHIP.title}</strong>
            <span>{AUTH_AI_CHIP.body}</span>
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
          {footer}
          <Link href="/contact">Need help?</Link>
        </div>
      </section>
    </main>
  );
}
```

`auth-shell.css` — port `workspace.css:13-24` (tokens, scoped to `.rf-auth` only — drop `.rf-workspace`)
and every `.rf-auth*` / `.rf-btn` / `.rf-kicker` / `.rf-back` / `.rf-auth-cross` / `.rf-auth-footer` /
`.rf-legal-note` / `.rf-auth-success` / `.rf-auth-forgot` rule from lines 26–260, the `@media (max-width:
850px)` block (263–285) extended to also hide `.rf-auth-orbit, .rf-auth-ai`, and the reduced-motion block
(286–291). Prefix nothing — the class names ARE the port. Add: `.rf-auth { font-family:
var(--font-geist-sans), Arial, sans-serif; color: var(--rf-charcoal); }`, `.rf-auth :focus-visible {
outline: 2px solid var(--rf-navy); outline-offset: 2px; }`, `.rf-auth input:not([type="checkbox"]):not
([type="radio"]) { height: 48px; font-size: 1rem; border: 1px solid #d7dce4; border-radius: 12px;
background: #fafbfd; padding: 12px; }`, `.rf-auth-tenant-logo { height: 40px; width: auto; margin-bottom:
16px; }`, `.rf-auth-lead { color: var(--rf-muted); font-size: 0.95rem; margin: 6px 0 22px; }`,
`@media (min-width: 851px) and (max-width: 1100px) { .rf-auth-story { padding: 28px 32px; } }`. No
`@font-face`, no `url(`, no `next/image`.

`index.ts`: `export { AuthShell } from "./AuthShell"; export type { AuthShellProps } from "./AuthShell";
export * from "./auth-copy";`.

### P2 `operator-pages` — effort `high` (auth path), dependsOn P1

Files: `apps/web/app/(auth)/login/page.tsx`, `apps/web/app/(auth)/signup/page.tsx`,
`apps/web/app/(auth)/signup/check-email/page.tsx`, `apps/web/app/(auth)/forgot-password/page.tsx`,
`apps/web/app/(auth)/reset-password/page.tsx`. Satisfies R2, R3, R8, R9, R13. Proven by T2a/b/d/e/g, T4,
T5, T6.

Recipe per page (the minimal-diff line): keep every import, hook, schema, handler, state and JSX that is
a form control, banner, link or message. Replace ONLY the outer page chrome (the `min-h-screen` wrapper,
the gradient/story panel, the mobile top bar, the white card container, the monogram/brand block, the
page-level footer links) with `<AuthShell audience="distributor" kicker="Distributor workspace"
title="…" lead="…" footer={<>…existing cross-links, same text and href…</>}>…existing form…</AuthShell>`
using the spec's copy table. `login`: pass `logoUrl={logoUrl}` and `logoAlt={brandName ?? undefined}`
(the existing `useTenantBranding` values), keep the Workspace show/hide logic, the presence banner
(`role="status"`, exact copy), the 429 countdown, the Google button (`className="rf-btn secondary"`,
its text must not be exactly `Sign in`), the `Forgot password?` link (inside the form, as today) and
the footer links `Sign in to the buyer portal` → `/buyer/login` and `Start your 14-day free trial` →
`/signup`. `forgot-password`: h1 stays exactly `Reset your password`; delete the "RF" monogram block.
`reset-password`: delete the monogram; keep the token scrub and all three states; `rf-auth-success` on
the done container. Primary submit buttons gain `className="rf-btn"` (append to existing classes when the
shared `Button` is used).

### P3 `buyer-auth-pages` — effort `high`, dependsOn P1

Files: `apps/web/app/buyer/login/page.tsx`, `apps/web/app/buyer/register/page.tsx`,
`apps/web/app/buyer/forgot-password/page.tsx`, `apps/web/app/buyer/reset-password/page.tsx`.
Satisfies R2, R3, R13. Proven by T2, T4, T5, T6. Same recipe with `audience="retailer"` and
`kicker="Retailer account"`; buyer login keeps the operator-presence banner (exact copy), the `redirect`
validation, the Google button (`rf-btn secondary`, not named exactly `Sign in`), footer links `Sign in to
the seller dashboard` → `/login` and the register link carrying `redirect` forward.

### P4 `buyer-utility-pages` — effort `medium`, dependsOn P1

Files: `apps/web/app/buyer/verify-email/page.tsx`, `apps/web/app/buyer/verify-merge/page.tsx`,
`apps/web/app/buyer/change-password/page.tsx`, `apps/web/app/buyer/invite/[token]/page.tsx`.
Satisfies R2, R3, R13. Proven by T2. Same recipe; `verify-merge` keeps `export const dynamic =
"force-dynamic"`; `change-password` passes `title` by mode (`Update your password.` / `Set a password.`);
`invite` keeps its loading/invalid/accepted/main branches inside the card.

### P5 `e2e-spec-46` — effort `medium` (no dependsOn; disjoint files; the contract is the spec's copy table)

Files: `apps/web/e2e/46-auth-redesign.spec.ts`, `apps/web/playwright.config.ts` (append the
`auth-redesign` project right after the `marketing` project entry; keep every existing project).
Satisfies R10. Proven by T5 (post-deploy). Follow `36-marketing-site.spec.ts` for structure, helpers and
the signed-out convention; mobile via `test.use({ viewport: { width: 375, height: 812 } })` on a
describe block — NEVER a phone device preset (UA-proxied away from `/login`). Screenshots to
`test-output/auth-redesign/` (gitignored).

## Test packages (authored BEFORE implementation; implementation forbidden there)

- TP1 `apps/web/components/auth/AuthShell.test.tsx` — T1 exactly as test-plan.md (the `require`-in-try
  existence assertion first, then T1a–T1e). effort `medium`.
- TP2 `apps/web/app/(auth)/auth-redesign.static.test.ts` — T2a–T2g exactly as test-plan.md. effort `medium`.

## Verification commands

- perRound: `cd apps/web && npx tsc --noEmit -p tsconfig.json` · `npm run lint -w apps/web`.
- final: `cd apps/web && npx jest --maxWorkers=2` · `cd apps/web && npx prettier --check "app/(auth)/**/*.tsx" "app/buyer/**/*.tsx" "components/auth/**" "e2e/46-auth-redesign.spec.ts" playwright.config.ts`.

## UI verify

`cd apps/web && npx next dev -p 3009` from the worktree; url `http://localhost:3009`; before any flow
prove the branch build: `GET /login` HTML must contain `rf-auth` (else the driver is on the wrong
server — stop and report). Flows (signed out): `/login`, `/signup`, `/forgot-password`,
`/reset-password`, `/buyer/login`, `/buyer/register` at desktop 1280×800 and 375×812 with
`reducedMotion: "reduce"`; checks console-errors, network-failures (ignore the expected 401/404 of
presence probes if any), a11y (axe), design-system (tokens/type/spacing against ux-spec.md). Judge on
screenshots: two panels at desktop; slim navy band + card at mobile; no horizontal scroll; one h1.

## Pipeline args

See `pipeline-args.json` beside this file (mode feature, scale major, `ui: true`, `uiVerify`, radius =
the 13 pages + the shell, mutation probes on the shell copy and the static test).
