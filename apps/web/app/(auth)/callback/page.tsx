"use client";

export const dynamic = "force-dynamic";

import * as React from "react";
import { useRouter, useSearchParams } from "next/navigation";

// `/callback` never creates a session from the URL. No server path redirects here; tokens in
// the query string are ignored and nothing is stored. Google sign-in hands the browser a
// single-use `?code=`, which only the code-only page (`/auth/google/callback`) redeems, so a
// code is forwarded there unchanged; anything else goes to the sign-in page.
//
// The route stays because the mobile route-parity manifest pairs it with mobile's
// `(auth)/google-callback`.
//
// useSearchParams() requires a Suspense boundary to prevent static generation
// failures during next build (Next.js 14 requirement).

function AuthCallbackInner() {
  const router = useRouter();
  const params = useSearchParams();

  React.useEffect(() => {
    const code = params.get("code");
    router.replace(code ? `/auth/google/callback?code=${encodeURIComponent(code)}` : "/login");
  }, [params, router]);

  return (
    <div
      className="flex h-screen flex-col items-center justify-center gap-4"
      style={{ background: "linear-gradient(155deg, #10264d, #16375f 60%, #0c1f3d)" }}
    >
      <div
        className="flex h-12 w-12 items-center justify-center rounded-xl text-lg font-bold text-white backdrop-blur"
        style={{
          background: "linear-gradient(140deg, #234a74f5, #10264ded)",
          boxShadow: "inset 0 1px 0 #ffffff33, 0 7px 15px #10264d18",
        }}
      >
        RF
      </div>
      <p className="text-sm text-[#c2d0e5]">Signing you in...</p>
    </div>
  );
}

export default function AuthCallbackPage() {
  return (
    <React.Suspense
      fallback={
        <div
          className="flex h-screen flex-col items-center justify-center gap-4"
          style={{ background: "linear-gradient(155deg, #10264d, #16375f 60%, #0c1f3d)" }}
        >
          <div
            className="flex h-12 w-12 items-center justify-center rounded-xl text-lg font-bold text-white backdrop-blur"
            style={{
              background: "linear-gradient(140deg, #234a74f5, #10264ded)",
              boxShadow: "inset 0 1px 0 #ffffff33, 0 7px 15px #10264d18",
            }}
          >
            RF
          </div>
          <p className="text-sm text-[#c2d0e5]">Signing you in...</p>
        </div>
      }
    >
      <AuthCallbackInner />
    </React.Suspense>
  );
}
