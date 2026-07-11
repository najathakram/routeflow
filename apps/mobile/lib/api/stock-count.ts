import { useMutation, useQueryClient } from "@tanstack/react-query";
import { apiClient } from "../api-client";
import type { CommitStockCountItem } from "../stock-count-logic";

// Mirrors apps/web/lib/api/stock-count.ts — a single atomic commit; there is no
// server-side session model (the sessionId only groups the movements' reference).

export interface CommitStockCountPayload {
  sessionId: string;
  items: CommitStockCountItem[];
  notes?: string;
  effectiveDate?: string;
}

export interface CommitStockCountResponse {
  sessionId: string;
  reference: string;
  applied: number;
  skipped: number;
  movementIds: string[];
}

export function useCommitStockCount() {
  const qc = useQueryClient();
  return useMutation<CommitStockCountResponse, Error, CommitStockCountPayload>({
    mutationFn: (data) => apiClient.post("/inventory/stock-count/commit", data).then((r) => r.data),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["inventory"] });
      qc.invalidateQueries({ queryKey: ["products"] });
      qc.invalidateQueries({ queryKey: ["admin", "products"] });
    },
  });
}
