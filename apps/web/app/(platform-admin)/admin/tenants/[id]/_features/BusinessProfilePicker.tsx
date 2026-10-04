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
import { PreviewDrawer } from "./PreviewDrawer";
import { profileErrorCopy } from "./profile-errors";
import type { RegistryLabelLookup } from "./preview-groups";

const humanize = (key: string) => key.replace(/_/g, " ").replace(/^./, (c) => c.toUpperCase());

/** "Fulfilment model: unset → ship" lines for the drawer's note. */
function modeNote(response: BusinessProfilePreviewResponse | null): string | undefined {
  const modes = response?.plan?.modes ?? [];
  if (modes.length === 0) return undefined;
  return modes.map((m) => `${humanize(m.key)}: ${m.from} → ${m.to}`).join(" · ");
}

/**
 * The Feature Console's "Business profile" control: pick a profile → PREVIEW (a dry run, writes nothing) → the shared
 * PreviewDrawer → Confirm (one audited apply). An unavailable profile is shown disabled and never sent. Failures show
 * fixed copy chosen by the API's error code, never the server message.
 */
export function BusinessProfilePicker({
  tenantId,
  registryByKey,
  onApplied,
}: {
  tenantId: string;
  registryByKey: RegistryLabelLookup;
  /** Called after a successful apply so the console reloads. */
  onApplied: () => void;
}) {
  const [profiles, setProfiles] = React.useState<BusinessProfileSummary[] | null>(null);
  const [listFailed, setListFailed] = React.useState(false);
  const [selected, setSelected] = React.useState<BusinessProfileKey | "">("");
  const [previewing, setPreviewing] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [pending, setPending] = React.useState<{
    profile: BusinessProfileKey;
    response: BusinessProfilePreviewResponse;
  } | null>(null);
  const [applying, setApplying] = React.useState(false);
  const [drawerError, setDrawerError] = React.useState<string | null>(null);

  const loadProfiles = React.useCallback(() => {
    setListFailed(false);
    fetchBusinessProfiles()
      .then(setProfiles)
      .catch(() => setListFailed(true));
  }, []);
  React.useEffect(loadProfiles, [loadProfiles]);

  if (listFailed) {
    return (
      <div role="alert" className="flex items-center gap-2 text-xs text-amber-400">
        Could not load business profiles.
        <button
          type="button"
          onClick={loadProfiles}
          className="rounded px-2 py-1 text-slate-300 hover:bg-slate-700"
        >
          Retry
        </button>
      </div>
    );
  }
  if (!profiles) return null;

  const labelOf = (key: string) => registryByKey[key]?.label;
  const chosen = profiles.find((p) => p.key === selected);

  async function startPreview() {
    if (!chosen || !chosen.available) return;
    setError(null);
    setPreviewing(true);
    try {
      const response = await previewBusinessProfile(tenantId, chosen.key);
      setDrawerError(null);
      setPending({ profile: chosen.key, response });
    } catch (err) {
      setError(profileErrorCopy(err, "Could not preview that profile. Try again.", labelOf));
    } finally {
      setPreviewing(false);
    }
  }

  async function confirm() {
    if (!pending) return;
    setApplying(true);
    setDrawerError(null);
    try {
      await applyBusinessProfile(tenantId, pending.profile, undefined);
      setPending(null);
      setSelected("");
      onApplied();
    } catch (err) {
      setDrawerError(profileErrorCopy(err, "Could not apply that profile. Try again.", labelOf));
    } finally {
      setApplying(false);
    }
  }

  return (
    <div className="flex flex-wrap items-center gap-2">
      <label htmlFor="feature-console-profile" className="text-sm text-slate-400">
        Business profile
      </label>
      <select
        id="feature-console-profile"
        value={selected}
        onChange={(e) => setSelected(e.target.value as BusinessProfileKey | "")}
        className="h-9 rounded-lg border border-slate-600 bg-slate-700 px-3 text-sm text-white focus:border-indigo-500 focus:outline-none"
      >
        <option value="">Choose a profile…</option>
        {profiles.map((p) => (
          <option key={p.key} value={p.key} disabled={!p.available}>
            {p.label}
            {p.available ? "" : " (not available yet)"}
          </option>
        ))}
      </select>
      <button
        type="button"
        disabled={!chosen || !chosen.available || previewing}
        onClick={startPreview}
        className="rounded-lg bg-slate-600 px-4 py-2 text-sm font-semibold text-white hover:bg-slate-500 disabled:opacity-50"
      >
        {previewing ? "Loading preview..." : "Preview profile"}
      </button>
      {error && (
        <p role="alert" className="w-full text-xs text-red-400">
          {error}
        </p>
      )}
      <PreviewDrawer
        open={pending !== null}
        title="Apply business profile"
        subtitle={profiles.find((p) => p.key === pending?.profile)?.label}
        note={modeNote(pending?.response ?? null)}
        emptyMessage="This tenant already matches this profile."
        allowEmptyConfirm
        response={pending?.response ?? null}
        registryByKey={registryByKey}
        confirming={applying}
        error={drawerError}
        onConfirm={confirm}
        onClose={() => {
          setPending(null);
          setDrawerError(null);
        }}
      />
    </div>
  );
}
