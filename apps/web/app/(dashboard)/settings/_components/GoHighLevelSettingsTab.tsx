"use client";

import * as React from "react";
import {
  Card,
  Badge,
  Button,
  Input,
  PasswordInput,
  Select,
  SkeletonRows,
  useToast,
  cn,
  type BadgeVariant,
} from "@routeflow/ui/web";
import { ConfirmDialog } from "@/components/ConfirmDialog";
import {
  useCrmStatus,
  useSaveCrmConnection,
  useTestCrmConnection,
  useDisconnectCrm,
  useUpdateCrmConfig,
  useSyncCrmNow,
  useCrmHandoffs,
  useCrmPipelines,
  usePreviewCrmImport,
  useImportExistingCrmLeads,
  useRetryHandoff,
  useDismissHandoff,
  type CrmHandoffsResult,
} from "@/lib/api/crm";
import type { CrmConfigPatch, CrmPipeline, CrmHandoffRow } from "@routeflow/types";

// 2026-09-11-crm-gohighlevel-handoff (WP4, fix round M14-M17/m3-m6) — Settings →
// GoHighLevel tab. See ux-spec.md for the full copy/state contract (Cards 1-4) and
// settings-gohighlevel.test.tsx for the pinned assertions (T45-T48 + the fix-round
// stage-picker/activity-envelope/preview tests).
//
// `GoHighLevelSettingsTab` below is intentionally pure/presentational — it is
// rendered directly with props in the unit tests (no QueryClientProvider in
// scope there), so it must never call a TanStack Query hook itself. The
// default export is the "connected" container used by settings/page.tsx: it
// owns all data-fetching/mutations and passes the results down as props.

export interface CrmActivityRow {
  id: string;
  status: string;
  reason?: string | null;
  opportunityName?: string;
  contactName?: string;
  matchedBy?: string | null;
  customerId?: string | null;
  createdAt?: string;
}

export interface CrmConfigView {
  triggerMode: "STAGE" | "WON";
  pipelineId: string | null;
  stageId: string | null;
  stageName: string | null;
  startFrom: string;
  writeBackFields: boolean;
  writeBackTag: boolean;
  writeBackNote: boolean;
  markWon: boolean;
  enabled: boolean;
}

export interface CrmImportPreviewView {
  count: number;
  sample: Array<{
    opportunityName: string | null;
    contactName: string | null;
    email: string | null;
    phone: string | null;
  }>;
}

export interface GoHighLevelSettingsTabProps {
  status: "CONNECTED" | "NEEDS_ATTENTION" | "DISCONNECTED" | null;
  locationName?: string | null;
  dryRun?: boolean;
  activity?: CrmActivityRow[];
  activityLoading?: boolean;
  activityError?: boolean;
  onRetryActivity?: () => void;
  hasMoreActivity?: boolean;
  onLoadMoreActivity?: () => void;
  tokenLast4?: string | null;
  config?: CrmConfigView | null;
  savingConnection?: boolean;
  connectionError?: string | null;
  onSaveConnection?: (input: { token: string; locationId: string }) => void;
  disconnecting?: boolean;
  onDisconnect?: () => void;
  savingConfig?: boolean;
  onUpdateConfig?: (patch: CrmConfigPatch) => void;
  checkingNow?: boolean;
  onCheckNow?: () => void;
  onRetry?: (id: string) => void;
  onDismiss?: (id: string) => void;
  testingAgain?: boolean;
  onTestAgain?: () => void;
  pipelines?: CrmPipeline[];
  pipelinesLoading?: boolean;
  pipelinesError?: boolean;
  onRetryPipelines?: () => void;
  previewLoading?: boolean;
  previewResult?: CrmImportPreviewView | null;
  onPreviewImport?: () => void;
  importing?: boolean;
  onImportExisting?: () => void;
}

// Reason codes (spec R22 / ux-spec.md Card 4) translated to plain, non-technical words.
const HANDOFF_REASON_TEXT: Record<string, string> = {
  "no-identity": "No email or phone on the contact",
  "identity-conflict": "Email or username already used by a staff account",
  "customer-cap": "Customer limit reached",
  "contact-not-found": "Contact deleted in GoHighLevel",
  "create-failed": "Could not create the customer",
};

const CONNECTION_BADGE: Record<string, { label: string; variant: BadgeVariant }> = {
  CONNECTED: { label: "Connected", variant: "success" },
  NEEDS_ATTENTION: { label: "Needs attention", variant: "warning" },
  DISCONNECTED: { label: "Disconnected", variant: "neutral" },
};

const ACTIVITY_BADGE: Record<string, { label: string; variant: BadgeVariant }> = {
  CREATED: { label: "Created", variant: "success" },
  LINKED: { label: "Linked", variant: "success" },
  WRITEBACK_PENDING: { label: "Created", variant: "success" },
  DRY_RUN: { label: "Preview", variant: "info" },
  NEEDS_REVIEW: { label: "Needs review", variant: "warning" },
  PENDING: { label: "Pending", variant: "neutral" },
  FAILED: { label: "Failed", variant: "danger" },
  SKIPPED: { label: "Skipped", variant: "neutral" },
};

function detailsText(row: CrmActivityRow): string {
  if (row.matchedBy) return `Existing customer matched by ${row.matchedBy}`;
  if (row.reason && HANDOFF_REASON_TEXT[row.reason]) return HANDOFF_REASON_TEXT[row.reason];
  if (row.status === "WRITEBACK_PENDING") return "Created; still updating GoHighLevel";
  return "—";
}

// Relative-time cell for the Activity table's "When" column (ux-spec Card 4, m3).
// Mirrors the `timeAgo` idiom already duplicated per-file in dashboard/page.tsx
// and layout.tsx — no shared helper exists yet to import instead.
function timeAgo(dateStr?: string | null): string {
  if (!dateStr) return "—";
  const diff = Date.now() - new Date(dateStr).getTime();
  const minutes = Math.floor(diff / 60000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

// Compact role="switch" toggle (NotificationsSettingsTab's MiniSwitch idiom).
function MiniSwitch({
  checked,
  disabled,
  onToggle,
  ariaLabel,
}: {
  checked: boolean;
  disabled?: boolean;
  onToggle: () => void;
  ariaLabel: string;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={ariaLabel}
      disabled={disabled}
      onClick={onToggle}
      className={cn(
        "relative inline-flex h-5 w-9 flex-none items-center rounded-full transition-colors disabled:cursor-not-allowed disabled:opacity-50",
        checked ? "bg-brand-500" : "bg-navy/20",
      )}
    >
      <span
        className={cn(
          "inline-block h-4 w-4 transform rounded-full bg-white shadow transition-transform",
          checked ? "translate-x-4" : "translate-x-0.5",
        )}
      />
    </button>
  );
}

const FILTERS = [
  { key: "all", label: "All" },
  { key: "NEEDS_REVIEW", label: "Needs review" },
  { key: "CREATED", label: "Created" },
  { key: "LINKED", label: "Linked" },
  { key: "DRY_RUN", label: "Preview" },
  { key: "FAILED", label: "Failed" },
] as const;

const ACTIVITY_SKELETON_COLUMNS = [120, 120, 80, 160, 60, 90];

/**
 * Pure presentational tab — every card is driven entirely by props. Real
 * data-fetching lives in the default-exported container below.
 */
export function GoHighLevelSettingsTab(props: GoHighLevelSettingsTabProps): React.ReactElement {
  const {
    status,
    locationName,
    dryRun,
    activity = [],
    activityLoading,
    activityError,
    onRetryActivity,
    hasMoreActivity,
    onLoadMoreActivity,
    tokenLast4,
    config,
    savingConnection,
    connectionError,
    onSaveConnection,
    disconnecting,
    onDisconnect,
    savingConfig,
    onUpdateConfig,
    checkingNow,
    onCheckNow,
    onRetry,
    onDismiss,
    testingAgain,
    onTestAgain,
    pipelines = [],
    pipelinesLoading,
    pipelinesError,
    onRetryPipelines,
    previewLoading,
    previewResult,
    onPreviewImport,
    importing,
    onImportExisting,
  } = props;

  const [tokenInput, setTokenInput] = React.useState("");
  const [locationInput, setLocationInput] = React.useState("");
  const [editingConnection, setEditingConnection] = React.useState(status !== "CONNECTED");
  React.useEffect(() => setEditingConnection(status !== "CONNECTED"), [status]);
  // #5 — a successful Save & test collapses the card into the summary line; whenever that
  // happens (editingConnection flips false, above), the pasted key/location must not linger
  // in local state for the next time "Replace key" re-opens these inputs.
  React.useEffect(() => {
    if (!editingConnection) {
      setTokenInput("");
      setLocationInput("");
    }
  }, [editingConnection]);
  const [confirmDisconnect, setConfirmDisconnect] = React.useState(false);
  const [confirmImport, setConfirmImport] = React.useState(false);
  const [howToOpen, setHowToOpen] = React.useState(false);
  const [filter, setFilter] = React.useState<(typeof FILTERS)[number]["key"]>("all");
  const [previewMode, setPreviewMode] = React.useState(dryRun ?? true);
  React.useEffect(() => setPreviewMode(dryRun ?? true), [dryRun]);
  const [enabled, setEnabled] = React.useState(config?.enabled ?? false);
  React.useEffect(() => setEnabled(config?.enabled ?? false), [config?.enabled]);
  const [writeBackFields, setWriteBackFields] = React.useState(config?.writeBackFields ?? true);
  const [writeBackTag, setWriteBackTag] = React.useState(config?.writeBackTag ?? true);
  const [writeBackNote, setWriteBackNote] = React.useState(config?.writeBackNote ?? true);
  const [markWon, setMarkWon] = React.useState(config?.markWon ?? false);

  // Card 2 — trigger mode / pipeline / stage / start-from. Local draft state so
  // "Save" stays disabled until something actually changed (ux-spec Card 2).
  const [triggerMode, setTriggerMode] = React.useState<"STAGE" | "WON">(
    config?.triggerMode ?? "STAGE",
  );
  const [pipelineId, setPipelineId] = React.useState<string | null>(config?.pipelineId ?? null);
  const [stageId, setStageId] = React.useState<string | null>(config?.stageId ?? null);
  const [stageName, setStageName] = React.useState<string | null>(config?.stageName ?? null);
  const [startFrom, setStartFrom] = React.useState<string>(config?.startFrom ?? "");
  React.useEffect(() => {
    setTriggerMode(config?.triggerMode ?? "STAGE");
    setPipelineId(config?.pipelineId ?? null);
    setStageId(config?.stageId ?? null);
    setStageName(config?.stageName ?? null);
    setStartFrom(config?.startFrom ?? "");
  }, [
    config?.triggerMode,
    config?.pipelineId,
    config?.stageId,
    config?.stageName,
    config?.startFrom,
  ]);

  const selectedPipeline = pipelines.find((p) => p.id === pipelineId);
  const triggerChanged =
    triggerMode !== (config?.triggerMode ?? "STAGE") ||
    pipelineId !== (config?.pipelineId ?? null) ||
    stageId !== (config?.stageId ?? null) ||
    startFrom !== (config?.startFrom ?? "");

  const badge = status
    ? CONNECTION_BADGE[status]
    : { label: "Not connected", variant: "neutral" as BadgeVariant };

  const filteredActivity =
    filter === "all" ? activity : activity.filter((row) => row.status === filter);

  const emptyActivityCopy =
    config?.triggerMode === "WON"
      ? "No leads yet. When a lead is marked Won, it appears here."
      : `No leads yet. When a lead reaches ${config?.stageName ?? "the configured stage"}, it appears here.`;

  return (
    <div className="flex flex-col gap-5">
      {status === "NEEDS_ATTENTION" && (
        <div className="flex flex-wrap items-center justify-between gap-2 rounded-ctl bg-warning-bg px-4 py-3 text-sm text-warning">
          <span>RouteFlow lost access to GoHighLevel. Paste a new connection key below.</span>
          <Button
            variant="secondary"
            size="sm"
            loading={testingAgain}
            onClick={() => onTestAgain?.()}
          >
            Test again
          </Button>
        </div>
      )}

      {/* Card 1 — Connection */}
      <Card className="flex flex-col gap-4">
        <div className="flex items-center gap-2">
          <h3 className="text-base font-semibold text-navy">Connection</h3>
          <Badge variant={badge.variant} label={badge.label} />
        </div>

        {editingConnection ? (
          <div className="flex flex-col gap-3">
            <PasswordInput
              label="Connection key"
              value={tokenInput}
              onChange={(e) => setTokenInput(e.target.value)}
              placeholder="Paste the key from GoHighLevel"
              autoComplete="off"
            />
            <Input
              label="GoHighLevel account ID"
              value={locationInput}
              onChange={(e) => setLocationInput(e.target.value)}
              placeholder="e.g. loc_123"
            />
            <button
              type="button"
              className="self-start text-left text-xs font-medium text-brand-600 hover:text-brand-700"
              onClick={() => setHowToOpen((v) => !v)}
            >
              How do I get a key?
            </button>
            {howToOpen && (
              <p className="text-xs leading-relaxed text-navy/60">
                Create the key in GoHighLevel: Settings → Private Integrations → Create new
                integration. Tick: Contacts (read + write), Opportunities (read; write only if
                &quot;Mark the lead as Won&quot; is used), Custom fields (read + write), Location
                (read). Copy it once — it is shown only once.
              </p>
            )}
            {connectionError && <p className="text-sm text-danger">{connectionError}</p>}
            <div>
              <Button
                onClick={() => onSaveConnection?.({ token: tokenInput, locationId: locationInput })}
                loading={savingConnection}
                disabled={!tokenInput.trim() || !locationInput.trim()}
              >
                Save &amp; test
              </Button>
            </div>
          </div>
        ) : (
          <div className="flex flex-col gap-3">
            <p className="text-sm text-navy/70">
              Connected to {locationName ?? "—"}
              {tokenLast4 ? <> · key ending in ····{tokenLast4}</> : null}
            </p>
            <div className="flex items-center gap-2">
              <Button variant="secondary" size="sm" onClick={() => setEditingConnection(true)}>
                Replace key
              </Button>
              <Button variant="ghost" size="sm" onClick={() => setConfirmDisconnect(true)}>
                Disconnect
              </Button>
            </div>
          </div>
        )}

        <ConfirmDialog
          open={confirmDisconnect}
          onClose={() => setConfirmDisconnect(false)}
          onConfirm={() => {
            onDisconnect?.();
            setConfirmDisconnect(false);
          }}
          title="Disconnect GoHighLevel?"
          description="RouteFlow will stop creating customers from GoHighLevel. Existing customers are kept."
          confirmLabel="Disconnect"
          variant="danger"
          loading={disconnecting}
        />
      </Card>

      {/* Card 2 — When does a lead become a customer? */}
      {status === "CONNECTED" && config && (
        <Card className="flex flex-col gap-4">
          <h3 className="text-base font-semibold text-navy">When does a lead become a customer?</h3>

          <div className="flex flex-col gap-2">
            <label className="flex items-center gap-2 text-sm text-navy">
              <input
                type="radio"
                name="crm-trigger-mode"
                checked={triggerMode === "STAGE"}
                onChange={() => setTriggerMode("STAGE")}
              />
              When a lead reaches a stage
            </label>
            <label className="flex items-center gap-2 text-sm text-navy">
              <input
                type="radio"
                name="crm-trigger-mode"
                checked={triggerMode === "WON"}
                onChange={() => setTriggerMode("WON")}
              />
              When a lead is marked Won
            </label>
          </div>

          {triggerMode === "STAGE" &&
            (pipelinesError ? (
              <div className="flex items-center gap-2 text-sm text-danger">
                <span>Couldn&apos;t load pipelines.</span>
                <button
                  type="button"
                  className="font-medium underline"
                  onClick={() => onRetryPipelines?.()}
                >
                  Retry
                </button>
              </div>
            ) : !pipelinesLoading && pipelines.length === 0 ? (
              <p className="text-sm text-navy/50">
                No pipelines found in this GoHighLevel account.
              </p>
            ) : (
              <div className="flex flex-col gap-3 sm:flex-row">
                <div className="flex-1">
                  <Select
                    label="Pipeline"
                    value={pipelineId ?? ""}
                    disabled={pipelinesLoading}
                    options={[
                      { value: "", label: "Select a pipeline", disabled: true },
                      ...pipelines.map((p) => ({ value: p.id, label: p.name })),
                    ]}
                    onChange={(e) => {
                      const next = e.target.value || null;
                      setPipelineId(next);
                      setStageId(null);
                      setStageName(null);
                    }}
                  />
                </div>
                <div className="flex-1">
                  <Select
                    label="Stage"
                    value={stageId ?? ""}
                    disabled={!pipelineId}
                    options={[
                      { value: "", label: "Select a stage", disabled: true },
                      ...(selectedPipeline?.stages ?? []).map((s) => ({
                        value: s.id,
                        label: s.name,
                      })),
                    ]}
                    onChange={(e) => {
                      const next = e.target.value || null;
                      setStageId(next);
                      setStageName(
                        selectedPipeline?.stages.find((s) => s.id === next)?.name ?? null,
                      );
                    }}
                  />
                </div>
              </div>
            ))}

          <p className="text-xs text-navy/50">
            Only leads that reach this point after{" "}
            {startFrom ? new Date(startFrom).toLocaleDateString() : "—"} are added. Older ones can
            be imported below.
          </p>

          <Input
            type="date"
            label="Start from"
            value={startFrom ? startFrom.slice(0, 10) : ""}
            onChange={(e) => setStartFrom(e.target.value)}
          />

          <div>
            <Button
              size="sm"
              disabled={!triggerChanged}
              loading={savingConfig}
              onClick={() =>
                onUpdateConfig?.({
                  triggerMode,
                  pipelineId: pipelineId ?? undefined,
                  stageId: stageId ?? undefined,
                  stageName: stageName ?? undefined,
                  startFrom,
                })
              }
            >
              Save
            </Button>
          </div>
        </Card>
      )}

      {/* Card 3 — Options */}
      {status === "CONNECTED" && config && (
        <Card className="flex flex-col gap-4">
          <h3 className="text-base font-semibold text-navy">Options</h3>

          <div className="flex items-center justify-between gap-3">
            <div>
              <p className="text-sm font-medium text-navy">Preview mode</p>
              <p className="text-xs text-navy/40">
                Nothing is created yet. Review the list below, then turn this off.
              </p>
            </div>
            <MiniSwitch
              ariaLabel="Preview mode"
              checked={previewMode}
              onToggle={() => {
                const next = !previewMode;
                setPreviewMode(next);
                onUpdateConfig?.({ dryRun: next });
              }}
            />
          </div>

          <div className="flex flex-col gap-3 border-t border-surface-border pt-3">
            <p className="text-sm font-medium text-navy">Write back to GoHighLevel</p>
            <div className="flex items-center justify-between gap-3">
              <span className="text-sm text-navy/70">Add tag routeflow-customer</span>
              <MiniSwitch
                ariaLabel="Add tag routeflow-customer"
                checked={writeBackTag}
                onToggle={() => {
                  const next = !writeBackTag;
                  setWriteBackTag(next);
                  onUpdateConfig?.({ writeBackTag: next });
                }}
              />
            </div>
            <div className="flex items-center justify-between gap-3">
              <span className="text-sm text-navy/70">Fill RouteFlow fields on the contact</span>
              <MiniSwitch
                ariaLabel="Fill RouteFlow fields on the contact"
                checked={writeBackFields}
                onToggle={() => {
                  const next = !writeBackFields;
                  setWriteBackFields(next);
                  onUpdateConfig?.({ writeBackFields: next });
                }}
              />
            </div>
            <div className="flex items-center justify-between gap-3">
              <span className="text-sm text-navy/70">Add a note with the customer link</span>
              <MiniSwitch
                ariaLabel="Add a note with the customer link"
                checked={writeBackNote}
                onToggle={() => {
                  const next = !writeBackNote;
                  setWriteBackNote(next);
                  onUpdateConfig?.({ writeBackNote: next });
                }}
              />
            </div>
            <div className="flex items-center justify-between gap-3">
              <div>
                <span className="text-sm text-navy/70">Mark the lead as Won</span>
                <p className="text-xs text-navy/40">
                  Requires the Opportunities write permission on the key
                </p>
              </div>
              <MiniSwitch
                ariaLabel="Mark the lead as Won"
                checked={markWon}
                onToggle={() => {
                  const next = !markWon;
                  setMarkWon(next);
                  onUpdateConfig?.({ markWon: next });
                }}
              />
            </div>
          </div>

          <div className="flex items-center justify-between gap-3 border-t border-surface-border pt-3">
            <div>
              <span className="text-sm font-medium text-navy">Enabled</span>
              <p className="text-xs text-navy/40">Create customers automatically</p>
            </div>
            <MiniSwitch
              ariaLabel="Enabled"
              checked={enabled}
              disabled={config.triggerMode === "STAGE" && !config.stageId}
              onToggle={() => {
                const next = !enabled;
                setEnabled(next);
                onUpdateConfig?.({ enabled: next });
              }}
            />
          </div>
          {config.triggerMode === "STAGE" && !config.stageId && (
            <p className="text-xs text-navy/40">Choose a stage first</p>
          )}
          {savingConfig && <p className="text-xs text-navy/40">Saving…</p>}
        </Card>
      )}

      {/* Card 4 — Activity */}
      <Card className="flex flex-col gap-4">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h3 className="text-base font-semibold text-navy">Activity</h3>
          <Button
            variant="secondary"
            size="sm"
            loading={checkingNow}
            onClick={() => onCheckNow?.()}
          >
            Check now
          </Button>
        </div>

        {previewMode && (
          <div className="rounded-ctl bg-brand-50 px-3 py-2 text-sm text-brand-700">
            Preview mode is on — customers are not created.
          </div>
        )}

        <div className="flex flex-wrap gap-2">
          {FILTERS.map((f) => (
            <button
              key={f.key}
              type="button"
              onClick={() => setFilter(f.key)}
              className={cn(
                "rounded-full border px-3 py-1 text-xs font-medium transition-colors",
                filter === f.key
                  ? "border-brand-500 bg-brand-50 text-brand-700"
                  : "border-surface-border text-navy/60 hover:bg-surface-raised",
              )}
            >
              {f.label}
            </button>
          ))}
        </div>

        {activityError ? (
          <div className="flex items-center gap-2 py-6 text-sm text-danger">
            <span>Couldn&apos;t load activity.</span>
            <button
              type="button"
              className="font-medium underline"
              onClick={() => onRetryActivity?.()}
            >
              Retry
            </button>
          </div>
        ) : !activityLoading && filteredActivity.length === 0 ? (
          <p className="py-6 text-center text-sm text-navy/50">{emptyActivityCopy}</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-left text-sm">
              <caption className="sr-only">GoHighLevel activity</caption>
              <thead>
                <tr className="border-b border-surface-border text-xs uppercase text-navy/40">
                  <th className="py-2 pr-3 font-medium">Lead</th>
                  <th className="py-2 pr-3 font-medium">Contact</th>
                  <th className="py-2 pr-3 font-medium">Result</th>
                  <th className="py-2 pr-3 font-medium">Details</th>
                  <th className="py-2 pr-3 font-medium">When</th>
                  <th className="py-2 pr-3 font-medium">Actions</th>
                </tr>
              </thead>
              <tbody>
                {activityLoading ? (
                  <SkeletonRows rows={3} columns={ACTIVITY_SKELETON_COLUMNS} />
                ) : (
                  filteredActivity.map((row) => {
                    const badgeInfo = ACTIVITY_BADGE[row.status] ?? {
                      label: row.status,
                      variant: "neutral" as BadgeVariant,
                    };
                    const canRetry = [
                      "DRY_RUN",
                      "NEEDS_REVIEW",
                      "FAILED",
                      "WRITEBACK_PENDING",
                    ].includes(row.status);
                    const canDismiss = ["NEEDS_REVIEW", "FAILED", "DRY_RUN"].includes(row.status);
                    return (
                      <tr key={row.id} className="border-b border-surface-border last:border-0">
                        <td className="py-2 pr-3">{row.opportunityName ?? "—"}</td>
                        <td className="py-2 pr-3">{row.contactName ?? "—"}</td>
                        <td className="py-2 pr-3">
                          <Badge variant={badgeInfo.variant} label={badgeInfo.label} />
                        </td>
                        <td className="py-2 pr-3 text-navy/70">{detailsText(row)}</td>
                        <td className="py-2 pr-3 text-navy/50">{timeAgo(row.createdAt)}</td>
                        <td className="py-2 pr-3">
                          <div className="flex items-center gap-2">
                            {row.customerId && (
                              <a
                                href={`/customers/${row.customerId}`}
                                className="text-xs font-medium text-brand-600 hover:text-brand-700"
                              >
                                Open customer{row.contactName ? ` ${row.contactName}` : ""}
                              </a>
                            )}
                            {canRetry && (
                              <button
                                type="button"
                                className="text-xs font-medium text-brand-600 hover:text-brand-700"
                                onClick={() => onRetry?.(row.id)}
                              >
                                Retry
                              </button>
                            )}
                            {canDismiss && (
                              <button
                                type="button"
                                className="text-xs font-medium text-navy/50 hover:text-navy"
                                onClick={() => onDismiss?.(row.id)}
                              >
                                Dismiss
                              </button>
                            )}
                          </div>
                        </td>
                      </tr>
                    );
                  })
                )}
              </tbody>
            </table>
            {!activityLoading && hasMoreActivity && (
              <div className="flex justify-center pt-3">
                <Button variant="secondary" size="sm" onClick={() => onLoadMoreActivity?.()}>
                  Load more
                </Button>
              </div>
            )}
          </div>
        )}
      </Card>

      {/* Import existing leads */}
      <Card className="flex flex-col gap-3">
        <h3 className="text-base font-semibold text-navy">Import existing leads</h3>
        <p className="text-sm text-navy/60">
          Bring in leads that already reached the configured stage before you connected.
        </p>
        <div>
          <Button
            variant="secondary"
            size="sm"
            loading={previewLoading}
            onClick={() => onPreviewImport?.()}
          >
            Preview existing leads
          </Button>
        </div>

        {previewResult &&
          (previewResult.count === 0 ? (
            <p className="text-sm text-navy/50">Nothing to import.</p>
          ) : (
            <div className="flex flex-col gap-2 border-t border-surface-border pt-3">
              <p className="text-sm text-navy/70">
                {previewResult.count} leads are already at{" "}
                {config?.stageName ?? "the configured stage"} and not in RouteFlow
              </p>
              <ul className="flex flex-col gap-1 text-sm text-navy/60">
                {previewResult.sample.slice(0, 20).map((s, i) => (
                  <li key={i}>
                    {s.opportunityName ?? "—"} · {s.contactName ?? "—"} · {s.email ?? "—"} ·{" "}
                    {s.phone ?? "—"}
                  </li>
                ))}
              </ul>
              <div>
                <Button size="sm" loading={importing} onClick={() => setConfirmImport(true)}>
                  {previewMode ? "Preview these" : "Import these"}
                </Button>
              </div>
            </div>
          ))}

        <ConfirmDialog
          open={confirmImport}
          onClose={() => setConfirmImport(false)}
          onConfirm={() => {
            onImportExisting?.();
            setConfirmImport(false);
          }}
          title={previewMode ? "Preview these leads?" : "Import these leads?"}
          description={
            previewMode
              ? "This previews the matching leads without creating any customers."
              : "This creates RouteFlow customers for the matching leads now."
          }
          confirmLabel={previewMode ? "Preview these" : "Import these"}
          variant="secondary"
          loading={importing}
        />
      </Card>
    </div>
  );
}

// ─── Container — real data via crm.ts hooks ────────────────────────────────────

// `POST /crm/gohighlevel/connection/test` (crm-connection.service.ts `testConnection`) really
// returns `{ok, locationName?, reason?, connection}` — `useTestCrmConnection` in lib/api/crm.ts
// types its mutation result as `CrmStatusResponse` (`{connection, counts}`, the GET /crm/gohighlevel
// shape), which has no `ok`/`reason`/`locationName`. That mistyped hook lives outside this file's
// edit scope, so the real response is cast to its actual shape at the one call site that needs it.
interface CrmTestConnectionResult {
  ok: boolean;
  locationName?: string;
  reason?: string;
  connection: { status?: string; locationName?: string | null } | null;
}

// #4 — the raw CrmAuthError message ("GoHighLevel rejected the token") is translated to the
// ux-spec Card 1 copy; any other failure reason is shown as-is.
function connectionFailureText(reason?: string | null): string {
  if (reason === "GoHighLevel rejected the token") {
    return "GoHighLevel rejected this key. Create a new one and paste it here.";
  }
  return reason || "Could not connect to GoHighLevel.";
}

function toActivityRow(h: CrmHandoffRow): CrmActivityRow {
  return {
    id: h.id,
    status: h.status,
    reason: h.reason,
    opportunityName: h.opportunityName ?? undefined,
    contactName: h.contactName ?? undefined,
    matchedBy: h.matchedBy,
    customerId: h.customerId,
    createdAt: h.createdAt,
  };
}

const HANDOFFS_PAGE_LIMIT = 25;

export default function GoHighLevelSettingsTabConnected(): React.ReactElement {
  const { toast } = useToast();
  const { data } = useCrmStatus();
  const connection = data?.connection ?? null;

  const saveConnection = useSaveCrmConnection();
  const testConnection = useTestCrmConnection();
  const disconnect = useDisconnectCrm();
  const updateConfig = useUpdateCrmConfig();
  const syncNow = useSyncCrmNow();
  const previewImport = usePreviewCrmImport();
  const importLeads = useImportExistingCrmLeads();
  const retryHandoff = useRetryHandoff();
  const dismissHandoff = useDismissHandoff();

  const pipelinesQuery = useCrmPipelines({ enabled: connection?.status === "CONNECTED" });

  // #4 — Save & test's real pass/fail signal is the test response's `ok`/`connection.status`,
  // never just whether the two mutations rejected (a rejected key is still an HTTP 200 `{ok:false}`).
  const [connectionFailure, setConnectionFailure] = React.useState<string | null>(null);

  // Handoffs — the API returns the shared-contract envelope `{data, total, page,
  // limit}` (M16); "Load more" pages through it by bumping `page` and appending
  // each successive page's rows to what was already fetched.
  const [handoffsPage, setHandoffsPage] = React.useState(1);
  const handoffsQuery = useCrmHandoffs({ page: handoffsPage, limit: HANDOFFS_PAGE_LIMIT });
  const [accumulatedHandoffs, setAccumulatedHandoffs] = React.useState<CrmHandoffRow[]>([]);
  React.useEffect(() => {
    const result: CrmHandoffsResult | undefined = handoffsQuery.data;
    if (!result) return;
    setAccumulatedHandoffs((prev) =>
      handoffsPage === 1 ? result.data : [...prev, ...result.data],
    );
  }, [handoffsQuery.data, handoffsPage]);
  const hasMoreActivity = handoffsQuery.data
    ? handoffsPage * handoffsQuery.data.limit < handoffsQuery.data.total
    : false;

  return (
    <GoHighLevelSettingsTab
      status={connection?.status ?? null}
      locationName={connection?.locationName ?? null}
      dryRun={connection?.dryRun ?? true}
      tokenLast4={connection?.tokenLast4 ?? null}
      config={
        connection
          ? {
              triggerMode: connection.triggerMode,
              pipelineId: connection.pipelineId,
              stageId: connection.stageId,
              stageName: connection.stageName,
              startFrom: connection.startFrom,
              writeBackFields: connection.writeBackFields,
              writeBackTag: connection.writeBackTag,
              writeBackNote: connection.writeBackNote,
              markWon: connection.markWon,
              enabled: connection.enabled,
            }
          : null
      }
      activity={accumulatedHandoffs.map(toActivityRow)}
      activityLoading={handoffsQuery.isLoading}
      activityError={handoffsQuery.isError}
      onRetryActivity={() => handoffsQuery.refetch()}
      hasMoreActivity={hasMoreActivity}
      onLoadMoreActivity={() => setHandoffsPage((p) => p + 1)}
      savingConnection={saveConnection.isPending || testConnection.isPending}
      connectionError={connectionFailure}
      onSaveConnection={({ token, locationId }) => {
        setConnectionFailure(null);
        saveConnection.mutate(
          { token, locationId },
          {
            onSuccess: () => {
              testConnection.mutate(undefined, {
                onSuccess: (res) => {
                  const result = res as unknown as CrmTestConnectionResult;
                  if (result.ok && result.connection?.status === "CONNECTED") {
                    setConnectionFailure(null);
                    toast({
                      title: `Connected to ${result.locationName ?? result.connection?.locationName ?? "GoHighLevel"}`,
                      variant: "success",
                    });
                  } else {
                    setConnectionFailure(connectionFailureText(result.reason));
                  }
                },
                onError: () => setConnectionFailure(connectionFailureText(undefined)),
              });
            },
            onError: () => setConnectionFailure(connectionFailureText(undefined)),
          },
        );
      }}
      disconnecting={disconnect.isPending}
      onDisconnect={() =>
        disconnect.mutate(undefined, {
          onSuccess: () => toast({ title: "GoHighLevel disconnected", variant: "success" }),
        })
      }
      savingConfig={updateConfig.isPending}
      onUpdateConfig={(patch) =>
        updateConfig.mutate(patch, {
          onSuccess: () => toast({ title: "Saved", variant: "success" }),
          onError: () => toast({ title: "Couldn't save", variant: "error" }),
        })
      }
      checkingNow={syncNow.isPending}
      onCheckNow={() =>
        syncNow.mutate(undefined, {
          onSuccess: (counts) =>
            toast({
              title: `Checked GoHighLevel: ${counts.new} new, ${counts.created} created, ${counts.linked} linked, ${counts.needsReview} need review`,
              variant: "success",
            }),
          onError: () => toast({ title: "Couldn't check GoHighLevel", variant: "error" }),
        })
      }
      onRetry={(id) =>
        retryHandoff.mutate(id, {
          onError: () => toast({ title: "Couldn't retry", variant: "error" }),
        })
      }
      onDismiss={(id) =>
        dismissHandoff.mutate(id, {
          onError: () => toast({ title: "Couldn't dismiss", variant: "error" }),
        })
      }
      testingAgain={testConnection.isPending}
      onTestAgain={() =>
        testConnection.mutate(undefined, {
          onSuccess: (res) => {
            if (res.connection?.status === "CONNECTED") {
              toast({
                title: `Connected to ${res.connection?.locationName ?? "GoHighLevel"}`,
                variant: "success",
              });
            }
          },
          onError: () => toast({ title: "Could not connect to GoHighLevel", variant: "error" }),
        })
      }
      pipelines={pipelinesQuery.data ?? []}
      pipelinesLoading={pipelinesQuery.isLoading}
      pipelinesError={pipelinesQuery.isError}
      onRetryPipelines={() => pipelinesQuery.refetch()}
      previewLoading={previewImport.isPending}
      previewResult={previewImport.data ?? null}
      onPreviewImport={() =>
        previewImport.mutate(undefined, {
          onError: () => toast({ title: "Couldn't preview leads", variant: "error" }),
        })
      }
      importing={importLeads.isPending}
      onImportExisting={() =>
        importLeads.mutate(undefined, {
          onSuccess: (counts) =>
            toast({
              title: `Imported: ${counts.created} created, ${counts.linked} linked, ${counts.needsReview} need review`,
              variant: "success",
            }),
          onError: () => toast({ title: "Couldn't import leads", variant: "error" }),
        })
      }
    />
  );
}
