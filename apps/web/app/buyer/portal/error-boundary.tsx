"use client";

import * as React from "react";
import { AlertTriangle, RefreshCw } from "lucide-react";
import { Button } from "@routeflow/ui/web";

interface ErrorBoundaryState {
  hasError: boolean;
  error: Error | null;
}

/**
 * Catches unhandled runtime errors in the buyer portal subtree and shows
 * a friendly fallback instead of a white screen.
 */
export class BuyerPortalErrorBoundary extends React.Component<
  { children: React.ReactNode },
  ErrorBoundaryState
> {
  constructor(props: { children: React.ReactNode }) {
    super(props);
    this.state = { hasError: false, error: null };
  }

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return { hasError: true, error };
  }

  componentDidCatch(error: Error, info: React.ErrorInfo) {
    // Log to console in development; in production this could go to an error tracking service
    console.error("[BuyerPortal] Unhandled error:", error, info.componentStack);
  }

  render() {
    if (this.state.hasError) {
      return (
        <div className="flex min-h-[400px] items-center justify-center p-6">
          <div className="max-w-md rounded-xl border border-danger/20 bg-white p-8 text-center shadow-sm">
            <div className="mx-auto mb-4 flex h-14 w-14 items-center justify-center rounded-full bg-danger/10">
              <AlertTriangle className="h-7 w-7 text-danger" />
            </div>
            <h2 className="text-lg font-semibold text-navy mb-2">Something went wrong</h2>
            <p className="text-sm text-navy/60 mb-6">
              An unexpected error occurred. Please try refreshing the page.
              {this.state.error?.message && (
                <span className="mt-2 block text-xs text-navy/40 font-mono">
                  {this.state.error.message}
                </span>
              )}
            </p>
            <div className="flex items-center justify-center gap-3">
              <Button
                variant="secondary"
                onClick={() => this.setState({ hasError: false, error: null })}
              >
                <RefreshCw className="mr-1.5 h-4 w-4" /> Try Again
              </Button>
              <Button onClick={() => (window.location.href = "/buyer/portal")}>
                Go to Dashboard
              </Button>
            </div>
          </div>
        </div>
      );
    }

    return this.props.children;
  }
}
