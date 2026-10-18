"use client";

import * as React from "react";
import {
  applyBusinessCapabilities,
  fetchBusinessCapabilities,
  fetchCapabilityPresets,
  previewBusinessCapabilities,
  type BusinessCapabilities,
  type BusinessCapabilitiesPreviewResponse,
  type CapabilityPresetSummary,
} from "@/lib/platform-admin/capabilities-contract";
import { AdminCard } from "../../../../_components/AdminCard";
import { CapabilityBillingDialog } from "./CapabilityBillingDialog";
import { CapabilityChoices } from "./CapabilityChoices";
import { CapabilityPlanSections, billingStops, isEmptyPlan } from "./CapabilityPlanSections";
import {
  NO_TICKS,
  nothingTicked,
  tickedNames,
  ticksFromCapabilities,
  ticksKey,
  ticksToRequest,
  type CapabilityTicks,
} from "./capability-ticks";
import { profileBullets } from "./profile-plain-copy";
import { profileErrorCopy, profilePartlyApplied, profilePlanChanged } from "./profile-errors";

const NOT_SET_UP =
  "Not set up yet. The business works as before. Tick what it does, or start from a preset.";
const PLAN_CHANGED_NOTICE = "This business changed. Check the preview again.";
const CARRIER_COPY = "Orders are with the carrier right now. Change this once they are delivered.";

/** One finished preview request: tied to the ticks it was asked for, never to "whatever is on screen now". */
type Settled =
  | { key: string; ticks: CapabilityTicks; response: BusinessCapabilitiesPreviewResponse }
  | { key: string; error: string };

function isCancel(err: unknown): boolean {
  const e = err as { code?: string; name?: string } | null;
  return e?.code === "ERR_CANCELED" || e?.name === "CanceledError" || e?.name === "AbortError";
}

function plural(n: number, one: string, many: string): string {
  return n === 1 ? one : many;
}

function blockedCopy(b: NonNullable<BusinessCapabilitiesPreviewResponse["blocked"]>): string {
  return b.code === "FULFILMENT_CARRIER_IN_TRANSIT"
    ? CARRIER_COPY
    : "This needs a feature turned on first.";
}

/**
 * The Setup tab's "What this business does" card. The ticks come from the server's `business-capabilities` read; every
 * tick change asks for a live preview (a dry run that writes nothing, 300 ms debounce, last request wins, an inline
 * panel under the boxes); Apply is one audited write that sends the fingerprint of the preview on screen. A change that
 * stops billing goes through one alert dialog naming each add-on. Failures show fixed copy chosen by the API's error
 * code, never the server message. Platform admin only: the parent renders this for a super admin alone.
 */
export function CapabilitiesCard({
  tenantId,
  onApplied,
}: {
  tenantId: string;
  /** Called after the tenant's setup changed (a full apply, or a partial one) so the screen reloads. */
  onApplied: () => void;
}) {
  const [loadState, setLoadState] = React.useState<"loading" | "ready" | "failed">("loading");
  const [caps, setCaps] = React.useState<BusinessCapabilities | null>(null);
  const [presets, setPresets] = React.useState<CapabilityPresetSummary[]>([]);
  const [ticks, setTicks] = React.useState<CapabilityTicks>(NO_TICKS);
  const [result, setResult] = React.useState<Settled | null>(null);
  const [lastOk, setLastOk] = React.useState<Extract<Settled, { response: unknown }> | null>(null);
  const [attempt, setAttempt] = React.useState(0);
  const [notice, setNotice] = React.useState<string | null>(null);
  const [applying, setApplying] = React.useState(false);
  const [applyError, setApplyError] = React.useState<string | null>(null);
  const [savedNote, setSavedNote] = React.useState<string | null>(null);
  const [confirmOpen, setConfirmOpen] = React.useState(false);

  const mounted = React.useRef(true);
  React.useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const ticksRef = React.useRef(ticks);
  ticksRef.current = ticks;
  /** The next preview request goes out now (a retry, or a stale plan), not after the debounce. */
  const immediate = React.useRef(false);

  const readCaps = React.useCallback(
    async (resetTicks: boolean) => {
      const next = await fetchBusinessCapabilities(tenantId);
      if (!mounted.current) return;
      setCaps(next);
      if (resetTicks) {
        setTicks(ticksFromCapabilities(next));
        setResult(null);
        setLastOk(null);
        setNotice(null);
      }
    },
    [tenantId],
  );

  const load = React.useCallback(() => {
    setLoadState("loading");
    Promise.all([readCaps(true), fetchCapabilityPresets().catch(() => [])])
      .then(([, list]) => {
        if (!mounted.current) return;
        setPresets(list);
        setLoadState("ready");
      })
      .catch(() => {
        if (mounted.current) setLoadState("failed");
      });
  }, [readCaps]);
  React.useEffect(load, [load]);

  const savedTicks = caps ? ticksFromCapabilities(caps) : NO_TICKS;
  const key = ticksKey(ticks);
  const empty = nothingTicked(ticks);
  const sameAsSaved = key === ticksKey(savedTicks);
  const needsPreview = loadState === "ready" && !empty && !sameAsSaved;

  // The live preview: debounced, one request in flight, an older one aborted and its answer dropped.
  React.useEffect(() => {
    if (!needsPreview) return;
    const asked = ticksRef.current;
    const askedKey = ticksKey(asked);
    const controller = new AbortController();
    const delay = immediate.current ? 0 : 300;
    immediate.current = false;
    const timer = setTimeout(() => {
      previewBusinessCapabilities(tenantId, ticksToRequest(asked), controller.signal)
        .then((response) => {
          if (controller.signal.aborted || !mounted.current) return;
          if (ticksKey(ticksRef.current) !== askedKey) return;
          const ok = { key: askedKey, ticks: asked, response };
          setResult(ok);
          setLastOk(ok);
        })
        .catch((err: unknown) => {
          if (controller.signal.aborted || isCancel(err) || !mounted.current) return;
          if (ticksKey(ticksRef.current) !== askedKey) return;
          setResult({ key: askedKey, error: profileErrorCopy(err, "") });
        });
    }, delay);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [key, attempt, needsPreview, tenantId]);

  function changeTicks(next: CapabilityTicks) {
    setTicks(next);
    setNotice(null);
    setSavedNote(null);
    setApplyError(null);
  }

  function previewAgain() {
    immediate.current = true;
    setResult(null);
    setAttempt((a) => a + 1);
  }

  const settled = result && result.key === key ? result : null;
  const fresh = settled && "response" in settled ? settled : null;
  const failedPreview = settled && "error" in settled ? settled : null;
  const loading = needsPreview && !settled;
  const shown = fresh ?? lastOk;
  const blocked = fresh?.response.blocked ?? null;
  const planIsEmpty = !!fresh && isEmptyPlan(fresh.response);
  const stops = fresh ? billingStops(fresh.response) : [];
  const canApply = needsPreview && !!fresh && !blocked && !planIsEmpty && !applying;

  const reasonId = "capabilities-apply-reason";
  const errorId = "capabilities-preview-error";
  let reason: string | null = null;
  if (!applying) {
    if (empty) reason = "Tick at least one.";
    else if (sameAsSaved || planIsEmpty) reason = "Already set up this way.";
    else if (loading) reason = "Updating preview…";
    else if (blocked) reason = blockedCopy(blocked);
  }

  async function doApply() {
    if (!canApply || !fresh) return;
    setConfirmOpen(false);
    setApplying(true);
    setApplyError(null);
    setSavedNote(null);
    try {
      await applyBusinessCapabilities(
        tenantId,
        ticksToRequest(fresh.ticks),
        fresh.response.planFingerprint,
      );
      const names = tickedNames(fresh.ticks);
      setSavedNote(`Saved: ${names.length > 0 ? names.join(", ") : "nothing ticked"}.`);
      await readCaps(true);
      onApplied();
    } catch (err) {
      const changed = profilePlanChanged(err);
      const partly = profilePartlyApplied(err);
      if (partly) {
        // Billing already stopped for some add-ons: the tenant HAS changed, so the screen behind must catch up.
        await readCaps(false).catch(() => undefined);
        onApplied();
      }
      if (changed || partly) {
        setNotice(changed ? PLAN_CHANGED_NOTICE : null);
        if (partly) setApplyError(profileErrorCopy(err, "Could not apply this change. Try again."));
        previewAgain();
      } else {
        setApplyError(profileErrorCopy(err, "Could not apply this change. Try again."));
      }
    } finally {
      if (mounted.current) setApplying(false);
    }
  }

  function onApplyClick() {
    if (!canApply) return;
    if (stops.length > 0) setConfirmOpen(true);
    else void doApply();
  }

  const summaryLine =
    notice ??
    (shown
      ? (() => {
          const s = billingStops(shown.response).length;
          if (s > 0) return `Billing stops for ${s} ${plural(s, "add-on", "add-ons")}.`;
          const n =
            (shown.response.plan?.comps ?? []).length + (shown.response.changes ?? []).length;
          return `${n} ${plural(n, "change", "changes")} to review.`;
        })()
      : "");

  const savedNames = tickedNames(savedTicks);

  return (
    <AdminCard title="What this business does" className="mb-4">
      {loadState === "failed" ? (
        <div role="alert" className="flex items-center gap-2 text-sm text-slate-300">
          Couldn&apos;t load what this business does.
          <button
            type="button"
            onClick={load}
            className="min-h-[44px] rounded px-3 py-1 text-slate-200 hover:bg-slate-700"
          >
            Retry
          </button>
        </div>
      ) : loadState === "loading" || !caps ? (
        <p className="text-sm text-slate-400">Loading what this business does...</p>
      ) : (
        <div className="grid gap-x-6 gap-y-4 lg:grid-cols-2">
          <div className="flex flex-col gap-3 lg:col-start-1 lg:row-start-1">
            <p className="text-sm text-slate-300">
              {caps.configured
                ? `Saved setup: ${savedNames.length > 0 ? savedNames.join(", ") : "nothing ticked"}.`
                : NOT_SET_UP}
            </p>
            <CapabilityChoices
              idPrefix="setup-capabilities"
              ticks={ticks}
              onChange={changeTicks}
              presets={presets}
              matchedPreset={caps.matchedPreset}
              unavailable={caps.unavailable}
              disabled={applying}
            />
          </div>

          {needsPreview && (
            <div className="lg:sticky lg:top-4 lg:col-start-2 lg:row-span-2 lg:row-start-1 lg:self-start">
              <div
                role="region"
                data-testid="capability-preview"
                aria-label={loading ? "Updating preview…" : "Preview of this change"}
                aria-busy={loading}
                className={`flex flex-col gap-3 rounded-xl bg-slate-900/40 p-4 ring-1 ring-white/10 ${
                  loading ? "opacity-60" : ""
                }`}
              >
                <p aria-live="polite" className="text-sm font-medium text-slate-200">
                  {summaryLine}
                </p>
                {failedPreview ? (
                  <div
                    id={errorId}
                    role="alert"
                    className="flex flex-wrap items-center gap-2 rounded-lg bg-slate-800 p-3 text-sm text-slate-200 ring-1 ring-white/10"
                  >
                    <span>
                      Couldn&apos;t preview this change.
                      {failedPreview.error ? ` ${failedPreview.error}` : ""}
                    </span>
                    <button
                      type="button"
                      onClick={previewAgain}
                      className="min-h-[44px] rounded px-3 py-1 font-medium text-indigo-300 hover:bg-slate-700"
                    >
                      Retry
                    </button>
                  </div>
                ) : shown ? (
                  <>
                    <CapabilityPlanSections
                      source={shown.response}
                      idPrefix="capabilities-preview"
                    />
                    {shown.response.profile &&
                      profileBullets(shown.response.profile).length > 0 && (
                        <div>
                          <p className="text-xs font-medium text-slate-200">
                            What this business will see
                          </p>
                          <ul className="mt-1 list-disc pl-4 text-xs text-slate-300">
                            {profileBullets(shown.response.profile).map((b) => (
                              <li key={b}>{b}</li>
                            ))}
                          </ul>
                        </div>
                      )}
                  </>
                ) : (
                  <p className="text-sm text-slate-400">Checking what would change…</p>
                )}
              </div>
            </div>
          )}

          <div className="flex flex-col gap-2 lg:col-start-1 lg:row-start-2">
            <button
              type="button"
              disabled={!canApply}
              onClick={onApplyClick}
              aria-describedby={failedPreview ? errorId : reason ? reasonId : undefined}
              className="min-h-[44px] w-full rounded-lg bg-indigo-600 px-4 py-2 text-sm font-semibold text-white hover:bg-indigo-500 disabled:opacity-50 sm:w-auto sm:self-start"
            >
              {applying ? "Applying…" : stops.length > 0 ? "Stop billing and apply" : "Apply"}
            </button>
            {reason && (
              <p id={reasonId} className="text-xs text-slate-400">
                {reason}
              </p>
            )}
            {savedNote && (
              <p role="status" className="text-sm text-emerald-400">
                {savedNote}
              </p>
            )}
            {applyError && (
              <p role="alert" className="text-sm text-red-400">
                {applyError}
              </p>
            )}
          </div>
        </div>
      )}

      <CapabilityBillingDialog
        open={confirmOpen}
        rows={stops}
        busy={applying}
        onCancel={() => setConfirmOpen(false)}
        onConfirm={() => void doApply()}
      />
    </AdminCard>
  );
}
