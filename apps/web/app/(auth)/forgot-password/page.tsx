"use client";

import * as React from "react";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import Link from "next/link";
import { MailCheck } from "lucide-react";
import { Input, Button } from "@routeflow/ui/web";
import { apiClient } from "@/lib/api-client";
import { AuthShell } from "@/components/auth";

// ─── Schema ───────────────────────────────────────────────────────────────────

const schema = z.object({
  email: z.string().min(1, "Email is required").email("Enter a valid email address"),
});

type FormValues = z.infer<typeof schema>;

// ─── Page ─────────────────────────────────────────────────────────────────────

/**
 * Operator forgot-password. POSTs to the existing staff endpoint; the email
 * link targets this web app's /reset-password page (surface: "web").
 * Enumeration-safe by design: the success state renders no matter what, and
 * the copy never confirms whether the address exists.
 */
export default function ForgotPasswordPage() {
  const [sent, setSent] = React.useState(false);

  const {
    register,
    handleSubmit,
    formState: { errors, isSubmitting },
  } = useForm<FormValues>({ resolver: zodResolver(schema) });

  const onSubmit = async (data: FormValues) => {
    try {
      await apiClient.post("/auth/request-password-reset", {
        email: data.email.trim().toLowerCase(),
        surface: "web",
      });
    } catch {
      // Swallow errors — surfacing them would leak whether the address exists.
    }
    setSent(true);
  };

  return (
    <AuthShell
      audience="distributor"
      kicker="Distributor workspace"
      title="Reset your password"
      lead="Let's get you back in. Enter your email and we'll send a reset link."
      footer={
        <Link
          href="/login"
          className="inline-flex items-center gap-1.5 text-sm text-navy/70 hover:text-navy transition-colors"
        >
          Back to sign in
        </Link>
      }
    >
      {sent ? (
        <div className="rf-auth-success flex flex-col items-center gap-3 py-2 text-center">
          <MailCheck className="h-8 w-8 text-brand-500" />
          <p className="text-sm font-medium text-navy">Check your inbox</p>
          <p className="text-sm text-navy/70">
            If that address is registered, you&apos;ll receive a reset link shortly. The link
            expires in 15 minutes.
          </p>
        </div>
      ) : (
        <form onSubmit={handleSubmit(onSubmit)} className="flex flex-col gap-4" noValidate>
          <Input
            label="Email"
            type="email"
            placeholder="you@company.com"
            autoComplete="email"
            register={register("email")}
            error={errors.email?.message}
          />
          <Button type="submit" loading={isSubmitting} className="rf-btn mt-2 w-full">
            Send reset link
          </Button>
        </form>
      )}
    </AuthShell>
  );
}
