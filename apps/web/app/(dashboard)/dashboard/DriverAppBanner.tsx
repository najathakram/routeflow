import { DRIVER_APP_LOGIN_URL } from "@/lib/driver-app-link";

/**
 * Owner ruling (mobile-web-proxy-redesign): a DRIVER-role account signed in on
 * the web dashboard is nudged toward the installed driver app — not forced
 * there (web driver mode is the PHASE 1a work still in progress). Extracted
 * from dashboard/page.tsx so this small, stateless piece can be pinned
 * directly, without mounting the whole dashboard's data-fetching hooks.
 */
export function DriverAppBanner({
  visible,
  onDismiss,
}: {
  visible: boolean;
  onDismiss: () => void;
}) {
  if (!visible) return null;
  return (
    <div
      role="status"
      className="flex items-center justify-between gap-3 rounded-lg border border-surface-border bg-surface-raised px-4 py-2.5 text-sm text-navy"
    >
      <span>
        Get the full driver experience in the app.{" "}
        <a href={DRIVER_APP_LOGIN_URL} className="font-medium text-[#0B6E6B] hover:underline">
          Open the driver app →
        </a>
      </span>
      <button
        type="button"
        aria-label="Dismiss"
        onClick={onDismiss}
        className="shrink-0 text-navy/50 hover:text-navy"
      >
        ✕
      </button>
    </div>
  );
}
