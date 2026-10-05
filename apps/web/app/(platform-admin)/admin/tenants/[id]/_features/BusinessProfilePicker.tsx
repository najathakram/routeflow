"use client";

import * as React from "react";
import type {
  BusinessProfileKey,
  BusinessProfilePreviewResponse,
  BusinessProfileSummary,
} from "@routeflow/types";
import {
  applyBusinessProfile,
  fetchBusinessProfiles,
  previewBusinessProfile,
} from "@/lib/platform-admin/business-profiles";
import { AdminCard } from "../../../../_components/AdminCard";
import { BusinessProfileChoices } from "./BusinessProfileChoices";
import { BusinessProfilePreviewModal } from "./BusinessProfilePreviewModal";
import { profileErrorCopy, profilePartlyApplied, profilePlanChanged } from "./profile-errors";

type Pending = { profile: BusinessProfileSummary; response: BusinessProfilePreviewResponse };

/**
 * The Setup tab's "Business profile" card: pick one of the four profiles → PREVIEW (a dry run that writes nothing,
 * shown as the API's plain-English change list) → Confirm (one audited apply). A profile the API reports unavailable
 * is shown disabled and is never previewed or sent. Every failure shows fixed copy chosen by the API's error code,
 * never the server message. Platform admin only: the route behind it is SuperAdminGuard-ed and the parent renders this
 * for a super admin alone.
 */
export function BusinessProfilePicker({
  tenantId,
  onApplied,
}: {
  tenantId: string;
  /** Called after the tenant's setup changed (a full apply, or a partial one) so the screen reloads. */
  onApplied: () => void;
}) {
  const [profiles, setProfiles] = React.useState<BusinessProfileSummary[] | null>(null);
  const [listFailed, setListFailed] = React.useState(false);
  const [selected, setSelected] = React.useState<BusinessProfileKey | "">("");
  const [previewing, setPreviewing] = React.useState(false);
  const [previewError, setPreviewError] = React.useState<string | null>(null);
  const [pending, setPending] = React.useState<Pending | null>(null);
  const [applying, setApplying] = React.useState(false);
  const [applyError, setApplyError] = React.useState<string | null>(null);
  /** Re-previewing after a failed confirm: Confirm stays off until the fresh plan is on screen. */
  const [refreshing, setRefreshing] = React.useState(false);
  const [appliedLabel, setAppliedLabel] = React.useState<string | null>(null);

  const loadProfiles = React.useCallback(() => {
    setListFailed(false);
    fetchBusinessProfiles()
      .then(setProfiles)
      .catch(() => setListFailed(true));
  }, []);
  React.useEffect(loadProfiles, [loadProfiles]);

  const chosen = profiles?.find((p) => p.key === selected);

  async function startPreview() {
    if (!chosen || !chosen.available) return;
    setPreviewError(null);
    setAppliedLabel(null);
    setPreviewing(true);
    try {
      const response = await previewBusinessProfile(tenantId, chosen.key);
      setApplyError(null);
      setPending({ profile: chosen, response });
    } catch (err) {
      setPreviewError(profileErrorCopy(err, "Could not preview that business profile. Try again."));
    } finally {
      setPreviewing(false);
    }
  }

  /** The plan the admin is looking at is no longer the tenant's: fetch it again (keeps the error shown). */
  async function refreshPreview(profile: BusinessProfileSummary) {
    setRefreshing(true);
    try {
      const response = await previewBusinessProfile(tenantId, profile.key);
      setPending({ profile, response });
    } catch {
      setPending(null); // nothing safe to confirm; the inline preview error path takes over
      setPreviewError("Could not refresh the preview. Preview the profile again.");
    } finally {
      setRefreshing(false);
    }
  }

  async function confirm() {
    if (!pending || applying || refreshing) return;
    setApplying(true);
    setApplyError(null);
    try {
      await applyBusinessProfile(tenantId, pending.profile.key, pending.response.planFingerprint);
      setAppliedLabel(pending.profile.label);
      setPending(null);
      setSelected("");
      onApplied();
    } catch (err) {
      setApplyError(profileErrorCopy(err, "Could not apply that business profile. Try again."));
      // Billing already stopped for some add-ons: the tenant HAS changed, so the screen behind must catch up.
      const partly = profilePartlyApplied(err);
      if (partly) onApplied();
      // Either way the shown plan is stale: re-preview BEFORE Confirm can be pressed again (#3220 c).
      if (partly || profilePlanChanged(err)) {
        setApplying(false);
        await refreshPreview(pending.profile);
        return;
      }
    } finally {
      setApplying(false);
    }
  }

  return (
    <AdminCard title="Business profile" className="mb-4">
      <p className="mb-4 text-sm text-slate-400">
        Pick the setup that fits this business. You will see exactly what changes, including any
        billing that stops, before anything is saved. Modules a profile turns on are added free
        (comp), with no charge.
      </p>

      {listFailed ? (
        <div role="alert" className="flex items-center gap-2 text-sm text-amber-400">
          Could not load business profiles.
          <button
            type="button"
            onClick={loadProfiles}
            className="rounded px-2 py-1 text-slate-300 hover:bg-slate-700"
          >
            Retry
          </button>
        </div>
      ) : !profiles ? (
        <p className="text-sm text-slate-400">Loading business profiles...</p>
      ) : (
        <>
          <BusinessProfileChoices
            profiles={profiles}
            value={selected}
            onChange={setSelected}
            name="setup-business-profile"
            legend="Business profile"
            disabled={previewing || applying}
          />
          <div className="mt-4 flex flex-wrap items-center gap-3">
            <button
              type="button"
              disabled={!chosen || !chosen.available || previewing}
              onClick={startPreview}
              className="rounded-lg bg-slate-600 px-4 py-2 text-sm font-semibold text-white hover:bg-slate-500 disabled:opacity-50"
            >
              {previewing ? "Loading preview..." : "Preview changes"}
            </button>
            {appliedLabel && (
              <p role="status" className="text-sm text-emerald-400">
                Business profile applied: {appliedLabel}.
              </p>
            )}
          </div>
          {previewError && (
            <p role="alert" className="mt-3 text-sm text-red-400">
              {previewError}
            </p>
          )}
        </>
      )}

      <BusinessProfilePreviewModal
        open={pending !== null}
        profileLabel={pending?.profile.label ?? ""}
        response={pending?.response ?? null}
        confirming={applying}
        refreshing={refreshing}
        error={applyError}
        onConfirm={confirm}
        onClose={() => {
          setPending(null);
          setApplyError(null);
        }}
      />
    </AdminCard>
  );
}
