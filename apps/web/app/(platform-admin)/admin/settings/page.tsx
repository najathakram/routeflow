"use client";

import * as React from "react";
import {
  Bot,
  Key,
  Eye,
  EyeOff,
  CheckCircle2,
  AlertCircle,
  Save,
  RefreshCw,
  Info,
} from "lucide-react";
import { superAdminClient } from "@/lib/admin-api";

// ─── Types ────────────────────────────────────────────────────────────────────

interface AiConfig {
  configured: boolean;
  source: "database" | "environment" | "none";
  keyPreview: string | null;
  model: string;
  maxTokens: number;
  availableModels: string[];
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function StatusBadge({ configured, source }: { configured: boolean; source: string }) {
  if (!configured) {
    return (
      <span className="inline-flex items-center gap-1.5 rounded-full bg-red-950/60 px-2.5 py-1 text-xs font-medium text-red-400">
        <AlertCircle className="h-3.5 w-3.5" />
        Not configured
      </span>
    );
  }
  if (source === "environment") {
    return (
      <span className="inline-flex items-center gap-1.5 rounded-full bg-amber-950/60 px-2.5 py-1 text-xs font-medium text-amber-400">
        <Info className="h-3.5 w-3.5" />
        From env variable
      </span>
    );
  }
  return (
    <span className="inline-flex items-center gap-1.5 rounded-full bg-emerald-950/60 px-2.5 py-1 text-xs font-medium text-emerald-400">
      <CheckCircle2 className="h-3.5 w-3.5" />
      Configured
    </span>
  );
}

// ─── Page ─────────────────────────────────────────────────────────────────────

export default function AdminSettingsPage() {
  const [config, setConfig] = React.useState<AiConfig | null>(null);
  const [loading, setLoading] = React.useState(true);
  const [saving, setSaving] = React.useState(false);
  const [saveError, setSaveError] = React.useState<string | null>(null);
  const [saveSuccess, setSaveSuccess] = React.useState(false);

  // Form state
  const [apiKey, setApiKey] = React.useState("");
  const [showKey, setShowKey] = React.useState(false);
  const [model, setModel] = React.useState("claude-sonnet-4-5");
  const [maxTokens, setMaxTokens] = React.useState(4096);

  const load = React.useCallback(async () => {
    setLoading(true);
    try {
      const { data } = await superAdminClient.get<AiConfig>("/platform-admin/ai-config");
      setConfig(data);
      setModel(data.model);
      setMaxTokens(data.maxTokens);
    } catch {
      // handled by showing error state
    } finally {
      setLoading(false);
    }
  }, []);

  React.useEffect(() => {
    load();
  }, [load]);

  const handleSave = async (e: React.FormEvent) => {
    e.preventDefault();
    setSaving(true);
    setSaveError(null);
    setSaveSuccess(false);

    try {
      const body: Record<string, unknown> = { model, maxTokens };
      // Only send apiKey if the field has been touched (not empty placeholder)
      if (apiKey !== "") {
        body.apiKey = apiKey;
      }
      const { data } = await superAdminClient.patch<AiConfig>("/platform-admin/ai-config", body);
      setConfig(data);
      setApiKey(""); // clear after save
      setSaveSuccess(true);
      setTimeout(() => setSaveSuccess(false), 3000);
    } catch (err: any) {
      setSaveError(err?.response?.data?.message ?? "Failed to save settings");
    } finally {
      setSaving(false);
    }
  };

  const handleClearKey = async () => {
    if (!confirm("Remove the stored API key? The system will fall back to the ANTHROPIC_API_KEY environment variable.")) return;
    setSaving(true);
    try {
      const { data } = await superAdminClient.patch<AiConfig>("/platform-admin/ai-config", { apiKey: "" });
      setConfig(data);
      setApiKey("");
    } catch (err: any) {
      setSaveError(err?.response?.data?.message ?? "Failed to clear key");
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="min-h-full bg-slate-950 px-6 py-8">
      <div className="mx-auto max-w-2xl">

        {/* Header */}
        <div className="mb-8 flex items-center gap-3">
          <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-indigo-600/20 ring-1 ring-indigo-500/30">
            <Bot className="h-5 w-5 text-indigo-400" />
          </div>
          <div>
            <h1 className="text-xl font-bold text-white">AI Settings</h1>
            <p className="text-sm text-slate-400">
              Platform-wide Claude AI configuration — applies to all tenants by default
            </p>
          </div>
        </div>

        {loading ? (
          <div className="flex items-center justify-center py-20">
            <RefreshCw className="h-6 w-6 animate-spin text-slate-500" />
          </div>
        ) : (
          <form onSubmit={handleSave} className="flex flex-col gap-6">

            {/* Status card */}
            <div className="rounded-xl border border-slate-700/50 bg-slate-900 p-5">
              <div className="flex items-center justify-between">
                <div>
                  <p className="text-sm font-medium text-slate-200">API Key Status</p>
                  {config?.keyPreview && (
                    <p className="mt-0.5 font-mono text-xs text-slate-500">{config.keyPreview}</p>
                  )}
                </div>
                <StatusBadge configured={config?.configured ?? false} source={config?.source ?? "none"} />
              </div>
              {config?.source === "environment" && (
                <p className="mt-3 rounded-lg bg-amber-950/30 px-3 py-2 text-xs text-amber-400">
                  Key is sourced from the <code className="font-mono">ANTHROPIC_API_KEY</code> environment variable.
                  Enter a key below to override it in the database instead.
                </p>
              )}
            </div>

            {/* API Key */}
            <div className="rounded-xl border border-slate-700/50 bg-slate-900 p-5">
              <div className="mb-4 flex items-center gap-2">
                <Key className="h-4 w-4 text-slate-400" />
                <h2 className="text-sm font-semibold text-slate-200">Anthropic API Key</h2>
              </div>

              <div className="relative">
                <input
                  type={showKey ? "text" : "password"}
                  value={apiKey}
                  onChange={(e) => setApiKey(e.target.value)}
                  placeholder={config?.configured ? "Enter new key to replace current" : "sk-ant-api03-..."}
                  autoComplete="off"
                  spellCheck={false}
                  className="w-full rounded-lg border border-slate-700 bg-slate-800 px-3 py-2.5 pr-10 font-mono text-sm text-slate-200 placeholder:text-slate-600 focus:border-indigo-500 focus:outline-none focus:ring-1 focus:ring-indigo-500"
                />
                <button
                  type="button"
                  onClick={() => setShowKey((v) => !v)}
                  className="absolute right-3 top-1/2 -translate-y-1/2 text-slate-500 hover:text-slate-300"
                >
                  {showKey ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                </button>
              </div>
              <p className="mt-2 text-xs text-slate-500">
                Leave blank to keep the current key. The key is stored securely and only a preview is shown.
              </p>
              {config?.source === "database" && (
                <button
                  type="button"
                  onClick={handleClearKey}
                  className="mt-3 text-xs text-red-500 hover:text-red-400"
                >
                  Remove stored key
                </button>
              )}
            </div>

            {/* Model selection */}
            <div className="rounded-xl border border-slate-700/50 bg-slate-900 p-5">
              <h2 className="mb-4 text-sm font-semibold text-slate-200">Default Model</h2>

              <div className="grid gap-2">
                {(config?.availableModels ?? []).map((m) => {
                  const selected = model === m;
                  const isOpus = m.includes("opus");
                  const isSonnet = m.includes("sonnet");
                  const isHaiku = m.includes("haiku");
                  const tier = isOpus ? "Most capable" : isSonnet ? "Balanced" : isHaiku ? "Fastest" : "";
                  const tierColor = isOpus
                    ? "text-purple-400"
                    : isSonnet
                    ? "text-indigo-400"
                    : "text-emerald-400";

                  return (
                    <label
                      key={m}
                      className={`flex cursor-pointer items-center justify-between rounded-lg border px-4 py-3 transition-colors ${
                        selected
                          ? "border-indigo-500 bg-indigo-950/40"
                          : "border-slate-700 hover:border-slate-600 hover:bg-slate-800/50"
                      }`}
                    >
                      <div className="flex items-center gap-3">
                        <input
                          type="radio"
                          name="model"
                          value={m}
                          checked={selected}
                          onChange={() => setModel(m)}
                          className="h-4 w-4 accent-indigo-500"
                        />
                        <span className="font-mono text-sm text-slate-200">{m}</span>
                      </div>
                      {tier && (
                        <span className={`text-xs font-medium ${tierColor}`}>{tier}</span>
                      )}
                    </label>
                  );
                })}
              </div>
              <p className="mt-3 text-xs text-slate-500">
                Tenants can override this with their own model selection if the feature is enabled.
              </p>
            </div>

            {/* Max tokens */}
            <div className="rounded-xl border border-slate-700/50 bg-slate-900 p-5">
              <h2 className="mb-4 text-sm font-semibold text-slate-200">Max Output Tokens</h2>
              <div className="flex items-center gap-4">
                <input
                  type="number"
                  value={maxTokens}
                  onChange={(e) => setMaxTokens(Number(e.target.value))}
                  min={256}
                  max={32768}
                  step={256}
                  className="w-40 rounded-lg border border-slate-700 bg-slate-800 px-3 py-2 text-sm text-slate-200 focus:border-indigo-500 focus:outline-none focus:ring-1 focus:ring-indigo-500"
                />
                <span className="text-sm text-slate-500">tokens (256 – 32,768)</span>
              </div>
              <p className="mt-2 text-xs text-slate-500">
                Maximum number of tokens Claude will generate per response. 4,096 is a sensible default.
              </p>
            </div>

            {/* Feedback + Save */}
            {saveError && (
              <div className="flex items-center gap-2 rounded-lg bg-red-950/40 px-4 py-3 text-sm text-red-400">
                <AlertCircle className="h-4 w-4 shrink-0" />
                {saveError}
              </div>
            )}
            {saveSuccess && (
              <div className="flex items-center gap-2 rounded-lg bg-emerald-950/40 px-4 py-3 text-sm text-emerald-400">
                <CheckCircle2 className="h-4 w-4 shrink-0" />
                Settings saved successfully
              </div>
            )}

            <button
              type="submit"
              disabled={saving}
              className="flex items-center justify-center gap-2 rounded-xl bg-indigo-600 px-6 py-3 text-sm font-semibold text-white shadow transition-colors hover:bg-indigo-500 disabled:cursor-not-allowed disabled:opacity-50"
            >
              {saving ? (
                <RefreshCw className="h-4 w-4 animate-spin" />
              ) : (
                <Save className="h-4 w-4" />
              )}
              {saving ? "Saving…" : "Save AI Settings"}
            </button>
          </form>
        )}
      </div>
    </div>
  );
}
