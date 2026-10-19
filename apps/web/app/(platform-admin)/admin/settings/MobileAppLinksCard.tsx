"use client";

import * as React from "react";
import { CheckCircle2, Save, Smartphone } from "lucide-react";
import { API_ERROR_CODES } from "@routeflow/types";
import type { AppLinkField, AppLinks } from "@routeflow/types";
import { superAdminClient } from "@/lib/admin-api";

const FIELDS: { field: AppLinkField; label: string }[] = [
  { field: "androidApkUrl", label: "Android download link (APK)" },
  { field: "playStoreUrl", label: "Google Play link" },
  { field: "iosUrl", label: "iPhone and iPad link" },
];

type Draft = Record<AppLinkField, string>;

const toDraft = (links: AppLinks): Draft => ({
  androidApkUrl: links.androidApkUrl ?? "",
  playStoreUrl: links.playStoreUrl ?? "",
  iosUrl: links.iosUrl ?? "",
});

/**
 * Row 559: the global install links behind every signed-in "Get the app" page. An empty field hides
 * that option. The server validates (https only); its answer is shown beside the field it names.
 */
export function MobileAppLinksCard() {
  const [draft, setDraft] = React.useState<Draft | null>(null);
  const [loadFailed, setLoadFailed] = React.useState(false);
  const [saving, setSaving] = React.useState(false);
  const [saved, setSaved] = React.useState(false);
  const [fieldError, setFieldError] = React.useState<{
    field: AppLinkField;
    message: string;
  } | null>(null);
  const [error, setError] = React.useState<string | null>(null);

  React.useEffect(() => {
    let cancelled = false;
    superAdminClient
      .get<AppLinks>("/platform-admin/app-links")
      .then((res) => {
        if (!cancelled) setDraft(toDraft(res.data));
      })
      .catch(() => {
        if (!cancelled) setLoadFailed(true);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const save = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!draft) return;
    setSaving(true);
    setSaved(false);
    setFieldError(null);
    setError(null);
    try {
      // "" clears a link (the server deletes the row); every field is sent so the card is the whole truth.
      const { data } = await superAdminClient.put<AppLinks>("/platform-admin/app-links", draft);
      setDraft(toDraft(data));
      setSaved(true);
    } catch (err: unknown) {
      const body = (
        err as { response?: { data?: { code?: string; field?: string; message?: string } } }
      )?.response?.data;
      const known = FIELDS.find((f) => f.field === body?.field);
      if (body?.code === API_ERROR_CODES.APP_LINK_URL_INVALID && known) {
        setFieldError({
          field: known.field,
          message: body.message ?? "Enter a full https:// link.",
        });
      } else {
        setError(body?.message ?? "Failed to save the links");
      }
    } finally {
      setSaving(false);
    }
  };

  return (
    <section
      aria-labelledby="mobile-app-links-title"
      className="mt-6 rounded-xl border border-slate-700/50 bg-slate-900 p-5"
    >
      <div className="mb-1 flex items-center gap-2">
        <Smartphone className="h-4 w-4 text-slate-400" />
        <h2 id="mobile-app-links-title" className="text-sm font-semibold text-slate-200">
          Mobile app links
        </h2>
      </div>
      <p className="mb-4 text-xs text-slate-400">
        Shown to every signed-in user on the Get the app page. Leave empty to hide an option.
      </p>

      {loadFailed ? (
        <p role="alert" className="text-sm text-red-400">
          Could not load the app links.
        </p>
      ) : !draft ? (
        <p className="text-sm text-slate-400">Loading…</p>
      ) : (
        <form onSubmit={save} className="flex flex-col gap-4">
          {FIELDS.map(({ field, label }) => {
            const message = fieldError?.field === field ? fieldError.message : null;
            const errId = `app-link-${field}-error`;
            return (
              <div key={field}>
                <label htmlFor={`app-link-${field}`} className="text-xs font-medium text-slate-300">
                  {label}
                </label>
                <input
                  id={`app-link-${field}`}
                  type="url"
                  inputMode="url"
                  value={draft[field]}
                  onChange={(e) => setDraft({ ...draft, [field]: e.target.value })}
                  placeholder="https://"
                  autoComplete="off"
                  spellCheck={false}
                  aria-invalid={message ? true : undefined}
                  aria-describedby={message ? errId : undefined}
                  className="mt-1 w-full rounded-lg border border-slate-700 bg-slate-800 px-3 py-2.5 font-mono text-sm text-slate-200 placeholder:text-slate-600 focus:border-indigo-500 focus:outline-none focus:ring-1 focus:ring-indigo-500"
                />
                {message && (
                  <p id={errId} role="alert" className="mt-1 text-xs text-red-400">
                    {message}
                  </p>
                )}
              </div>
            );
          })}
          {error && (
            <p role="alert" className="text-sm text-red-400">
              {error}
            </p>
          )}
          <div className="flex items-center gap-3">
            <button
              type="submit"
              disabled={saving}
              className="inline-flex items-center gap-2 rounded-lg bg-indigo-600 px-4 py-2 text-sm font-medium text-white hover:bg-indigo-500 disabled:opacity-60"
            >
              <Save className="h-4 w-4" />
              {saving ? "Saving…" : "Save links"}
            </button>
            {saved && (
              <span
                role="status"
                className="inline-flex items-center gap-1.5 text-sm text-emerald-400"
              >
                <CheckCircle2 className="h-4 w-4" />
                Saved
              </span>
            )}
          </div>
        </form>
      )}
    </section>
  );
}
