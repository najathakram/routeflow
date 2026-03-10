"use client";

import * as React from "react";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { useRouter } from "next/navigation";
import { Input, Button } from "@routeflow/ui/web";

// ─── Schema ───────────────────────────────────────────────────────────────────

const loginSchema = z.object({
  username: z.string().min(1, "Username is required"),
  password: z.string().min(1, "Password is required"),
});

type LoginFormValues = z.infer<typeof loginSchema>;

// ─── Page ─────────────────────────────────────────────────────────────────────

export default function LoginPage() {
  const router = useRouter();
  const [isLoading, setIsLoading] = React.useState(false);

  const {
    register,
    handleSubmit,
    formState: { errors },
  } = useForm<LoginFormValues>({
    resolver: zodResolver(loginSchema),
  });

  const onSubmit = async (_data: LoginFormValues) => {
    setIsLoading(true);
    // Mock auth — simulate network delay then redirect
    await new Promise((r) => setTimeout(r, 800));
    router.push("/dashboard");
  };

  return (
    <div className="flex min-h-screen items-center justify-center bg-surface-raised p-4">
      <div className="w-full max-w-sm">
        {/* Logo */}
        <div className="mb-8 flex flex-col items-center gap-3">
          <div className="flex h-12 w-12 items-center justify-center rounded-xl bg-brand-500 text-lg font-bold text-white">
            RF
          </div>
          <h1 className="text-2xl font-bold text-navy">RouteFlow</h1>
          <p className="text-sm text-navy/60">Sign in to your account</p>
        </div>

        {/* Card */}
        <div className="rounded-xl bg-white p-6 shadow-card">
          <form onSubmit={handleSubmit(onSubmit)} className="flex flex-col gap-4" noValidate>
            <Input
              label="Username"
              placeholder="Enter your username"
              autoComplete="username"
              register={register("username")}
              error={errors.username?.message}
            />
            <Input
              label="Password"
              type="password"
              placeholder="Enter your password"
              autoComplete="current-password"
              register={register("password")}
              error={errors.password?.message}
            />
            <Button type="submit" loading={isLoading} className="mt-2 w-full">
              Sign in
            </Button>
          </form>

          <p className="mt-4 text-center text-xs text-navy/50">
            First login? You will be prompted to change your password.
          </p>
        </div>
      </div>
    </div>
  );
}
