"use client";

import * as React from "react";
import Link from "next/link";
import {
  API_ERROR_CODES,
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
import { activateSubscription } from "@/lib/platform-admin/activate-subscription";
import { enableTenantAddon, fetchFeatureRegistry } from "@/lib/platform-admin/features";
import { BusinessProfileChoices } from "../[id]/_features/BusinessProfileChoices";
import { profileErrorCopy } from "../[id]/_features/profile-errors";
import { profilePlainCopy } from "../[id]/_features/profile-plain-copy";
import { BusinessProfilePreviewModal } from "../[id]/_features/BusinessProfilePreviewModal";
import { planLabel } from "../../../_components/AdminBadge";
import { selectablePlanKeys } from "../../../_components/usePlanOptions";
import { TimeZoneInput } from "@/components/TimeZoneInput";
import {
  SUGGESTED_TIME_ZONE,
  TIME_ZONE_REQUIRED_COPY,
  canonicalTimeZone,
  isValidTimeZone,
} from "@/lib/timezones";
import { CopyButton } from "@/components/CopyButton";
import { safeTextErrorCopy } from "@/lib/safe-text-error-copy";
import { isTestTenantSlug } from "@/lib/test-tenant-slug";
import {
  StartAsSection,
  START_AS_DEFAULT,
  billingLine,
  effectiveMode,
  trialDaysOf,
  type StartAs,
} from "./_components/StartAsSection";
import {
  FreeAddonsSection,
  freeAddonsFromRegistry,
  type FreeAddon,
} from "./_components/FreeAddonsSection";
import { ReviewCreateSheet } from "./_components/ReviewCreateSheet";
import { setupLines } from "./_components/setup-lines";

interface CreatedTenant {
  slug: string;
  id: string;
  /** The business name as entered, for the result lines. */
  businessName: string;
  adminUsername?: string;
  /** #2439: the stable Pay-now link (login → /settings/billing), when self-serve checkout is allowed. */
  payUrl?: string | null;
  loginUrl?: string;
  /** #2439: the welcome email (set-password link — never a password) and whether it was delivered. */
  welcomeEmail?: { to: string; delivered: boolean; transport: string; error?: string };
}

type FieldKey =
  "slug" | "businessName" | "timezone" | "adminEmail" | "adminUsername" | "adminPassword";
/** Form order: the first invalid field in this order is the one that takes focus. */
const FIELD_ORDER: FieldKey[] = [
  "slug",
  "businessName",
  "timezone",
  "adminEmail",
  "adminUsername",
  "adminPassword",
];

/** Fixed copy for a field the server refused. The server's own text is never shown. */
const FIELD_COPY: Record<FieldKey, string> = {
  slug: "Use 3 to 30 lowercase letters, numbers or hyphens.",
  businessName: "Use 2 to 100 characters.",
  timezone: TIME_ZONE_REQUIRED_COPY,
  adminEmail: "Enter a valid email address.",
  adminUsername: "Use 3 to 50 characters.",
  adminPassword:
    "Use 8 or more characters with an upper-case letter, a lower-case letter and a number or symbol.",
};

/** Fixed copy for a trial with no usable length (client guard and the server's TENANT_TRIAL_DAYS_REQUIRED). */
const TRIAL_DAYS_COPY = "Enter a trial length from 1 to 90 days.";

/** Moves the operator to the trial-length field (it is not a FieldKey field, so it has no ref). */
function focusTrialDays() {
  const el = document.getElementById("create-tenant-start-days");
  if (!el) return;
  const calm =
    typeof window !== "undefined" &&
    typeof window.matchMedia === "function" &&
    window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  el.scrollIntoView?.({ block: "center", behavior: calm ? "auto" : "smooth" });
  el.focus({ preventScroll: true });
}

/** The apply response's plain-English change list, when the response carries one. */
function appliedSummary(applied: { summary?: unknown } | null | undefined): string[] | undefined {
  return Array.isArray(applied?.summary)
    ? applied.summary.filter((l): l is string => typeof l === "string")
    : undefined;
}

/** The create DTO's own rules (create-tenant.dto.ts), checked here so a 400 can name the field without its message. */
function invalidFields(form: {
  slug: string;
  businessName: string;
  timezone: string;
  adminEmail: string;
  adminUsername: string;
  adminPassword: string;
}): FieldKey[] {
  const bad: FieldKey[] = [];
  if (!/^[a-z0-9][a-z0-9-]{2,29}$/.test(form.slug)) bad.push("slug");
  if (form.businessName.length < 2 || form.businessName.length > 100) bad.push("businessName");
  if (!isValidTimeZone(form.timezone)) bad.push("timezone");
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(form.adminEmail)) bad.push("adminEmail");
  if (form.adminUsername.length < 3 || form.adminUsername.length > 50) bad.push("adminUsername");
  const pw = form.adminPassword;
  if (pw && (pw.length < 8 || !/^(?=.*[a-z])(?=.*[A-Z])(?=.*[\d\W])/.test(pw))) {
    bad.push("adminPassword");
  }
  return bad;
}

/**
 * Which form fields a refused create names, with FIXED copy under each (no server text). By status and code only:
 * a 409 is the slug (taken or reserved), a refused name carries its field (B956), and a 400 is matched against the
 * DTO's own rules above. Anything else returns nothing and the page shows its generic banner.
 */
function fieldErrorsOf(
  err: unknown,
  form: Parameters<typeof invalidFields>[0],
): Partial<Record<FieldKey, string>> {
  const res = (err as { response?: { status?: number; data?: Record<string, unknown> } })?.response;
  const out: Partial<Record<FieldKey, string>> = {};
  const field = res?.data?.field;
  if (typeof field === "string" && (FIELD_ORDER as string[]).includes(field)) {
    out[field as FieldKey] = safeTextErrorCopy(err) ?? FIELD_COPY[field as FieldKey];
  }
  // The API's own code for a refused zone (the client check passed, the server's tz database disagrees).
  if (res?.data?.code === "INVALID_TIME_ZONE") out.timezone = FIELD_COPY.timezone;
  if (res?.status === 400 && res.data?.code === API_ERROR_CODES.ACCOUNT_IDENTIFIER_IN_USE) {
    out.adminEmail = "That email or username is already in use.";
  }
  if (res?.status === 409) out.slug = "That slug isn't available. Try another.";
  if (res?.status === 400 && !Object.keys(out).length) {
    for (const f of invalidFields(form)) out[f] = FIELD_COPY[f];
  }
  return out;
}

const INPUT =
  "h-10 w-full rounded-lg border border-slate-600 bg-slate-700 px-3 text-sm text-white placeholder:text-slate-500 focus:border-indigo-500 focus:outline-none focus:ring-2 focus:ring-indigo-500/30 disabled:opacity-60";

function priceText(entry: PlanCatalogEntry | undefined): string | null {
  if (!entry || entry.isCustom || entry.monthlyPrice == null) return null;
  const n = Number(entry.monthlyPrice);
  if (!Number.isFinite(n)) return null;
  return `$${Number.isInteger(n) ? n : n.toFixed(2)}/month`;
}

export default function AdminCreateTenantPage() {
  const [form, setForm] = React.useState({
    slug: "",
    businessName: "",
    timezone: "",
    adminEmail: "",
    adminUsername: "",
    adminPassword: "",
    plan: "STARTER",
  });
  const [showPw, setShowPw] = React.useState(false);
  const [isLoading, setIsLoading] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = React.useState<Partial<Record<FieldKey, string>>>({});
  const [success, setSuccess] = React.useState<CreatedTenant | null>(null);
  // #2438: a failed copy selects the link text so the admin can copy it by hand.
  const payLinkRef = React.useRef<HTMLAnchorElement>(null);
  const [plans, setPlans] = React.useState<PlanCatalogEntry[]>([]);
  const [plansLoading, setPlansLoading] = React.useState(true);
  const [plansUnavailable, setPlansUnavailable] = React.useState(false);
  // Business profile: "" = Custom (the account starts exactly as before). The create API takes no profile, so a
  // chosen one is applied to the new tenant right after the create succeeds.
  const [profiles, setProfiles] = React.useState<BusinessProfileSummary[] | null>(null);
  const [profilesFailed, setProfilesFailed] = React.useState(false);
  const [profile, setProfile] = React.useState<BusinessProfileKey | "">("");
  const [profileResult, setProfileResult] = React.useState<
    | { status: "applied"; label: string; summary?: string[] }
    | { status: "failed"; reason: string }
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
  // Plan and start (SA-2)
  const [startAs, setStartAs] = React.useState<StartAs>(START_AS_DEFAULT);
  const [startedLine, setStartedLine] = React.useState<string | null>(null);
  const [activationFailed, setActivationFailed] = React.useState(false);
  // Free add-ons (SA-2): comped after the account exists, never billed.
  const [addonList, setAddonList] = React.useState<FreeAddon[] | null>(null);
  const [addonsFailedToLoad, setAddonsFailedToLoad] = React.useState(false);
  const [selectedAddons, setSelectedAddons] = React.useState<ReadonlySet<string>>(new Set());
  const [addonFailures, setAddonFailures] = React.useState<string[]>([]);
  const [sheetOpen, setSheetOpen] = React.useState(false);
  // Result focus: bumping the token (once a create has settled) scrolls to and focuses the banner, or the first
  // invalid field when the server refused one.
  const [resultToken, setResultToken] = React.useState(0);
  const [trialError, setTrialError] = React.useState<string | null>(null);
  const [focusField, setFocusField] = React.useState<FieldKey | null>(null);
  const bannerRef = React.useRef<HTMLDivElement>(null);
  const fieldRefs = React.useRef<Partial<Record<FieldKey, HTMLInputElement | null>>>({});
  /** What is left to do after a billing-stop review closes. */
  const afterReview = React.useRef<{ tenantId: string } | null>(null);

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

  React.useEffect(() => {
    let cancelled = false;
    fetchFeatureRegistry()
      .then((rows) => {
        if (!cancelled) setAddonList(freeAddonsFromRegistry(Array.isArray(rows) ? rows : []));
      })
      .catch(() => {
        if (!cancelled) setAddonsFailedToLoad(true);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  // A settled create: bring the result into view and move focus to it (the banner is far from the Create button).
  React.useEffect(() => {
    if (resultToken === 0) return;
    const target = focusField ? fieldRefs.current[focusField] : bannerRef.current;
    if (!target) return;
    const calm =
      typeof window !== "undefined" &&
      typeof window.matchMedia === "function" &&
      window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    target.scrollIntoView?.({ block: "center", behavior: calm ? "auto" : "smooth" });
    target.focus({ preventScroll: true });
    // eslint-disable-next-line react-hooks/exhaustive-deps -- runs once per settled create, whatever else changed
  }, [resultToken]);

  const settle = (field: FieldKey | null = null) => {
    setFocusField(field);
    setResultToken((t) => t + 1);
  };

  const onChange =
    (field: keyof typeof form) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) => {
      setForm((prev) => ({ ...prev, [field]: e.target.value }));
      if (field !== "plan" && fieldErrors[field as FieldKey]) {
        setFieldErrors((prev) => ({ ...prev, [field]: undefined }));
      }
    };

  const mode = effectiveMode(form.plan, startAs.mode);
  const chosenProfile = profiles?.find((p) => p.key === profile);
  const planEntry = plans.find((p) => p.planKey === form.plan);

  /** The add-ons the admin ticked, in the list's order. */
  const chosenAddons = (addonList ?? []).filter((a) => selectedAddons.has(a.addonKey));

  const review = {
    businessName: form.businessName,
    slug: form.slug,
    adminEmail: form.adminEmail,
    timezone: canonicalTimeZone(form.timezone) ?? form.timezone,
    planName: `${planLabel(form.plan)}, ${
      mode === "trial" ? `${trialDaysOf(startAs.trialDays) ?? "?"}-day trial` : "active"
    }`,
    billingLine: billingLine(mode, startAs),
    setupTitle: "Setup",
    setupLines: chosenProfile
      ? setupLines(chosenProfile)
      : ["Plan defaults only. Nothing else is turned on."],
    addonLabels: chosenAddons.map((a) => a.label),
  };

  /** The last step: comp the ticked free add-ons. A failure names them and never hides the created account. */
  async function runAddons(tenantId: string) {
    const failed: string[] = [];
    for (const addon of chosenAddons) {
      try {
        await enableTenantAddon(tenantId, addon.addonKey, undefined, undefined, true);
      } catch {
        failed.push(addon.label);
      }
    }
    setAddonFailures(failed);
  }

  /** The profile step: preview the new tenant, then confirm that plan. Returns true when a billing-stop review opened. */
  async function runProfile(tenantId: string): Promise<boolean> {
    // Its own try/catch: once the account exists, a failed profile must not read as "Failed to create tenant".
    try {
      // confirm needs the plan it applies (#3199): preview the new tenant, confirm that plan
      const label = chosenProfile
        ? profilePlainCopy(chosenProfile.key, chosenProfile.label, chosenProfile.description).name
        : "";
      const preview = await previewBusinessProfile(tenantId, profile as BusinessProfileKey);
      if ((preview.plan?.billing?.length ?? 0) > 0) {
        // stopping billing is never silent: show the preview and let the admin confirm (#3220)
        afterReview.current = { tenantId };
        setProfileReview({
          tenantId,
          key: profile as BusinessProfileKey,
          label,
          response: preview,
        });
        return true;
      }
      const applied = await applyBusinessProfile(
        tenantId,
        profile as BusinessProfileKey,
        preview.planFingerprint,
      );
      setProfileResult({ status: "applied", label, summary: appliedSummary(applied) });
    } catch (applyErr: unknown) {
      setProfileResult({ status: "failed", reason: profileErrorCopy(applyErr, "") });
    }
    return false;
  }

  /** The chain: create → activate (if Start active) → profile → free add-ons. Not atomic: each step reports itself. */
  async function runCreate() {
    setSheetOpen(false);
    setIsLoading(true);
    setError(null);
    setFieldErrors({});
    setSuccess(null);
    setProfileResult(null);
    setStartedLine(null);
    setActivationFailed(false);
    setAddonFailures([]);
    let reviewOpened = false;
    let refusedField: FieldKey | null = null;
    try {
      // Omit a blank password: the API then sets none and the welcome email carries a
      // single-use set-password link (#2439) — no password is ever generated or shown.
      const payload: Record<string, string | number> = { ...form };
      if (!payload.adminPassword) delete payload.adminPassword;
      // #3334: the server picks the welcome email from this ("active" = no trial line, no Pay now).
      payload.startMode = mode;
      if (mode === "trial") {
        const days = trialDaysOf(startAs.trialDays);
        if (days !== null) payload.trialLengthDays = days;
      }
      let created: CreatedTenant;
      try {
        const res = await superAdminClient.post("/platform-admin/tenants", payload);
        created = { ...res.data, businessName: form.businessName };
      } catch (err: unknown) {
        const refused = (err as { response?: { status?: number; data?: { code?: unknown } } })
          ?.response;
        if (
          refused?.status === 400 &&
          refused.data?.code === API_ERROR_CODES.TENANT_TRIAL_DAYS_REQUIRED
        ) {
          setTrialError(TRIAL_DAYS_COPY);
          setIsLoading(false);
          setTimeout(focusTrialDays, 0);
          return;
        }
        const fields = fieldErrorsOf(err, form);
        const first = FIELD_ORDER.find((f) => fields[f]);
        if (first) {
          setFieldErrors(fields);
          refusedField = first;
          return;
        }
        // Never echo the server's free text: only the fixed sentence or the safe-text refusal copy.
        setError(safeTextErrorCopy(err) ?? "Could not create the tenant. Try again.");
        settle();
        return;
      }
      setSuccess(created);
      if (!created.id) return;
      if (mode === "active") {
        try {
          await activateSubscription(created.id, {
            plan: form.plan,
            paymentMethod: startAs.paymentMethod,
            billingPeriodDays: startAs.billingPeriodDays,
            ...(startAs.paymentRef.trim() ? { paymentRef: startAs.paymentRef.trim() } : {}),
          });
          setStartedLine(billingLine("active", startAs));
        } catch {
          // Nothing after a failed activation runs: the banner names the step and links the tenant's Billing tab.
          setActivationFailed(true);
          return;
        }
      } else {
        setStartedLine(billingLine("trial", startAs));
      }
      if (profile) {
        reviewOpened = await runProfile(created.id);
        if (reviewOpened) return;
      }
      await runAddons(created.id);
    } finally {
      setIsLoading(false);
      if (!reviewOpened) settle(refusedField);
    }
  }

  async function finishAfterReview() {
    const pending = afterReview.current;
    afterReview.current = null;
    if (pending) await runAddons(pending.tenantId);
    settle(null);
  }

  async function confirmProfileReview() {
    if (!profileReview || reviewApplying) return;
    setReviewApplying(true);
    setReviewError(null);
    let applied = false;
    try {
      const response = await applyBusinessProfile(
        profileReview.tenantId,
        profileReview.key,
        profileReview.response.planFingerprint,
      );
      setProfileResult({
        status: "applied",
        label: profileReview.label,
        summary: appliedSummary(response),
      });
      setProfileReview(null);
      applied = true;
    } catch (err: unknown) {
      setReviewError(profileErrorCopy(err, "Could not apply that business profile. Try again."));
    } finally {
      setReviewApplying(false);
    }
    if (applied) await finishAfterReview();
  }

  const onSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (isLoading) return;
    if (mode === "trial" && trialDaysOf(startAs.trialDays) === null) {
      setTrialError(TRIAL_DAYS_COPY);
      focusTrialDays();
      return;
    }
    // The time zone is checked here (not natively) so its message reads inline next to the field.
    const zone = canonicalTimeZone(form.timezone);
    if (!zone) {
      setFieldErrors((prev) => ({ ...prev, timezone: FIELD_COPY.timezone }));
      fieldRefs.current.timezone?.focus();
      return;
    }
    // Store the canonical spelling (america/chicago becomes America/Chicago).
    if (zone !== form.timezone) setForm((prev) => ({ ...prev, timezone: zone }));
    // Nothing is sent here: the form (native required-field checks already passed) opens the review.
    setSheetOpen(true);
  };

  const profileFailed = profileResult?.status === "failed";
  const partial = !!success && (activationFailed || profileFailed || addonFailures.length > 0);
  const tenantHref = (tab: string) => `/admin/tenants/${success?.id}?tab=${tab}`;
  const nameForBanner = success?.businessName || success?.slug || "the tenant";

  const fieldProps = (key: FieldKey) => ({
    ref: (el: HTMLInputElement | null) => {
      fieldRefs.current[key] = el;
    },
    "aria-invalid": fieldErrors[key] ? (true as const) : undefined,
    "aria-describedby": fieldErrors[key] ? `create-tenant-${key}-error` : undefined,
    disabled: isLoading,
  });
  const fieldError = (key: FieldKey) =>
    fieldErrors[key] ? (
      <p id={`create-tenant-${key}-error`} className="text-xs text-red-400">
        {fieldErrors[key]}
      </p>
    ) : null;

  return (
    <div className="p-6">
      <div className="mx-auto mb-6 flex max-w-[640px] items-center gap-4">
        <Link
          href="/admin/tenants"
          className="admin-tap-text text-sm text-slate-400 hover:text-slate-300"
        >
          ← Back to Tenants
        </Link>
        <h1 className="text-2xl font-bold text-white">Create New Tenant</h1>
      </div>

      <div className="mx-auto max-w-[640px]">
        {success && (
          <div
            ref={bannerRef}
            tabIndex={-1}
            data-testid="create-banner"
            role={partial ? "alert" : "status"}
            className={`mb-4 rounded-xl p-4 outline-none ring-1 focus-visible:ring-2 ${
              partial ? "bg-amber-900/30 ring-amber-700" : "bg-green-900/40 ring-green-700"
            }`}
          >
            {partial ? (
              <div data-testid="partial-banner" className="flex flex-col gap-2">
                {activationFailed && (
                  <p className="text-sm font-semibold text-amber-300">
                    Created {nameForBanner}, but activation didn&apos;t finish. Open Billing to
                    finish it.
                    {(profile || chosenAddons.length > 0) && (
                      <span className="font-normal">
                        {" "}
                        The{" "}
                        {[profile ? "profile" : "", chosenAddons.length ? "free add-ons" : ""]
                          .filter(Boolean)
                          .join(" and ")}{" "}
                        {profile && chosenAddons.length ? "were" : "was"} not applied.
                      </span>
                    )}
                  </p>
                )}
                {profileFailed && (
                  <p
                    className="text-sm font-semibold text-amber-300"
                    data-testid="profile-apply-failed"
                  >
                    Created {nameForBanner}, but the profile didn&apos;t apply. Open Setup to finish
                    it.
                    {profileResult.reason && (
                      <span className="font-normal"> {profileResult.reason}</span>
                    )}
                  </p>
                )}
                {addonFailures.length > 0 && (
                  <p className="text-sm font-semibold text-amber-300">
                    Created {nameForBanner}, but a free add-on didn&apos;t turn on:{" "}
                    {addonFailures.join(", ")}. Open Setup to finish it.
                  </p>
                )}
                <p className="text-xs text-amber-200">
                  Slug: <span className="font-mono">{success.slug}</span>
                </p>
              </div>
            ) : (
              <>
                <p className="font-semibold text-green-400">Tenant created successfully!</p>
                <p className="mt-1 text-sm text-green-300">
                  Slug: <span className="font-mono">{success.slug}</span>
                </p>
                {startedLine && (
                  <p data-testid="start-result" className="mt-1 text-xs text-green-200">
                    {startedLine}
                  </p>
                )}
              </>
            )}
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
                    {profileResult.summary.map((line, i) => (
                      <li key={`${i}-${line}`}>{line}</li>
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
            <div className="mt-3 flex gap-3">
              <Link
                href={tenantHref(
                  activationFailed
                    ? "billing"
                    : profileFailed || addonFailures.length
                      ? "setup"
                      : "overview",
                )}
                className="admin-tap rounded-lg bg-indigo-600 px-3 py-1.5 text-sm font-semibold text-white hover:bg-indigo-500"
              >
                Open {nameForBanner}
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
          <div
            ref={bannerRef}
            tabIndex={-1}
            role="alert"
            data-testid="create-banner"
            className="mb-4 rounded-xl bg-red-900/40 p-4 outline-none ring-1 ring-red-700 focus-visible:ring-2"
          >
            <p className="text-sm text-red-400">{error}</p>
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
            setProfileResult({ status: "failed", reason: "" });
            void finishAfterReview();
          }}
        />

        <ReviewCreateSheet
          open={sheetOpen}
          review={review}
          onCancel={() => setSheetOpen(false)}
          onCreate={() => void runCreate()}
        />

        <form
          onSubmit={onSubmit}
          className="flex flex-col gap-4 rounded-xl bg-slate-800 p-6 ring-1 ring-white/5"
        >
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            {/* Slug */}
            <div className="flex flex-col gap-1.5">
              <label className="text-sm font-medium text-slate-300">
                Slug <span className="font-normal text-slate-400">(URL identifier, lowercase)</span>
              </label>
              <input
                aria-label="Slug"
                value={form.slug}
                onChange={onChange("slug")}
                placeholder="e.g. acme-foods"
                required
                className={INPUT}
                {...fieldProps("slug")}
              />
              {fieldError("slug")}
              {isTestTenantSlug(form.slug) && (
                <p
                  className="text-xs text-amber-300"
                  role="status"
                  data-testid="test-tenant-notice"
                >
                  This will be a TEST tenant: its slug matches a test-tenant pattern.
                </p>
              )}
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
                className={INPUT}
                {...fieldProps("businessName")}
              />
              {fieldError("businessName")}
            </div>
          </div>

          {/* Time zone (required): receipts and "today's sales" are cut at this zone's midnight. */}
          <div className="flex flex-col gap-1.5">
            <label htmlFor="create-tenant-timezone" className="text-sm font-medium text-slate-300">
              Time zone <span className="font-normal text-slate-400">(required)</span>
            </label>
            <div className="flex gap-2">
              <TimeZoneInput
                id="create-tenant-timezone"
                aria-label="Time zone"
                aria-required="true"
                value={form.timezone}
                onChange={onChange("timezone")}
                onBlur={() => {
                  // Tidy the spelling when the admin leaves the field; text that is not a zone stays for the submit check.
                  const zone = canonicalTimeZone(form.timezone);
                  if (zone && zone !== form.timezone)
                    setForm((prev) => ({ ...prev, timezone: zone }));
                }}
                className={INPUT}
                {...fieldProps("timezone")}
              />
              {form.timezone !== SUGGESTED_TIME_ZONE && (
                <button
                  type="button"
                  disabled={isLoading}
                  onClick={() => {
                    setForm((prev) => ({ ...prev, timezone: SUGGESTED_TIME_ZONE }));
                    setFieldErrors((prev) => ({ ...prev, timezone: undefined }));
                    // The button unmounts once the suggestion is applied: keep focus on the field.
                    fieldRefs.current.timezone?.focus();
                  }}
                  className="admin-tap shrink-0 rounded-lg px-3 text-sm text-indigo-300 hover:bg-slate-700"
                >
                  Use {SUGGESTED_TIME_ZONE}
                </button>
              )}
            </div>
            {fieldError("timezone")}
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
              className={INPUT}
              {...fieldProps("adminEmail")}
            />
            {fieldError("adminEmail")}
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
              className={INPUT}
              {...fieldProps("adminUsername")}
            />
            {fieldError("adminUsername")}
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
                className={`${INPUT} pr-10`}
                {...fieldProps("adminPassword")}
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
            {fieldError("adminPassword")}
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
              disabled={isLoading}
              className="h-10 w-full rounded-lg border border-slate-600 bg-slate-700 px-3 text-sm text-white focus:border-indigo-500 focus:outline-none focus:ring-2 focus:ring-indigo-500/30 disabled:opacity-60"
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

          <StartAsSection
            plan={form.plan}
            planName={planLabel(form.plan)}
            priceText={priceText(planEntry)}
            value={startAs}
            onChange={(next) => {
              setStartAs(next);
              if (trialError) setTrialError(null);
            }}
            disabled={isLoading}
            trialError={trialError}
          />

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
                  legend="What does this business do?"
                  disabled={isLoading}
                  expandSelected
                  noneOption={{
                    label: "Custom: I'll choose the features myself",
                    description: "Starts with the plan's defaults. Nothing else is turned on.",
                  }}
                />
                <p className="text-xs text-slate-400">
                  Pick the closest match. You can change it later in Setup.
                </p>
              </div>
            )
          )}

          <FreeAddonsSection
            addons={addonList}
            failed={addonsFailedToLoad}
            selected={selectedAddons}
            onToggle={(key) =>
              setSelectedAddons((prev) => {
                const next = new Set(prev);
                if (next.has(key)) next.delete(key);
                else next.add(key);
                return next;
              })
            }
            disabled={isLoading}
          />

          {/* Submit: a sticky bar so Create Tenant is always in reach, Cancel above it at phone width */}
          <div className="sticky bottom-0 z-10 -mx-6 -mb-6 mt-2 flex flex-col gap-2 rounded-b-xl border-t border-slate-700 bg-slate-800 p-4 sm:flex-row sm:items-center sm:justify-end">
            <Link
              href="/admin/tenants"
              className="admin-tap flex items-center justify-center rounded-lg px-4 text-sm text-slate-400 hover:text-slate-200"
            >
              Cancel
            </Link>
            <button
              type="submit"
              disabled={isLoading}
              className="flex min-h-[44px] w-full items-center justify-center rounded-lg bg-indigo-600 px-6 text-sm font-semibold text-white transition-colors hover:bg-indigo-500 disabled:cursor-not-allowed disabled:opacity-60 sm:w-auto"
            >
              {isLoading ? "Creating…" : "Create Tenant"}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
