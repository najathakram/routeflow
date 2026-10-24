"use client";

import * as React from "react";
import axios from "axios";
import Link from "next/link";
import { adoptTokenPair } from "@/lib/auth";
import { adoptBuyerTokenPair } from "@/lib/buyer-auth";
import { runHandoff } from "@/lib/handoff";

/**
 * #2653 in-app sign-in handoff landing (sibling of /verify-email). The native shell opens
 * /handoff#code=…&realm=… right after its own native sign-in; everything happens in lib/handoff.ts.
 * On any failure it shows the ordinary sign-in link (the in-shell fallback).
 */
const apiUrl =
  process.env.NEXT_PUBLIC_API_URL?.replace(/\/$/, "") ?? "http://localhost:3000/api/v1";

export default function HandoffPage() {
  const [failed, setFailed] = React.useState(false);
  const started = React.useRef(false);

  React.useEffect(() => {
    if (started.current) return; // StrictMode double-invoke: a code can be exchanged only once
    started.current = true;
    void runHandoff({
      location: window.location,
      history: window.history,
      apiUrl,
      post: async (url, body) => (await axios.post(url, body)).data,
      adoptTokenPair: adoptTokenPair as never,
      adoptBuyerTokenPair: adoptBuyerTokenPair as never,
    }).then((r) => {
      if (!r.ok) setFailed(true);
    });
  }, []);

  return (
    <main className="flex min-h-screen items-center justify-center bg-surface-raised p-6">
      <div className="w-full max-w-sm rounded-card border border-line bg-paper p-6 text-center shadow-card">
        {failed ? (
          <>
            <h1 className="text-heading-2 text-ink-900">Sign in to continue</h1>
            <p className="mt-2 text-sm text-ink-500">
              That sign-in link has expired or was already used.
            </p>
            <Link
              href="/login"
              className="mt-4 inline-block text-sm font-semibold text-accent-deep underline"
            >
              Go to sign in
            </Link>
          </>
        ) : (
          <p className="text-sm text-ink-500" role="status">
            Signing you in…
          </p>
        )}
      </div>
    </main>
  );
}
