import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { apiClient } from "../api-client";

/**
 * Seller remit-to / how-to-pay info shown to buyers (P5-14). Stored as ONE JSON
 * document in SystemConfig under `remittance.config` (no migration); PATCH is
 * admin-only server-side. Buyer-visible by design (same data printed on an invoice).
 */
export interface RemittanceConfig {
  payToName?: string;
  bankName?: string;
  accountName?: string;
  accountNumber?: string;
  routingNumber?: string;
  achInstructions?: string;
  wireInstructions?: string;
  checkInstructions?: string;
  mailingAddress?: string;
  notes?: string;
}

export function useRemittanceConfig() {
  return useQuery<RemittanceConfig>({
    queryKey: ["remittance-config"],
    queryFn: () => apiClient.get("/settings/remittance").then((r) => r.data),
    staleTime: 5 * 60_000,
  });
}

export function useUpdateRemittanceConfig() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (dto: Partial<RemittanceConfig>) =>
      apiClient.patch("/settings/remittance", dto).then((r) => r.data),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["remittance-config"] }),
  });
}
