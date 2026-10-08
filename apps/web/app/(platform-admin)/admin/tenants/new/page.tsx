"use client";

import * as React from "react";
import Link from "next/link";
import {
  PLAN_KEYS,
  type BusinessProfileKey,
  type BusinessProfilePreviewResponse,
  type BusinessProfileSummary,
} from "@routeflow/types";
import { superAdminClient } from "@/lib/admin-api";
import { fetchPlanCatalog, type PlanCatalogEntry } from "@/lib/api/platform-pricing";
import {
  applyBusinessProfile,
  previewBusinessProfile,
  fetchBusinessProfiles,
} from "@/lib/platform-admin/business-profiles";
import { BusinessProfileChoices } from "../[id]/_features/BusinessProfileChoices";
import { profileErrorCopy } from "../[id]/_features/profile-errors";
import { BusinessProfilePreviewModal } from "../[id]/_features/BusinessProfilePreviewModal";
import { planLabel } from "../../../_components/AdminBadge";
import { selectablePlanKeys } from "../../../_components/usePlanOptions";
import { CopyButton } from "@/components/CopyButton";
import { safeTextErrorCopy } from "@/lib/safe-text-error-copy";

interface CreatedTenant {
  slug: string;
  id: string;
  adminUsername?: string;
  /** #2439: the stable Pay-now link (login → /settings/billing), when self-serve checkout is allowed. */
  payUrl?: string | null;
  loginUrl?: string;
  /** #2439: the welcome email (set-password link — never a password) and whether it was delivered. */
  welcomeEmail?: { to: string; delivered: boolean; transport: string; error?: string };
}

/** The apply response's plain-English change list, when the response carries one. */
function appliedSummary(applied: { summary?: unknown } | null | undefined): string[] | undefined {
  return Array.isArray(applied?.summary)
    ? applied.summary.filter((l): l is string => typeof l === "string")
    : undefined;
}

export default function AdminCreateTenantPage() {
  const [form, setForm] = React.useState({
    slug: "",
    businessName: "",
    adminEmail: "",
    adminUsername: "",
    adminPassword: "",
    plan: "STARTER",
  });
  const [showPw, setShowPw] = React.useState(false);
  const [isLoading, setIsLoading] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [success, setSuccess] = React.useState<CreatedTenant | null>(null);
  // #2438: a failed copy selects the link text so the admin can copy it by hand.
  const payLinkRef = React.useRef<HTMLAnchorElement>(null);
  const [plans, setPlans] = React.useState<PlanCatalogEntry[]>([]);
  const [plansLoading, setPlansLoading] = React.useState(true);
  const [plansUnavailable, setPlansUnavailable] = React.useState(false);
  // Business profile: "" = none (the account starts exactly as before). The create API takes no profile, so a chosen
  // one is applied to the new tenant right after the create succeeds.
  const [profiles, setProfiles] = React.useState<BusinessProfileSummary[] | null>(null);
  const [profilesFailed, setProfilesFailed] = React.useState(false);
  const [profile, setProfile] = React.useState<BusinessProfileKey | "">("");
  const [profileResult, setProfileResult] = React.useState<
    | { status: "applied"; label: string; summary?: string[] }
    | { status: "failed"; message: string }
    | null
  >(null);
  /** A profile that would stop billing is never auto-applied: the admin reviews it here first. */
  const [profileReview, setProfileReview] = React.useState<{
    tenantId: string;
    key: BusinessProfileKey;
    label: string;
    response: BusinessProfilePreviewResponse;
  } | null>(null);
  const [reviewApplying, setReviewApplying] = React.useState(false);
  const [reviewError, setReviewError] = React.useState<string | null>(null);

  // The plan list is catalog-driven (GROWTH/SCALE ship without a web release), but the server
  // only accepts a PLAN_KEYS member (create-tenant.dto.ts's @IsIn(PLAN_KEYS)) — a legacy or
  // not-yet-launched catalog row (e.g. TEAM/BUSINESS) would 400 if offered here, so the catalog
  // is filtered to PLAN_KEYS members before rendering. A failed fetch or a catalog with no
  // PLAN_KEYS-eligible row degrades to the full PLAN_KEYS list so the form stays submittable.
  React.useEffect(() => {
    let cancelled = false;
    fetchPlanCatalog()
      .then((catalog) => {
        if (cancelled) return;
        // B857: the same PLAN_KEYS filter + sortOrder every admin plan control uses (L-167).
        const eligible = selectablePlanKeys(catalog?.plans);
        const sorted = eligible.map((key) => catalog.plans.find((p) => p.planKey === key)!);
        if (!sorted.length) {
          setPlansUnavailable(true);
          return;
        }
        setPlans(sorted);
        setForm((prev) =>
          sorted.some((p) => p.planKey === prev.plan)
            ? prev
            : { ...prev, plan: sorted[0]!.planKey },
        );
      })
      .catch(() => {
        if (!cancelled) setPlansUnavailable(true);
      })
      .finally(() => {
        if (!cancelled) setPlansLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  React.useEffect(() => {
    let cancelled = false;
    fetchBusinessProfiles()
      .then((list) => {
        if (!cancelled) setProfiles(list);
      })
      .catch(() => {
        if (!cancelled) setProfilesFailed(true);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const onChange =
    (field: keyof typeof form) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) => {
      setForm((prev) => ({ ...prev, [field]: e.target.value }));
    };

  const onSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setIsLoading(true);
    setError(null);
    setSuccess(null);
    setProfileResult(null);
    try {
      // Omit a blank password: the API then sets none and the welcome email carries a
      // single-use set-password link (#2439) — no password is ever generated or shown.
      const payload: Record<string, string> = { ...form };
      if (!payload.adminPassword) delete payload.adminPassword;
      const res = await superAdminClient.post("/platform-admin/tenants", payload);
      setSuccess(res.data);
      // Its own try/catch: once the account exists, a failed profile must not read as "Failed to create tenant".
      if (profile && res.data?.id) {
        try {
          // confirm needs the plan it applies (#3199): preview the new tenant, confirm that plan
          const label = profiles?.find((p) => p.key === profile)?.label ?? "";
          const preview = await previewBusinessProfile(res.data.id, profile);
          if ((preview.plan?.billing?.length ?? 0) > 0) {
            // stopping billing is never silent: show the preview and let the admin confirm (#3220)
            setProfileReview({ tenantId: res.data.id, key: profile, label, response: preview });
            return;
          }
          const applied = await applyBusinessProfile(res.data.id, profile, preview.planFingerprint);
          setProfileResult({ status: "applied", label, summary: appliedSummary(applied) });
        } catch (applyErr: unknown) {
          const reason = profileErrorCopy(applyErr, "");
          setProfileResult({
            status: "failed",
            message: [
              "The account was created, but its business profile was not applied.",
              reason,
              "Apply it from the tenant's Setup tab.",
            ]
              .filter(Boolean)
              .join(" "),
          });
        }
      }
    } catch (err: unknown) {
      const msg = (err as { response?: { data?: { message?: string | string[] } } })?.response?.data
        ?.message;
      setError(
        safeTextErrorCopy(err) ??
          (Array.isArray(msg) ? msg.join(", ") : (msg ?? "Failed to create tenant")),
      );
    } finally {
      setIsLoading(false);
    }
  };

  async function confirmProfileReview() {
    if (!profileReview || reviewApplying) return;
    setReviewApplying(true);
    setReviewError(null);
    try {
      const applied = await applyBusinessProfile(
        profileReview.tenantId,
        profileReview.key,
        profileReview.response.planFingerprint,
      );
      setProfileResult({
        status: "applied",
        label: profileReview.label,
        summary: appliedSummary(applied),
      });
      setProfileReview(null);
    } catch (err: unknown) {
      setReviewError(profileErrorCopy(err, "Could not apply that business profile. Try again."));
    } finally {
      setReviewApplying(false);
    }
  }

  return (
    <div className="p-6">
      <div className="mb-6 flex items-center gap-4">
        <Link
          href="/admin/tenants"
          className="admin-tap-text text-sm text-slate-400 hover:text-slate-300"
        >
          ← Back to Tenants
        </Link>
        <h1 className="text-2xl font-bold text-white">Create New Tenant</h1>
      </div>

      <div className="max-w-xl">
        {success && (
          <div className="mb-4 rounded-xl bg-green-900/40 p-4 ring-1 ring-green-700">
            <p className="font-semibold text-green-400">Tenant created successfully!</p>
            <p className="mt-1 text-sm text-green-300">
              Slug: <span className="font-mono">{success.slug}</span>
            </p>
            {success.welcomeEmail &&
              (success.welcomeEmail.delivered ? (
                <p className="mt-3 text-sm text-green-300" data-testid="welcome-email-status">
                  Welcome email sent to <span className="font-mono">{success.welcomeEmail.to}</span>{" "}
                  with a set-password link (valid 72 hours)
                  {success.payUrl ? " and a Pay-now link" : ""}.
                </p>
              ) : (
                <div
                  className="mt-3 rounded-lg bg-amber-900/40 p-3 ring-1 ring-amber-700"
                  data-testid="welcome-email-status"
                  role="alert"
                >
                  <p className="text-sm font-semibold text-amber-300">
                    The welcome email was NOT delivered to {success.welcomeEmail.to}.
                  </p>
                  <p className="mt-1 text-xs text-amber-200">
                    Open the tenant and use Reset admin password to give the owner access.
                  </p>
                </div>
              ))}
            {success.payUrl && (
              <div className="mt-3 text-sm text-green-300">
                <div className="flex items-center justify-between gap-2">
                  <span>Pay-now link (never expires — sign in, then billing):</span>
                  <CopyButton
                    value={success.payUrl}
                    label="Copy Pay-now link"
                    failedText="Copy failed — select the link"
                    selectOnFail={payLinkRef}
                    className="admin-tap inline-flex shrink-0 items-center gap-1 rounded px-2 py-1 text-xs font-medium text-indigo-300 hover:bg-indigo-900/40"
                  />
                </div>
                {/* #2438: the link is one unbroken token in a monospace face; break-all keeps it
                    inside the card at every width instead of running off the right edge. */}
                <a
                  ref={payLinkRef}
                  href={success.payUrl}
                  target="_blank"
                  rel="noreferrer"
                  className="admin-inline mt-1 block break-all font-mono text-indigo-300 underline hover:text-indigo-200"
                >
                  {success.payUrl}
                </a>
              </div>
            )}
            <BusinessProfilePreviewModal
              open={profileReview !== null}
              profileLabel={profileReview?.label ?? ""}
              response={profileReview?.response ?? null}
              confirming={reviewApplying}
              error={reviewError}
              onConfirm={confirmProfileReview}
              onClose={() => {
                setProfileReview(null);
                setReviewError(null);
                setProfileResult({
                  status: "failed",
                  message:
                    "The account was created, but its business profile was not applied. Apply it from the tenant's Setup tab.",
                });
              }}
            />
            {profileResult?.status === "applied" && (
              <div className="mt-3 text-sm text-green-300">
                <p data-testid="profile-applied">
                  Business profile applied{profileResult.label ? `: ${profileResult.label}` : ""}.
                </p>
                {/* Interim result line (SA-1): what the apply actually set, straight from its response. */}
                {profileResult.summary && profileResult.summary.length > 0 && (
                  <ul
                    data-testid="profile-applied-summary"
                    className="mt-1 list-disc pl-5 text-xs text-green-200"
                  >
                    {profileResult.summary.map((line) => (
                      <li key={line}>{line}</li>
                    ))}
                  </ul>
                )}
                {profileResult.summary && profileResult.summary.length === 0 && (
                  <p data-testid="profile-applied-nothing" className="mt-1 text-xs text-green-200">
                    Nothing needed to change: this account already matched.
                  </p>
                )}
              </div>
            )}
            {profileResult?.status === "failed" && (
              <div
                className="mt-3 rounded-lg bg-amber-900/40 p-3 ring-1 ring-amber-700"
                data-testid="profile-apply-failed"
                role="alert"
              >
                <p className="text-sm text-amber-300">{profileResult.message}</p>
              </div>
            )}
            <div className="mt-3 flex gap-3">
              <Link
                href={`/admin/tenants/${success.id}`}
                className="admin-tap rounded-lg bg-indigo-600 px-3 py-1.5 text-sm font-semibold text-white hover:bg-indigo-500"
              >
                View tenant
              </Link>
              <Link
                href="/admin/tenants"
                className="admin-tap rounded-lg px-3 py-1.5 text-sm text-slate-300 hover:bg-slate-700"
              >
                Back to list
              </Link>
            </div>
          </div>
        )}

        {error && (
          <div className="mb-4 rounded-xl bg-red-900/40 p-4 ring-1 ring-red-700">
            <p className="text-sm text-red-400">{error}</p>
          </div>
        )}

        <form
          onSubmit={onSubmit}
          className="rounded-xl bg-slate-800 p-6 ring-1 ring-white/5 flex flex-col gap-4"
        >
          {/* Slug */}
          <div className="flex flex-col gap-1.5">
            <label className="text-sm font-medium text-slate-300">
              Slug <span className="text-slate-400 font-normal">(URL identifier, lowercase)</span>
            </label>
            <input
              aria-label="Slug"
              value={form.slug}
              onChange={onChange("slug")}
              placeholder="e.g. acme-foods"
              required
              className="h-10 w-full rounded-lg border border-slate-600 bg-slate-700 px-3 text-sm text-white placeholder:text-slate-500 focus:border-indigo-500 focus:outline-none focus:ring-2 focus:ring-indigo-500/30"
            />
          </div>

          {/* Business Name */}
          <div className="flex flex-col gap-1.5">
            <label className="text-sm font-medium text-slate-300">Business Name</label>
            <input
              aria-label="Business Name"
              value={form.businessName}
              onChange={onChange("businessName")}
              placeholder="e.g. Acme Foods Ltd."
              required
              className="h-10 w-full rounded-lg border border-slate-600 bg-slate-700 px-3 text-sm text-white placeholder:text-slate-500 focus:border-indigo-500 focus:outline-none focus:ring-2 focus:ring-indigo-500/30"
            />
          </div>

          {/* Admin Email */}
          <div className="flex flex-col gap-1.5">
            <label className="text-sm font-medium text-slate-300">Admin Email</label>
            <input
              aria-label="Admin Email"
              type="email"
              value={form.adminEmail}
              onChange={onChange("adminEmail")}
              placeholder="admin@acme.com"
              required
              className="h-10 w-full rounded-lg border border-slate-600 bg-slate-700 px-3 text-sm text-white placeholder:text-slate-500 focus:border-indigo-500 focus:outline-none focus:ring-2 focus:ring-indigo-500/30"
            />
          </div>

          {/* Admin Username */}
          <div className="flex flex-col gap-1.5">
            <label className="text-sm font-medium text-slate-300">Admin Username</label>
            <input
              aria-label="Admin Username"
              value={form.adminUsername}
              onChange={onChange("adminUsername")}
              placeholder="acme_admin"
              required
              className="h-10 w-full rounded-lg border border-slate-600 bg-slate-700 px-3 text-sm text-white placeholder:text-slate-500 focus:border-indigo-500 focus:outline-none focus:ring-2 focus:ring-indigo-500/30"
            />
          </div>

          {/* Admin Password */}
          <div className="flex flex-col gap-1.5">
            <label className="text-sm font-medium text-slate-300">
              Admin Password <span className="font-normal text-slate-400">(optional)</span>
            </label>
            <div className="relative">
              <input
                aria-label="Admin Password"
                type={showPw ? "text" : "password"}
                value={form.adminPassword}
                onChange={onChange("adminPassword")}
                placeholder="Leave blank — the owner sets it from the email"
                className="h-10 w-full rounded-lg border border-slate-600 bg-slate-700 px-3 pr-10 text-sm text-white placeholder:text-slate-500 focus:border-indigo-500 focus:outline-none focus:ring-2 focus:ring-indigo-500/30"
              />
              <button
                type="button"
                aria-label={showPw ? "Hide password" : "Show password"}
                onClick={() => setShowPw((v) => !v)}
                className="absolute right-3 top-1/2 -translate-y-1/2 text-slate-400 hover:text-white transition-colors"
              >
                {showPw ? (
                  <svg
                    xmlns="http://www.w3.org/2000/svg"
                    width="16"
                    height="16"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  >
                    <path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19m-6.72-1.07a3 3 0 1 1-4.24-4.24" />
                    <line x1="1" y1="1" x2="23" y2="23" />
                  </svg>
                ) : (
                  <svg
                    xmlns="http://www.w3.org/2000/svg"
                    width="16"
                    height="16"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  >
                    <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z" />
                    <circle cx="12" cy="12" r="3" />
                  </svg>
                )}
              </button>
            </div>
            <p className="text-xs text-slate-400">
              If left blank, no password is set: the welcome email carries a single-use link (valid
              72 hours) for the owner to set their own.
            </p>
          </div>

          {/* Plan */}
          <div className="flex flex-col gap-1.5">
            <label className="text-sm font-medium text-slate-300">Plan</label>
            <select
              aria-label="Plan"
              value={form.plan}
              onChange={onChange("plan")}
              className="h-10 w-full rounded-lg border border-slate-600 bg-slate-700 px-3 text-sm text-white focus:border-indigo-500 focus:outline-none focus:ring-2 focus:ring-indigo-500/30"
            >
              {plansLoading ? (
                <option value={form.plan} disabled>
                  Loading plans…
                </option>
              ) : plans.length ? (
                plans.map((p) => (
                  <option key={p.planKey} value={p.planKey}>
                    {planLabel(p.planKey)}
                  </option>
                ))
              ) : (
                PLAN_KEYS.map((p) => (
                  <option key={p} value={p}>
                    {planLabel(p)}
                  </option>
                ))
              )}
            </select>
            {plansUnavailable && (
              <p className="text-xs text-amber-400">
                Plan catalog unavailable — showing all plans without live pricing.
              </p>
            )}
          </div>

          {/* Business profile (optional) */}
          {profilesFailed ? (
            <p className="text-xs text-amber-400">
              Business profiles could not be loaded. You can set one later from the tenant&apos;s
              Setup tab.
            </p>
          ) : (
            profiles && (
              <div className="flex flex-col gap-1.5">
                <BusinessProfileChoices
                  profiles={profiles}
                  value={profile}
                  onChange={setProfile}
                  name="create-tenant-profile"
                  legend="Business profile"
                  disabled={isLoading}
                  noneOption={{
                    label: "Set up later",
                    description:
                      "Start with no business profile. Choose one from the tenant's Setup tab whenever you are ready.",
                  }}
                />
                <p className="text-xs text-slate-400">
                  A profile is applied right after the account is created. Its fleet and shipping
                  features can be changed later in the Setup tab.
                </p>
              </div>
            )
          )}

          {/* Submit */}
          <button
            type="submit"
            disabled={isLoading}
            className="mt-2 flex h-10 w-full items-center justify-center rounded-lg bg-indigo-600 text-sm font-semibold text-white transition-colors hover:bg-indigo-500 disabled:cursor-not-allowed disabled:opacity-60"
          >
            {isLoading ? "Creating…" : "Create Tenant"}
          </button>
        </form>
      </div>
    </div>
  );
}
