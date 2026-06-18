import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { apiClient } from "../api-client";

// ─── Types ────────────────────────────────────────────────────────────────────

export interface Message {
  id: string;
  runId: string | null;
  text: string;
  senderId: string;
  senderRole: string;
  createdAt: string;
  sender: {
    id: string;
    username: string;
    role: string;
  };
}

export interface SendMessageDto {
  runId?: string;
  text: string;
}

// ─── Queries ──────────────────────────────────────────────────────────────────

export function useMessages(runId: string) {
  return useQuery<Message[]>({
    queryKey: ["messages", runId],
    queryFn: () => apiClient.get("/messages", { params: { runId } }).then((r) => r.data),
    enabled: !!runId,
    refetchInterval: 10_000, // poll every 10 s for new messages
    staleTime: 5_000,
  });
}

// ─── Mutations ────────────────────────────────────────────────────────────────

export function useSendMessage(runId: string) {
  const qc = useQueryClient();
  return useMutation<Message, Error, SendMessageDto>({
    mutationFn: (dto) => apiClient.post("/messages", dto).then((r) => r.data),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["messages", runId] }),
  });
}
