"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { Modal, Button, Select } from "@routeflow/ui/web";
import { apiClient } from "@/lib/api-client";
import { useSalesAgents, useGenerateStatement } from "@/lib/api/sales-agents";

/**
 * PR-D WP6 — generate a commission statement for an agent, optionally scoped
 * to a period. Only ever mounted inside the addon-gated commissions list page,
 * so the agent-list query is gated on `open` rather than re-checking the addon
 * here (a closed modal fires zero requests either way).
 */
export function GenerateStatementModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  const router = useRouter();
  const { data: agents } = useSalesAgents(undefined, { enabled: open });
  const generate = useGenerateStatement();

  const [agentId, setAgentId] = React.useState("");
  const [periodFrom, setPeriodFrom] = React.useState("");
  const [periodTo, setPeriodTo] = React.useState("");

  React.useEffect(() => {
    if (open) {
      setAgentId("");
      setPeriodFrom("");
      setPeriodTo("");
    }
  }, [open]);

  const handleClose = () => {
    if (generate.isPending) return;
    onClose();
  };

  const handleSubmit = () => {
    if (!agentId) return;
    const dto = {
      agentId,
      periodFrom: periodFrom || undefined,
      periodTo: periodTo || undefined,
    };
    generate.mutate(dto, {
      onSuccess: (stmt) => router.push(`/finance/commissions/${stmt.id}`),
      onError: async (err) => {
        const res = (err as any)?.response;
        // 409 = this agent already has a PENDING statement (service:88-92). The id
        // isn't in the body — fetch it and route there. The global toast already
        // showed the server message; this adds the useful next step. The lookup is
        // best-effort: if it fails (network drop, addon toggled off mid-session) or
        // the PENDING statement was voided in between, stay on the modal — throwing
        // here would escape the callback as an unhandled rejection.
        if (res?.status === 409) {
          try {
            const { data } = await apiClient.get("/commission-statements", {
              params: { agentId: dto.agentId, status: "PENDING" },
            });
            if (data?.[0]?.id) router.push(`/finance/commissions/${data[0].id}`);
          } catch {
            // Nothing more to say — the 409 toast already carries the server message.
          }
        }
        // 400 "Nothing to generate" needs nothing extra — the toast message is exact.
      },
    });
  };

  return (
    <Modal
      open={open}
      onClose={handleClose}
      title="Generate commission statement"
      description="The period narrows which invoices are claimed; adjustments and carryforwards are always swept."
      footer={
        <>
          <Button variant="secondary" onClick={handleClose} disabled={generate.isPending}>
            Cancel
          </Button>
          <Button onClick={handleSubmit} loading={generate.isPending} disabled={!agentId}>
            Generate
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <Select
          label="Agent"
          value={agentId}
          onChange={(e) => setAgentId(e.target.value)}
          placeholder="Select an agent"
          options={(agents ?? []).map((a) => ({ value: a.id, label: a.name }))}
        />
        <div className="grid grid-cols-2 gap-3">
          <div className="flex flex-col gap-1">
            <label className="text-sm font-medium text-navy" htmlFor="generate-period-from">
              Period from (optional)
            </label>
            <input
              id="generate-period-from"
              type="date"
              value={periodFrom}
              max={periodTo || undefined}
              onChange={(e) => setPeriodFrom(e.target.value)}
              className="h-10 w-full rounded border border-surface-border bg-white px-3 text-sm text-navy focus:outline-none focus:ring-2 focus:ring-brand-500"
            />
          </div>
          <div className="flex flex-col gap-1">
            <label className="text-sm font-medium text-navy" htmlFor="generate-period-to">
              Period to (optional)
            </label>
            <input
              id="generate-period-to"
              type="date"
              value={periodTo}
              min={periodFrom || undefined}
              onChange={(e) => setPeriodTo(e.target.value)}
              className="h-10 w-full rounded border border-surface-border bg-white px-3 text-sm text-navy focus:outline-none focus:ring-2 focus:ring-brand-500"
            />
          </div>
        </div>
      </div>
    </Modal>
  );
}
