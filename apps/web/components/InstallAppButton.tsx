"use client";

import * as React from "react";
import { Download, X, Share, Plus, Smartphone, Monitor, CheckCircle2 } from "lucide-react";

type Variant = "tenant" | "buyer";

interface BeforeInstallPromptEvent extends Event {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: "accepted" | "dismissed" }>;
}

type Platform = "ios" | "android" | "desktop" | "installed" | "unknown";

function detectPlatform(): Platform {
  if (typeof window === "undefined") return "unknown";
  if (window.matchMedia("(display-mode: standalone)").matches) return "installed";
  const ua = navigator.userAgent;
  if (/iphone|ipad|ipod/i.test(ua)) return "ios";
  if (/android/i.test(ua)) return "android";
  return "desktop";
}

const STYLES = {
  tenant: {
    accent: "bg-brand-600 hover:bg-brand-700",
    accentSoft: "bg-brand-50 text-brand-700",
    accentIcon: "text-brand-600",
    gradient: "from-brand-600 to-brand-700",
    ring: "ring-brand-500/20",
    logoSrc: "/logo.svg",
    appName: "RouteFlow",
  },
  buyer: {
    accent: "bg-buyer-600 hover:bg-buyer-700",
    accentSoft: "bg-buyer-50 text-buyer-700",
    accentIcon: "text-buyer-600",
    gradient: "from-buyer-700 to-buyer-800",
    ring: "ring-buyer-500/20",
    logoSrc: "/logo-buyer.svg",
    appName: "RouteFlow Buyer",
  },
} as const;

export function InstallAppButton({
  variant = "tenant",
  className = "",
  children,
}: {
  variant?: Variant;
  className?: string;
  children?: React.ReactNode;
}) {
  const [open, setOpen] = React.useState(false);
  const [platform, setPlatform] = React.useState<Platform>("unknown");
  const [deferredPrompt, setDeferredPrompt] = React.useState<BeforeInstallPromptEvent | null>(null);
  const styles = STYLES[variant];

  React.useEffect(() => {
    setPlatform(detectPlatform());

    const handler = (e: Event) => {
      e.preventDefault();
      setDeferredPrompt(e as BeforeInstallPromptEvent);
    };
    window.addEventListener("beforeinstallprompt", handler);
    return () => window.removeEventListener("beforeinstallprompt", handler);
  }, []);

  const triggerAndroidInstall = async () => {
    if (!deferredPrompt) return;
    await deferredPrompt.prompt();
    const { outcome } = await deferredPrompt.userChoice;
    setDeferredPrompt(null);
    if (outcome === "accepted") setOpen(false);
  };

  if (platform === "installed") return null;

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className={className || `inline-flex items-center gap-2 rounded-xl ${styles.accent} px-5 py-2.5 text-sm font-semibold text-white transition-colors`}
      >
        {children ?? (
          <>
            <Download className="h-4 w-4" />
            Get the App
          </>
        )}
      </button>

      {open && (
        <InstallModal
          variant={variant}
          platform={platform}
          canPromptAndroid={!!deferredPrompt}
          onAndroidInstall={triggerAndroidInstall}
          onClose={() => setOpen(false)}
        />
      )}
    </>
  );
}

function InstallModal({
  variant,
  platform,
  canPromptAndroid,
  onAndroidInstall,
  onClose,
}: {
  variant: Variant;
  platform: Platform;
  canPromptAndroid: boolean;
  onAndroidInstall: () => void;
  onClose: () => void;
}) {
  const styles = STYLES[variant];

  React.useEffect(() => {
    const esc = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", esc);
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      window.removeEventListener("keydown", esc);
      document.body.style.overflow = prevOverflow;
    };
  }, [onClose]);

  return (
    <div
      className="fixed inset-0 z-[100] flex items-end justify-center bg-navy/60 backdrop-blur-sm sm:items-center sm:p-4"
      onClick={onClose}
    >
      <div
        className="w-full max-w-md overflow-hidden rounded-t-3xl bg-white shadow-2xl sm:rounded-3xl"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className={`relative bg-gradient-to-br ${styles.gradient} px-6 pb-6 pt-8 text-white`}>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="absolute right-4 top-4 rounded-full p-1.5 text-white/80 transition-colors hover:bg-white/10 hover:text-white"
          >
            <X className="h-5 w-5" />
          </button>

          <div className="flex items-center gap-4">
            <div className="flex h-16 w-16 shrink-0 items-center justify-center rounded-2xl bg-white/15 backdrop-blur">
              <img src={styles.logoSrc} alt="" className="h-10 w-10" />
            </div>
            <div>
              <h2 className="text-xl font-bold">Install {styles.appName}</h2>
              <p className="mt-0.5 text-sm text-white/80">Full-screen app experience</p>
            </div>
          </div>

          <div className="mt-5 grid grid-cols-3 gap-2 text-xs text-white/90">
            <Benefit label="Offline ready" />
            <Benefit label="Push notifications" />
            <Benefit label="Home screen icon" />
          </div>
        </div>

        {/* Body */}
        <div className="px-6 py-6">
          {platform === "ios" && <IosInstructions styles={styles} />}
          {platform === "android" && (
            <AndroidInstructions
              styles={styles}
              canPrompt={canPromptAndroid}
              onInstall={onAndroidInstall}
            />
          )}
          {(platform === "desktop" || platform === "unknown") && (
            <DesktopInstructions styles={styles} />
          )}
        </div>
      </div>
    </div>
  );
}

function Benefit({ label }: { label: string }) {
  return (
    <div className="flex flex-col items-center gap-1 rounded-lg bg-white/10 px-2 py-2 text-center">
      <CheckCircle2 className="h-4 w-4" />
      <span className="text-[11px] font-medium leading-tight">{label}</span>
    </div>
  );
}

function IosInstructions({ styles }: { styles: (typeof STYLES)[Variant] }) {
  return (
    <div>
      <p className="mb-5 text-sm text-navy/70">
        Safari makes installing easy. Just follow these three steps:
      </p>
      <ol className="space-y-4">
        <Step
          number={1}
          styles={styles}
          title="Tap the Share button"
          description="It's the square with an arrow at the bottom of your Safari screen."
          icon={<Share className="h-5 w-5" />}
        />
        <Step
          number={2}
          styles={styles}
          title='Choose "Add to Home Screen"'
          description="Scroll down in the share menu until you see it."
          icon={<Plus className="h-5 w-5" />}
        />
        <Step
          number={3}
          styles={styles}
          title='Tap "Add"'
          description="The app will appear on your home screen, ready to go."
          icon={<Smartphone className="h-5 w-5" />}
        />
      </ol>
      <div className="mt-5 rounded-xl border border-surface-border bg-surface-raised px-4 py-3 text-xs text-navy/60">
        <strong className="text-navy/80">Tip:</strong> This only works in Safari, not in Chrome or
        other iOS browsers.
      </div>
    </div>
  );
}

function AndroidInstructions({
  styles,
  canPrompt,
  onInstall,
}: {
  styles: (typeof STYLES)[Variant];
  canPrompt: boolean;
  onInstall: () => void;
}) {
  if (canPrompt) {
    return (
      <div>
        <p className="mb-5 text-sm text-navy/70">
          Ready to install. Tap the button below and Chrome will do the rest.
        </p>
        <button
          type="button"
          onClick={onInstall}
          className={`flex w-full items-center justify-center gap-2 rounded-xl ${styles.accent} px-6 py-3.5 text-base font-semibold text-white shadow-lg transition-colors`}
        >
          <Download className="h-5 w-5" />
          Install now
        </button>
      </div>
    );
  }

  return (
    <div>
      <p className="mb-5 text-sm text-navy/70">
        Your browser needs a couple of taps to install:
      </p>
      <ol className="space-y-4">
        <Step
          number={1}
          styles={styles}
          title="Open the browser menu"
          description="Tap the three-dot menu in the top right of Chrome."
        />
        <Step
          number={2}
          styles={styles}
          title='Tap "Install app"'
          description='Also shown as "Add to Home screen" on some devices.'
        />
        <Step
          number={3}
          styles={styles}
          title="Confirm"
          description="The app will appear in your app drawer like any other."
        />
      </ol>
    </div>
  );
}

function DesktopInstructions({ styles }: { styles: (typeof STYLES)[Variant] }) {
  return (
    <div>
      <div className="mb-5 flex items-start gap-3 rounded-xl bg-surface-raised p-4">
        <Monitor className={`h-6 w-6 shrink-0 ${styles.accentIcon}`} />
        <div className="text-sm text-navy/70">
          You&apos;re on a desktop. Open this page on your phone to install the mobile app, or install
          the desktop app from your browser&apos;s address bar.
        </div>
      </div>
      <div className="rounded-xl border border-surface-border p-4">
        <h4 className="mb-2 text-sm font-semibold text-navy">On your phone</h4>
        <p className="text-xs text-navy/60">
          Visit <strong className="text-navy">routeflow.info</strong> on your iPhone or Android to
          install. Works best in Safari (iOS) and Chrome (Android).
        </p>
      </div>
      <div className="mt-3 rounded-xl border border-surface-border p-4">
        <h4 className="mb-2 text-sm font-semibold text-navy">On this computer</h4>
        <p className="text-xs text-navy/60">
          Click the install icon (a small screen with a down arrow) in your browser&apos;s address bar.
          Available in Chrome, Edge, and Brave.
        </p>
      </div>
    </div>
  );
}

function Step({
  number,
  styles,
  title,
  description,
  icon,
}: {
  number: number;
  styles: (typeof STYLES)[Variant];
  title: string;
  description: string;
  icon?: React.ReactNode;
}) {
  return (
    <li className="flex gap-4">
      <div
        className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-full ${styles.accentSoft} text-sm font-bold`}
      >
        {number}
      </div>
      <div className="flex-1 pt-0.5">
        <div className="flex items-center gap-2">
          <h4 className="text-sm font-semibold text-navy">{title}</h4>
          {icon && <span className={styles.accentIcon}>{icon}</span>}
        </div>
        <p className="mt-0.5 text-xs text-navy/60 leading-relaxed">{description}</p>
      </div>
    </li>
  );
}
