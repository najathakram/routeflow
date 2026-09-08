"use client";

import * as React from "react";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { useRouter } from "next/navigation";
import { PasswordInput, Button } from "@routeflow/ui/web";
import { AuthShell } from "@/components/auth";
import { useAuth } from "@/lib/auth-context";
import { changePassword } from "@/lib/auth";

// ─── Schema ───────────────────────────────────────────────────────────────────

const schema = z
  .object({
    currentPassword: z.string().min(1, "Current password is required"),
    newPassword: z.string().min(8, "New password must be at least 8 characters"),
    confirmPassword: z.string().min(1, "Please confirm your new password"),
  })
  .refine((d) => d.newPassword === d.confirmPassword, {
    message: "Passwords do not match",
    path: ["confirmPassword"],
  });

type FormValues = z.infer<typeof schema>;

// ─── Page ─────────────────────────────────────────────────────────────────────

export default function ChangePasswordPage() {
  const router = useRouter();
  const { isAuthenticated, isLoading } = useAuth();
  const [apiError, setApiError] = React.useState<string | null>(null);

  // Redirect if not authenticated
  React.useEffect(() => {
    if (!isLoading && !isAuthenticated) {
      router.push("/login");
    }
  }, [isLoading, isAuthenticated, router]);

  const {
    register,
    handleSubmit,
    formState: { errors, isSubmitting },
  } = useForm<FormValues>({ resolver: zodResolver(schema) });

  const onSubmit = async (data: FormValues) => {
    setApiError(null);
    try {
      await changePassword(data.currentPassword, data.newPassword);
      // Full navigation so AuthProvider reinitialises with the new token
      window.location.href = "/dashboard";
    } catch (err: unknown) {
      const msg =
        (err as { response?: { data?: { message?: string } } })?.response?.data?.message ??
        "Failed to change password.";
      setApiError(typeof msg === "string" ? msg : "Failed to change password.");
    }
  };

  if (isLoading || !isAuthenticated) return null;

  return (
    <AuthShell
      audience="distributor"
      kicker="Distributor workspace"
      title="Choose a new password"
      lead="You must set a new password before continuing."
    >
      <form onSubmit={handleSubmit(onSubmit)} className="flex flex-col gap-4" noValidate>
        {apiError && (
          <p className="rounded-lg bg-danger-bg px-3 py-2 text-sm text-danger">{apiError}</p>
        )}
        <PasswordInput
          label="Current password"
          autoComplete="current-password"
          register={register("currentPassword")}
          error={errors.currentPassword?.message}
        />
        <PasswordInput
          label="New password"
          autoComplete="new-password"
          register={register("newPassword")}
          error={errors.newPassword?.message}
        />
        <PasswordInput
          label="Confirm new password"
          autoComplete="new-password"
          register={register("confirmPassword")}
          error={errors.confirmPassword?.message}
        />
        <Button type="submit" loading={isSubmitting} className="rf-btn mt-2 w-full">
          Set new password
        </Button>
      </form>
    </AuthShell>
  );
}
