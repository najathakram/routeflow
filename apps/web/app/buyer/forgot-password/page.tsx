"use client";

import * as React from "react";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import Link from "next/link";
import { ArrowLeft, MailCheck } from "lucide-react";
import { Input, Button } from "@routeflow/ui/web";
import { buyerRequestPasswordReset } from "@/lib/buyer-auth";

// ─── Schema ───────────────────────────────────────────────────────────────────

const schema = z.object({
  email: z.string().min(1, "Email is required").email("Enter a valid email address"),
});

type FormValues = z.infer<typeof schema>;

// ─── Page ─────────────────────────────────────────────────────────────────────

/**
 * Buyer forgot-password. This is also the supported "claim a password" path
 * for accounts created via Google sign-in. Enumeration-safe: the success state
 * renders no matter what and never confirms whether the address exists.
 */
export default function BuyerForgotPasswordPage() {
  const [sent, setSent] = React.useState(false);

  const {
    register,
    handleSubmit,
    formState: { errors, isSubmitting },
  } = useForm<FormValues>({ resolver: zodResolver(schema) });

  const onSubmit = async (data: FormValues) => {
    try {
      await buyerRequestPasswordReset(data.email.trim().toLowerCase());
    } catch {
      // Swallow errors — surfacing them would leak whether the address exists.
    }
    setSent(true);
  };

  return (
    <div className="flex min-h-screen items-center justify-center bg-surface-raised p-4">
      <div className="w-full max-w-sm">
        <div className="mb-8 flex flex-col items-center gap-3">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src="/logo-buyer.svg" alt="RouteFlow" className="h-12 w-12 object-contain" />
          <h1 className="text-2xl font-bold text-navy">Reset your password</h1>
          <p className="text-center text-sm text-navy/70">
            Enter your buyer account email and we&apos;ll send you a reset link. This also works if
            you signed up with Google and want to add a password.
          </p>
        </div>

        <div className="rounded-xl bg-white p-6 shadow-card">
          {sent ? (
            <div className="flex flex-col items-center gap-3 py-2 text-center">
              <MailCheck className="h-8 w-8 text-buyer-600" />
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
                placeholder="you@example.com"
                autoComplete="email"
                register={register("email")}
                error={errors.email?.message}
              />
              <Button type="submit" loading={isSubmitting} className="mt-2 w-full">
                Send reset link
              </Button>
            </form>
          )}
        </div>

        <div className="mt-6 text-center">
          <Link
            href="/buyer/login"
            className="inline-flex items-center gap-1.5 text-sm text-navy/70 hover:text-navy transition-colors"
          >
            <ArrowLeft className="h-3.5 w-3.5" /> Back to sign in
          </Link>
        </div>
      </div>
    </div>
  );
}
