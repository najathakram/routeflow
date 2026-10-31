"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { Car, ShoppingBag } from "lucide-react";
import { AuthShell } from "@/components/auth";
import { apiClient } from "@/lib/api-client";
import { endStaffSession, getStoredUser } from "@/lib/auth";
import { DEFAULT_OPERATOR_LANDING, landingForRole } from "@/lib/portal-routing";
import { documentNav } from "@/lib/document-nav";
import {
  BUYER_LOGIN_PATH,
  roleStepLanding,
  shouldAskRole,
  stashBuyerLoginEmail,
} from "@/lib/role-choice";

/**
 * W-839 / SA-937 MUST 6 (owner 2026-10-24: a user who is both a driver and a buyer is ASKED at sign-in which role to
 * use). The ONE post-staff-sign-in step, reached from the password login and the Google staff callback, and rendered in
 * the mobile shell. Drive keeps today's landing. Shop ends the staff session (POST /auth/logout, staff keys cleared) and
 * opens the web buyer login with the email prefilled: a buyer account is its own sign-in, never bridged (MUST 5).
 * Reached by anyone else, it sends them on to their landing.
 */
type Me = { email?: string | null; alsoBuyer?: boolean };

export default function ChooseRolePage() {
  const router = useRouter();
  const [me, setMe] = React.useState<Me | null>(null);
  const [leaving, setLeaving] = React.useState(false);
  const user = React.useMemo(() => getStoredUser(), []);
  // #3731 review 2: Drive keeps the landing of the path the user signed in on (remembered by that path).
  const landing = roleStepLanding(landingForRole(DEFAULT_OPERATOR_LANDING, user?.role));

  React.useEffect(() => {
    if (!user) {
      router.replace("/login");
      return;
    }
    // #3731 review 5: reached directly, a forced password change still goes first.
    if (user.forcePasswordChange) {
      router.replace("/change-password");
      return;
    }
    let live = true;
    apiClient
      .get<Me>("/users/me")
      .then(({ data }) => {
        if (!live) return;
        if (shouldAskRole(user, data?.alsoBuyer, null)) setMe(data);
        else router.replace(landing);
      })
      .catch(() => live && router.replace(landing));
    return () => {
      live = false;
    };
  }, [user, landing, router]);

  const shop = async () => {
    setLeaving(true);
    await endStaffSession();
    stashBuyerLoginEmail(me?.email);
    documentNav.replace(BUYER_LOGIN_PATH);
  };

  const option =
    "flex w-full items-center gap-4 rounded-xl border border-surface-border bg-surface-raised px-4 py-4 text-left transition hover:border-[#0B6E6B] disabled:opacity-60 min-h-[64px]";

  return (
    <AuthShell
      audience="distributor"
      kicker="Signed in"
      title="How do you want to use RouteFlow?"
      lead="You'll be asked again the next time you sign in."
    >
      {me ? (
        <div className="flex flex-col gap-3">
          <button
            type="button"
            className={option}
            disabled={leaving}
            onClick={() => router.replace(landing)}
          >
            <Car className="h-6 w-6 shrink-0 text-[#0B6E6B]" aria-hidden />
            <span>
              <span className="block text-base font-semibold text-navy">Drive</span>
              <span className="block text-sm text-navy/70">Your route and deliveries</span>
            </span>
          </button>
          <button type="button" className={option} disabled={leaving} onClick={() => void shop()}>
            <ShoppingBag className="h-6 w-6 shrink-0 text-[#0B6E6B]" aria-hidden />
            <span>
              <span className="block text-base font-semibold text-navy">Shop</span>
              <span className="block text-sm text-navy/70">
                Sign in to the buyer portal to place an order
              </span>
            </span>
          </button>
        </div>
      ) : (
        <p role="status" className="text-sm text-navy/70">
          Checking your account…
        </p>
      )}
    </AuthShell>
  );
}
