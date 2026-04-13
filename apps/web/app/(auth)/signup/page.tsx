"use client";

import * as React from "react";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { useRouter } from "next/navigation";
import { Eye, EyeOff, CheckCircle2, XCircle, ArrowLeft, Loader2 } from "lucide-react";
import { Input, Button } from "@routeflow/ui/web";
import { login as apiLogin } from "@/lib/auth";

// ─── Schema ───────────────────────────────────────────────────────────────────

const signupSchema = z
  .object({
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
    adminPassword: z
      .string()
      .min(8, "Password must be at least 8 characters")
      .regex(/[A-Z]/, "Must contain at least one uppercase letter")
      .regex(/[0-9]/, "Must contain at least one number"),
    confirmPassword: z.string().min(1, "Please confirm your password"),
  })
  .refine((d) => d.adminPassword === d.confirmPassword, {
    message: "Passwords do not match",
    path: ["confirmPassword"],
  });

type SignupFormValues = z.infer<typeof signupSchema>;

// ─── Slug availability indicator ──────────────────────────────────────────────

function SlugStatus({ status }: { status: "idle" | "checking" | "available" | "taken" }) {
  if (status === "checking")
    return <Loader2 className="h-4 w-4 animate-spin text-navy/40" />;
  if (status === "available")
    return <CheckCircle2 className="h-4 w-4 text-success" />;
  if (status === "taken")
    return <XCircle className="h-4 w-4 text-danger" />;
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

// ─── Inner page ───────────────────────────────────────────────────────────────

function SignupInner() {
  const router = useRouter();

  const apiUrl =
    process.env.NEXT_PUBLIC_API_URL?.replace(/\/$/, "") ?? "http://localhost:3000/api/v1";

  const [isLoading, setIsLoading] = React.useState(false);
  const [apiError, setApiError] = React.useState<string | null>(null);
  const [showPassword, setShowPassword] = React.useState(false);
  const [showConfirm, setShowConfirm] = React.useState(false);
  const [slugStatus, setSlugStatus] = React.useState<"idle" | "checking" | "available" | "taken">("idle");
  const [slugEdited, setSlugEdited] = React.useState(false);

  const debounceRef = React.useRef<ReturnType<typeof setTimeout> | null>(null);

  const {
    register,
    handleSubmit,
    watch,
    setValue,
    formState: { errors },
  } = useForm<SignupFormValues>({
    resolver: zodResolver(signupSchema),
    defaultValues: {
      businessName: "",
      slug: "",
      adminEmail: "",
      adminUsername: "",
      adminPassword: "",
      confirmPassword: "",
    },
  });

  const businessName = watch("businessName");
  const slugValue = watch("slug");

  // Auto-derive slug from business name (unless user has manually edited it)
  React.useEffect(() => {
    if (!slugEdited && businessName) {
      const derived = slugify(businessName);
      if (derived.length >= 3) {
        setValue("slug", derived, { shouldValidate: false });
      }
    }
  }, [businessName, slugEdited, setValue]);

  // Debounced slug availability check
  React.useEffect(() => {
    if (!slugValue || slugValue.length < 3) {
      setSlugStatus("idle");
      return;
    }
    setSlugStatus("checking");
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(async () => {
      try {
        const res = await fetch(`${apiUrl}/public/tenants/${encodeURIComponent(slugValue)}/available`);
        if (!res.ok) { setSlugStatus("idle"); return; }
        const data: { available: boolean } = await res.json();
        setSlugStatus(data.available ? "available" : "taken");
      } catch {
        setSlugStatus("idle");
      }
    }, 400);
    return () => { if (debounceRef.current) clearTimeout(debounceRef.current); };
  }, [slugValue, apiUrl]);

  const onSubmit = async (data: SignupFormValues) => {
    if (slugStatus === "taken") {
      setApiError("That workspace ID is already taken. Please choose a different one.");
      return;
    }

    setIsLoading(true);
    setApiError(null);

    try {
      // Step 1: Create tenant + admin user
      const regRes = await fetch(`${apiUrl}/public/tenants/register`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          slug: data.slug,
          businessName: data.businessName,
          adminEmail: data.adminEmail,
          adminUsername: data.adminUsername,
          adminPassword: data.adminPassword,
        }),
      });

      if (!regRes.ok) {
        const body = await regRes.json().catch(() => ({}));
        const msg = (body as { message?: string | string[] }).message;
        const text = Array.isArray(msg) ? msg.join(". ") : (msg ?? "Signup failed. Please try again.");
        setApiError(text);
        setIsLoading(false);
        return;
      }

      // Step 2: Immediately log in with the just-created credentials
      await apiLogin(data.adminUsername, data.adminPassword);

      // Step 3: Navigate to dashboard
      router.push("/dashboard");
    } catch {
      setApiError("Something went wrong. Please try again.");
      setIsLoading(false);
    }
  };

  return (
    <div className="flex min-h-screen items-center justify-center bg-surface-raised p-4">
      <div className="w-full max-w-sm">
        {/* Back */}
        <a
          href="/"
          className="mb-6 flex items-center gap-1.5 text-sm text-navy/50 hover:text-navy transition-colors"
        >
          <ArrowLeft className="h-3.5 w-3.5" /> Back to Home
        </a>

        {/* Brand */}
        <div className="mb-8 flex flex-col items-center gap-3">
          <img src="/logo-seller.png" alt="RouteFlow" className="h-12 w-12 object-contain" />
          <h1 className="text-2xl font-bold text-navy">Start Your Free Trial</h1>
          <div className="flex items-center gap-2">
            <span className="rounded-full bg-brand-50 px-2.5 py-0.5 text-[10px] font-semibold uppercase tracking-wider text-brand-600">
              14 Days Free
            </span>
          </div>
          <p className="text-sm text-navy/60">No credit card required</p>
        </div>

        {/* Card */}
        <div className="rounded-xl bg-white p-6 shadow-card">
          <form onSubmit={handleSubmit(onSubmit)} className="flex flex-col gap-4" noValidate>
            {apiError && (
              <p className="rounded-lg bg-danger-bg px-3 py-2 text-sm text-danger">{apiError}</p>
            )}

            {/* Business Name */}
            <Input
              label="Business Name"
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
                  className="h-10 w-full rounded border border-surface-border bg-white px-3 pr-10 text-sm text-navy placeholder:text-navy/40 font-mono transition-colors focus:outline-none focus:ring-2 focus:ring-brand-500 focus:border-transparent"
                  {...register("slug", {
                    onChange: () => setSlugEdited(true),
                  })}
                />
                <span className="absolute inset-y-0 right-0 flex items-center pr-3">
                  <SlugStatus status={slugStatus} />
                </span>
              </div>
              {errors.slug ? (
                <p className="text-xs text-danger">{errors.slug.message}</p>
              ) : slugStatus === "taken" ? (
                <p className="text-xs text-danger">This workspace ID is already taken.</p>
              ) : slugStatus === "available" ? (
                <p className="text-xs text-success">This workspace ID is available.</p>
              ) : (
                <p className="text-xs text-navy/40">Used in your login URL. Lowercase letters, numbers, hyphens.</p>
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

            {/* Admin Username */}
            <Input
              label="Username"
              placeholder="admin"
              autoComplete="username"
              register={register("adminUsername")}
              error={errors.adminUsername?.message}
            />

            {/* Password */}
            <div className="flex flex-col gap-1">
              <label htmlFor="signup-password" className="text-sm font-medium text-navy">
                Password
              </label>
              <div className="relative">
                <input
                  id="signup-password"
                  type={showPassword ? "text" : "password"}
                  placeholder="At least 8 chars, 1 uppercase, 1 number"
                  autoComplete="new-password"
                  className="h-10 w-full rounded border border-surface-border bg-white px-3 pr-10 text-sm text-navy placeholder:text-navy/40 transition-colors focus:outline-none focus:ring-2 focus:ring-brand-500 focus:border-transparent"
                  {...register("adminPassword")}
                />
                <button
                  type="button"
                  onClick={() => setShowPassword((v) => !v)}
                  className="absolute inset-y-0 right-0 flex items-center pr-3 text-navy/40 hover:text-navy transition-colors"
                  tabIndex={-1}
                  aria-label={showPassword ? "Hide password" : "Show password"}
                >
                  {showPassword ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                </button>
              </div>
              {errors.adminPassword && (
                <p className="text-xs text-danger">{errors.adminPassword.message}</p>
              )}
            </div>

            {/* Confirm Password */}
            <div className="flex flex-col gap-1">
              <label htmlFor="signup-confirm" className="text-sm font-medium text-navy">
                Confirm Password
              </label>
              <div className="relative">
                <input
                  id="signup-confirm"
                  type={showConfirm ? "text" : "password"}
                  placeholder="Re-enter your password"
                  autoComplete="new-password"
                  className="h-10 w-full rounded border border-surface-border bg-white px-3 pr-10 text-sm text-navy placeholder:text-navy/40 transition-colors focus:outline-none focus:ring-2 focus:ring-brand-500 focus:border-transparent"
                  {...register("confirmPassword")}
                />
                <button
                  type="button"
                  onClick={() => setShowConfirm((v) => !v)}
                  className="absolute inset-y-0 right-0 flex items-center pr-3 text-navy/40 hover:text-navy transition-colors"
                  tabIndex={-1}
                  aria-label={showConfirm ? "Hide password" : "Show password"}
                >
                  {showConfirm ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                </button>
              </div>
              {errors.confirmPassword && (
                <p className="text-xs text-danger">{errors.confirmPassword.message}</p>
              )}
            </div>

            <Button type="submit" loading={isLoading} className="mt-2 w-full">
              Create My Account
            </Button>
          </form>

          <p className="mt-4 text-center text-xs text-navy/50">
            By signing up you agree to our{" "}
            <a href="/terms" className="text-brand-600 hover:underline">Terms of Service</a>
            {" & "}
            <a href="/privacy" className="text-brand-600 hover:underline">Privacy Policy</a>.
          </p>
        </div>

        <div className="mt-6 space-y-2 text-center">
          <p className="text-xs text-navy/50">
            Already have an account?{" "}
            <a href="/login" className="text-brand-600 hover:underline font-medium">
              Sign in
            </a>
          </p>
          <p className="text-xs text-navy/50">
            Looking for the buyer portal?{" "}
            <a href="/buyer/register" className="text-brand-600 hover:underline">
              Sign up here
            </a>
          </p>
        </div>
      </div>
    </div>
  );
}

// ─── Page (Suspense required for client-side navigation hooks) ────────────────

export default function SignupPage() {
  return (
    <React.Suspense fallback={null}>
      <SignupInner />
    </React.Suspense>
  );
}
