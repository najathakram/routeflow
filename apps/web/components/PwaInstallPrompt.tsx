"use client";

import * as React from "react";
import { Download, X } from "lucide-react";
import { cn } from "@routeflow/ui/web";

interface BeforeInstallPromptEvent extends Event {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: "accepted" | "dismissed" }>;
}

/**
 * Shows a banner when the browser fires the `beforeinstallprompt` event.
 * On iOS (no beforeinstallprompt), shows a "Add to Home Screen" tip instead.
 */
export function PwaInstallPrompt({
  appName = "RouteFlow",
  logoSrc = "/logo-buyer.svg",
  accentClass = "bg-buyer-600 hover:bg-buyer-700",
}: {
  appName?: string;
  logoSrc?: string;
  accentClass?: string;
}) {
  const [deferredPrompt, setDeferredPrompt] = React.useState<BeforeInstallPromptEvent | null>(null);
  const [isIos, setIsIos] = React.useState(false);
  const [dismissed, setDismissed] = React.useState(false);
  const [installed, setInstalled] = React.useState(false);

  React.useEffect(() => {
    // Check if already installed (standalone mode)
    if (window.matchMedia("(display-mode: standalone)").matches) {
      setInstalled(true);
      return;
    }

    // Check if previously dismissed
    if (sessionStorage.getItem("pwa-prompt-dismissed")) {
      setDismissed(true);
      return;
    }

    // Detect iOS
    const ios = /iphone|ipad|ipod/i.test(navigator.userAgent) && !(window as any).MSStream;
    if (ios) {
      setIsIos(true);
      return;
    }

    const handler = (e: Event) => {
      e.preventDefault();
      setDeferredPrompt(e as BeforeInstallPromptEvent);
    };
    window.addEventListener("beforeinstallprompt", handler);
    return () => window.removeEventListener("beforeinstallprompt", handler);
  }, []);

  const dismiss = () => {
    sessionStorage.setItem("pwa-prompt-dismissed", "1");
    setDismissed(true);
    setDeferredPrompt(null);
  };

  const install = async () => {
    if (!deferredPrompt) return;
    await deferredPrompt.prompt();
    const { outcome } = await deferredPrompt.userChoice;
    if (outcome === "accepted") setInstalled(true);
    setDeferredPrompt(null);
  };

  if (installed || dismissed) return null;

  // Chrome/Android install banner
  if (deferredPrompt) {
    return (
      <div className="fixed bottom-4 left-1/2 z-50 -translate-x-1/2 w-[calc(100%-2rem)] max-w-sm">
        <div className="flex items-center gap-3 rounded-xl border border-surface-border bg-white px-4 py-3 shadow-modal">
          <img src={logoSrc} alt="" className="h-9 w-9 shrink-0 rounded-lg" />
          <div className="flex-1 min-w-0">
            <p className="text-sm font-semibold text-navy">Install {appName}</p>
            <p className="text-xs text-navy/50">Add to your home screen for quick access</p>
          </div>
          <div className="flex items-center gap-2 shrink-0">
            <button
              onClick={dismiss}
              className="rounded p-1.5 text-navy/40 hover:bg-surface-raised hover:text-navy transition-colors"
              aria-label="Dismiss"
            >
              <X className="h-4 w-4" />
            </button>
            <button
              onClick={install}
              className={`flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-xs font-semibold text-white transition-colors ${accentClass}`}
            >
              <Download className="h-3.5 w-3.5" />
              Install
            </button>
          </div>
        </div>
      </div>
    );
  }

  // iOS tip
  if (isIos) {
    return (
      <div className="fixed bottom-4 left-1/2 z-50 -translate-x-1/2 w-[calc(100%-2rem)] max-w-sm">
        <div className="flex items-start gap-3 rounded-xl border border-surface-border bg-white px-4 py-3 shadow-modal">
          <img src={logoSrc} alt="" className="h-9 w-9 shrink-0 rounded-lg" />
          <div className="flex-1 min-w-0">
            <p className="text-sm font-semibold text-navy">Install {appName}</p>
            <p className="text-xs text-navy/50">
              Tap the <strong>Share</strong> button then <strong>Add to Home Screen</strong>
            </p>
          </div>
          <button
            onClick={dismiss}
            className="rounded p-1.5 text-navy/40 hover:bg-surface-raised hover:text-navy transition-colors shrink-0"
            aria-label="Dismiss"
          >
            <X className="h-4 w-4" />
          </button>
        </div>
      </div>
    );
  }

  return null;
}
