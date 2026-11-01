"use client";

import * as React from "react";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { useRouter } from "next/navigation";
import { Eye, EyeOff, CheckCircle2, XCircle, Loader2 } from "lucide-react";
import { Input, Button } from "@routeflow/ui/web";
import { AuthShell } from "@/components/auth";
import { safeTextBodyCopy } from "@/lib/safe-text-error-copy";

// ─── Schema ───────────────────────────────────────────────────────────────────

const signupSchema = z.object({
  businessName: z.string().min(2, "Business name must be at least 2 characters").max(100),
  slug: z
    .string()
    .min(3, "Workspace ID must be at least 3 characters")
    .max(30, "Workspace ID must be 30 characters or less")
    .regex(
      /^[a-z0-9][a-z0-9-]{2,29}$/,
      "Only lowercase letters, numbers, and hyphens — must start with a letter or number",
    ),
  adminEmail: z.string().email("Enter a valid email address"),
  adminUsername: z
    .string()
    .min(3, "Username must be at least 3 characters")
    .max(30, "Username must be 30 characters or less")
    .regex(/^[a-zA-Z0-9_]{3,30}$/, "Only letters, numbers, and underscores"),
  // B03: mirrors the server DTO (register-tenant.dto.ts) and every other
  // password-setting flow (reset-password, buyer register/change-password) —
  // this used to require only uppercase+digit, so a password that passed
  // signup could then be rejected the first time the user tried to reset it.
  adminPassword: z
    .string()
    .min(8, "Password must be at least 8 characters")
    .regex(/[A-Z]/, "Must contain at least one uppercase letter")
    .regex(/[a-z]/, "Must contain at least one lowercase letter")
    .regex(/[0-9\W_]/, "Must contain at least one number or special character"),
});

type SignupFormValues = z.infer<typeof signupSchema>;

// ─── Availability status indicator ───────────────────────────────────────────

type AvailStatus = "idle" | "checking" | "available" | "taken";

function AvailIndicator({ status }: { status: AvailStatus }) {
  if (status === "checking") return <Loader2 className="h-4 w-4 animate-spin text-navy/70" />;
  if (status === "available") return <CheckCircle2 className="h-4 w-4 text-success" />;
  if (status === "taken") return <XCircle className="h-4 w-4 text-danger" />;
  return null;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function slugify(name: string) {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 30);
}

/** Derive a username suggestion from a slug: replace hyphens with underscores, append _admin */
function suggestUsername(slug: string) {
  const base = slug.replace(/-/g, "_").slice(0, 23); // leave room for _admin (6 chars)
  return `${base}_admin`;
}

// ─── Inner page ───────────────────────────────────────────────────────────────

function SignupInner() {
  const router = useRouter();

  const apiUrl =
    process.env.NEXT_PUBLIC_API_URL?.replace(/\/$/, "") ?? "http://localhost:3000/api/v1";

  const [isLoading, setIsLoading] = React.useState(false);
  const [apiError, setApiError] = React.useState<string | null>(null);
  const [showPassword, setShowPassword] = React.useState(false);

  // Slug availability
  const [slugStatus, setSlugStatus] = React.useState<AvailStatus>("idle");
  const [slugEdited, setSlugEdited] = React.useState(false);
  const slugDebounce = React.useRef<ReturnType<typeof setTimeout> | null>(null);

  // Username availability
  const [usernameStatus, setUsernameStatus] = React.useState<AvailStatus>("idle");
  const [usernameEdited, setUsernameEdited] = React.useState(false);
  // W2 B8: the username is auto-filled and sign-in takes email, so it shows as one line. The field
  // opens on Change, or by itself when the auto-filled name is taken or fails its check.
  const [usernameOpen, setUsernameOpen] = React.useState(false);
  const usernameDebounce = React.useRef<ReturnType<typeof setTimeout> | null>(null);

  const {
    register,
    handleSubmit,
    watch,
    setValue,
    setFocus,
    formState: { errors },
  } = useForm<SignupFormValues>({
    resolver: zodResolver(signupSchema),
    // W2 B7: an error shows when a field is left, then follows the typing; not only on submit.
    mode: "onTouched",
    defaultValues: {
      businessName: "",
      slug: "",
      adminEmail: "",
      adminUsername: "",
      adminPassword: "",
    },
  });

  const businessName = watch("businessName");
  const slugValue = watch("slug");
  const usernameValue = watch("adminUsername");
  const usernameProblem = usernameStatus === "taken" || !!errors.adminUsername;
  const showUsernameField = usernameOpen || usernameProblem;
  // The field that opened by itself stays open: the first keystroke clears "taken" (status goes to checking), and
  // a field that closed under the person's hands dropped focus to the page.
  React.useEffect(() => {
    if (usernameProblem) setUsernameOpen(true);
  }, [usernameProblem]);

  // Auto-derive slug from business name (unless user has manually edited it)
  React.useEffect(() => {
    if (!slugEdited && businessName) {
      const derived = slugify(businessName);
      if (derived.length >= 3) {
        setValue("slug", derived, { shouldValidate: false });
      }
    }
  }, [businessName, slugEdited, setValue]);

  // Auto-suggest username from slug (unless user has manually edited it)
  React.useEffect(() => {
    if (!usernameEdited && slugValue && slugValue.length >= 3) {
      const suggested = suggestUsername(slugValue);
      setValue("adminUsername", suggested, { shouldValidate: false });
    }
  }, [slugValue, usernameEdited, setValue]);

  // Debounced slug availability check
  React.useEffect(() => {
    if (!slugValue || slugValue.length < 3) {
      setSlugStatus("idle");
      return;
    }
    setSlugStatus("checking");
    if (slugDebounce.current) clearTimeout(slugDebounce.current);
    slugDebounce.current = setTimeout(async () => {
      try {
        const res = await fetch(
          `${apiUrl}/public/tenants/${encodeURIComponent(slugValue)}/available`,
        );
        if (!res.ok) {
          setSlugStatus("idle");
          return;
        }
        const data: { available: boolean } = await res.json();
        setSlugStatus(data.available ? "available" : "taken");
      } catch {
        setSlugStatus("idle");
      }
    }, 400);
    return () => {
      if (slugDebounce.current) clearTimeout(slugDebounce.current);
    };
  }, [slugValue, apiUrl]);

  // Debounced username availability check
  React.useEffect(() => {
    if (!usernameValue || usernameValue.length < 3) {
      setUsernameStatus("idle");
      return;
    }
    setUsernameStatus("checking");
    if (usernameDebounce.current) clearTimeout(usernameDebounce.current);
    usernameDebounce.current = setTimeout(async () => {
      try {
        const res = await fetch(
          `${apiUrl}/public/tenants/username-available?username=${encodeURIComponent(usernameValue)}`,
        );
        if (!res.ok) {
          setUsernameStatus("idle");
          return;
        }
        const data: { available: boolean } = await res.json();
        setUsernameStatus(data.available ? "available" : "taken");
      } catch {
        setUsernameStatus("idle");
      }
    }, 400);
    return () => {
      if (usernameDebounce.current) clearTimeout(usernameDebounce.current);
    };
  }, [usernameValue, apiUrl]);

  const onSubmit = async (data: SignupFormValues) => {
    if (slugStatus === "taken") {
      setApiError("That workspace ID is already taken. Please choose a different one.");
      return;
    }
    if (usernameStatus === "taken") {
      setApiError("That username is reserved. Please choose a different one.");
      return;
    }

    setIsLoading(true);
    setApiError(null);

    try {
      const regRes = await fetch(`${apiUrl}/public/tenants/register`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          slug: data.slug,
          businessName: data.businessName,
          adminEmail: data.adminEmail,
          adminUsername: data.adminUsername,
          adminPassword: data.adminPassword,
          // SA-738: the business starts in the signer's own zone (omitted when unusable; the server then writes UTC).
          timezone: browserTimeZone(),
        }),
      });

      if (!regRes.ok) {
        const body = await regRes.json().catch(() => ({}));
        const msg = (body as { message?: string | string[] }).message;
        // B956: a refused business name is FIXED copy with a human label, never the raw message.
        const text =
          safeTextBodyCopy(body) ??
          (Array.isArray(msg) ? msg.join(". ") : (msg ?? "Signup failed. Please try again."));
        setApiError(text);
        setIsLoading(false);
        return;
      }

      // The account is created either way, but the verification email itself
      // may have failed to send (mail transport down, etc.) — carry that
      // honestly to the check-email screen instead of always implying success.
      const regBody: { emailSent?: boolean } = await regRes.json().catch(() => ({}));
      const emailSentParam = regBody.emailSent === false ? "&emailSent=false" : "";

      // Redirect to "check your email" page — no auto-login, must verify first
      // W2 B1: the Workspace ID goes along so check-email can show it; sign-in asks for it typed.
      router.push(
        `/signup/check-email?email=${encodeURIComponent(data.adminEmail)}&workspace=${encodeURIComponent(data.slug)}${emailSentParam}`,
      );
    } catch {
      setApiError("Something went wrong. Please try again.");
      setIsLoading(false);
    }
  };

  return (
    <AuthShell
      audience="distributor"
      kicker="Distributor account"
      title="Try it free for 14 days."
      lead="No card needed."
      footer={
        <>
          <p className="text-xs text-navy/70">
            Already have an account?{" "}
            <a href="/login" className="font-medium text-brand-600 hover:underline">
              Sign in
            </a>
          </p>
          <p className="text-xs text-navy/70">
            Buying from a distributor?{" "}
            <a href="/buyer/register" className="text-brand-600 hover:underline">
              Create a retailer account
            </a>
          </p>
        </>
      }
    >
      <form onSubmit={handleSubmit(onSubmit)} className="flex flex-col gap-4" noValidate>
        {apiError && (
          <p className="rounded-lg bg-danger-bg px-3 py-2 text-sm text-danger">{apiError}</p>
        )}

        {/* Business Name */}
        <Input
          label="Business name"
          placeholder="Acme Distribution Co."
          autoComplete="organization"
          register={register("businessName")}
          error={errors.businessName?.message}
        />

        {/* Workspace ID / Slug */}
        <div className="flex flex-col gap-1">
          <label htmlFor="slug" className="text-sm font-medium text-navy">
            Workspace ID
          </label>
          <div className="relative">
            <input
              id="slug"
              type="text"
              placeholder="acme-distribution"
              autoComplete="off"
              className="h-10 w-full rounded border border-surface-border bg-white px-3 pr-10 font-mono text-sm text-navy placeholder:text-navy/70 transition-colors focus:border-transparent focus:outline-none focus:ring-2 focus:ring-brand-500"
              {...register("slug", { onChange: () => setSlugEdited(true) })}
            />
            <span className="absolute inset-y-0 right-0 flex items-center pr-3">
              <AvailIndicator status={slugStatus} />
            </span>
          </div>
          {errors.slug ? (
            <p className="text-xs text-danger">{errors.slug.message}</p>
          ) : slugStatus === "taken" ? (
            <p className="text-xs text-danger">This workspace ID is already taken.</p>
          ) : slugStatus === "available" ? (
            <p className="text-xs text-success">This workspace ID is available.</p>
          ) : (
            <p className="text-xs text-navy/70">
              You’ll need this to sign in. Use small letters, numbers, and dashes (-).
            </p>
          )}
        </div>

        {/* Admin Email */}
        <Input
          label="Email"
          type="email"
          placeholder="you@acme.com"
          autoComplete="email"
          register={register("adminEmail")}
          error={errors.adminEmail?.message}
        />

        {/* Username: one line until it needs a person (W2 B8) */}
        {showUsernameField ? (
          <div className="flex flex-col gap-1">
            <label htmlFor="adminUsername" className="text-sm font-medium text-navy">
              Username
            </label>
            <div className="relative">
              <input
                id="adminUsername"
                type="text"
                placeholder="acme_admin"
                autoComplete="username"
                className="h-10 w-full rounded border border-surface-border bg-white px-3 pr-10 text-sm text-navy placeholder:text-navy/70 transition-colors focus:border-transparent focus:outline-none focus:ring-2 focus:ring-brand-500"
                {...register("adminUsername", { onChange: () => setUsernameEdited(true) })}
              />
              <span className="absolute inset-y-0 right-0 flex items-center pr-3">
                <AvailIndicator status={usernameStatus} />
              </span>
            </div>
            {errors.adminUsername ? (
              <p className="text-xs text-danger">{errors.adminUsername.message}</p>
            ) : usernameStatus === "taken" ? (
              <p className="text-xs text-danger">
                This username is reserved. Please choose a different one.
              </p>
            ) : usernameStatus === "available" ? (
              <p className="text-xs text-success">This username is available.</p>
            ) : (
              <p className="text-xs text-navy/70">Letters, numbers, and underscores only.</p>
            )}
          </div>
        ) : usernameValue ? (
          <p className="flex items-center gap-2 text-sm text-navy">
            <span>Username: {usernameValue}</span>
            <button
              type="button"
              onClick={() => {
                setUsernameOpen(true);
                // The field mounts on the next render; focus it then.
                setTimeout(() => setFocus("adminUsername"), 0);
              }}
              className="font-medium text-brand-600 hover:underline"
            >
              Change
            </button>
          </p>
        ) : null}

        {/* Password */}
        <div className="flex flex-col gap-1">
          <label htmlFor="signup-password" className="text-sm font-medium text-navy">
            Password
          </label>
          <div className="relative">
            <input
              id="signup-password"
              type={showPassword ? "text" : "password"}
              placeholder="At least 8 characters"
              autoComplete="new-password"
              className="h-10 w-full rounded border border-surface-border bg-white px-3 pr-10 text-sm text-navy placeholder:text-navy/70 transition-colors focus:border-transparent focus:outline-none focus:ring-2 focus:ring-brand-500"
              {...register("adminPassword")}
            />
            <button
              type="button"
              onClick={() => setShowPassword((v) => !v)}
              className="absolute inset-y-0 right-0 flex items-center pr-3 text-navy/70 transition-colors hover:text-navy"
              tabIndex={-1}
              aria-label={showPassword ? "Hide password" : "Show password"}
            >
              {showPassword ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
            </button>
          </div>
          {/* W2 B6: the rule stays visible while typing and next to an error (COPY.md section 8). */}
          {errors.adminPassword && (
            <p className="text-xs text-danger">{errors.adminPassword.message}</p>
          )}
          <p className="text-xs text-navy/70">
            At least 8 characters. Uppercase, lowercase, and a number or symbol required.
          </p>
        </div>

        <Button
          type="submit"
          loading={isLoading}
          disabled={slugStatus === "taken" || usernameStatus === "taken"}
          className="rf-btn mt-2 w-full"
        >
          Create account
        </Button>
      </form>

      <p className="mt-4 text-center text-xs text-navy/70">
        By signing up you agree to our{" "}
        <a href="/terms" className="text-brand-600 hover:underline">
          Terms of Service
        </a>
        {" and "}
        <a href="/privacy" className="text-brand-600 hover:underline">
          Privacy Policy
        </a>
        .
      </p>
    </AuthShell>
  );
}

// ─── Page (Suspense required for client-side navigation hooks) ────────────────

/**
 * SA-738: the browser's IANA zone, or undefined when it would not pass the server's writable-zone
 * check (offset names, fixed-offset Etc/* and EST/MST/HST aliases, anything not Area/Location), so a
 * signup never fails over the zone. UTC itself is fine.
 */
function browserTimeZone(): string | undefined {
  try {
    const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
    if (!tz) return undefined;
    if (tz === "UTC") return tz;
    if (/^Etc\//i.test(tz) || !/^[A-Za-z]+(?:\/[A-Za-z0-9_+-]+)+$/.test(tz)) return undefined;
    return tz;
  } catch {
    return undefined;
  }
}

export default function SignupPage() {
  return (
    <React.Suspense fallback={null}>
      <SignupInner />
    </React.Suspense>
  );
}
