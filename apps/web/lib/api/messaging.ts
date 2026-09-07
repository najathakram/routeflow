import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { apiClient } from "../api-client";

/**
 * Settings → Notifications: event×channel rules matrix, editable message
 * templates, quiet hours, and the MSGS meter readout (P6-6). Mirrors the
 * shapes returned by `MessagingConfigService.getMatrix()` (api).
 */
export type MessageChannel = "INTERNAL" | "WHATSAPP" | "SMS" | "EMAIL" | "PORTAL";

export type WaApprovalStatus = "NONE" | "PENDING" | "APPROVED" | "REJECTED";

export interface MessageTemplateInfo {
  id: string;
  body: string;
  variables: string[];
  waTemplateName: string | null;
  waApprovalStatus: WaApprovalStatus;
  isActive: boolean;
}

export interface MatrixCell {
  channel: MessageChannel;
  enabled: boolean;
  ruleId: string | null;
  locked: boolean;
  /** Set when this cell can never fire (no transport, no consent writer, or no firing
   * site yet) — mirrors `MatrixCell["unavailable"]` on the api's `MessagingConfigService`.
   * Renders as a qualifier instead of a live switch (REG-B180). */
  unavailable?: "NO_TRANSPORT" | "NO_CONSENT_WRITER" | "NO_TRIGGER";
  template: MessageTemplateInfo | null;
}

export interface MatrixEvent {
  eventKey: string;
  label: string;
  channels: MatrixCell[];
}

export interface MessagingSettings {
  quietHoursEnabled: boolean;
  quietHoursStart: string;
  quietHoursEnd: string;
  timezone: string | null;
}

export interface MsgsMeter {
  used: number;
  included: number | null;
  remaining: number | null;
  resetsAt: string | null;
}

export interface MessagingConfig {
  events: MatrixEvent[];
  settings: MessagingSettings;
  msgsMeter: MsgsMeter | null;
}

export function useMessagingConfig() {
  return useQuery<MessagingConfig>({
    queryKey: ["messaging-config"],
    queryFn: () => apiClient.get("/messaging/config").then((r) => r.data),
    staleTime: 60_000,
  });
}

/** Optimistic cell flip: flips the matching rule cell immediately, rolls back
 * on error, and refetches once the mutation settles either way. */
export function useToggleRule() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ ruleId, enabled }: { ruleId: string; enabled: boolean }) =>
      apiClient.patch(`/messaging/rules/${ruleId}`, { enabled }).then((r) => r.data),
    onMutate: async ({ ruleId, enabled }) => {
      await qc.cancelQueries({ queryKey: ["messaging-config"] });
      const previous = qc.getQueryData<MessagingConfig>(["messaging-config"]);
      if (previous) {
        qc.setQueryData<MessagingConfig>(["messaging-config"], {
          ...previous,
          events: previous.events.map((event) => ({
            ...event,
            channels: event.channels.map((cell) =>
              cell.ruleId === ruleId ? { ...cell, enabled } : cell,
            ),
          })),
        });
      }
      return { previous };
    },
    onError: (_err, _vars, context) => {
      if (context?.previous) qc.setQueryData(["messaging-config"], context.previous);
    },
    onSettled: () => qc.invalidateQueries({ queryKey: ["messaging-config"] }),
  });
}

export function useUpdateTemplate() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({
      id,
      dto,
    }: {
      id: string;
      dto: Partial<Pick<MessageTemplateInfo, "body" | "waTemplateName" | "isActive">>;
    }) => apiClient.patch(`/messaging/templates/${id}`, dto).then((r) => r.data),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["messaging-config"] }),
  });
}

export function usePreviewTemplate() {
  return useMutation({
    mutationFn: (dto: { body: string; vars?: Record<string, string | number> }) =>
      apiClient
        .post("/messaging/templates/preview", dto)
        .then((r) => r.data as { rendered: string; variables: string[] }),
  });
}

export function useUpdateMessagingSettings() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (dto: Partial<MessagingSettings>) =>
      apiClient.patch("/messaging/settings", dto).then((r) => r.data),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["messaging-config"] }),
  });
}

/** Client mirror of the API's `extractVariables` — distinct `{{var}}` names,
 * first-appearance order. Used to live-update the template editor's variable
 * chip row on every keystroke without a round trip. */
export function extractTemplateVars(body: string): string[] {
  const out: string[] = [];
  const re = /\{\{\s*([\w.]+)\s*\}\}/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(body)) !== null) {
    if (!out.includes(m[1])) out.push(m[1]);
  }
  return out;
}
