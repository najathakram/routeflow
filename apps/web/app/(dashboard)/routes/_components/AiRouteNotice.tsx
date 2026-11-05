import * as React from "react";
import type { RouteAnalysisResult } from "@/lib/api/routes";
import { aiResetDay } from "@/lib/ai-paused";

/**
 * Why a route analysis came back with ETAs and no AI notes (SA-1102 A-3). It names the real cause: the business's
 * monthly allowance (and when it resets), or RouteFlow's own key not being available. It never tells a business to
 * set a key, because a business key does not run route insights.
 */
export function AiRouteNotice({ result }: { result: RouteAnalysisResult }) {
  if (result.configured || !result.aiUnavailable) return null;
  const text =
    result.aiUnavailable === "cap"
      ? `AI route notes are paused until ${aiResetDay(result.aiResetsAt)}. Your ETAs are below.`
      : "AI route notes aren't available right now. Your ETAs are below.";
  return (
    <div className="rounded-lg border border-amber-200 bg-amber-50 p-3">
      <p className="text-xs text-amber-700">{text}</p>
    </div>
  );
}
