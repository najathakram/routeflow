"use client";

import * as React from "react";
import { Modal, Input, Textarea, Button, useToast } from "@routeflow/ui/web";
import { DecimalInput } from "@/components/MoneyInput";
import { todayIso } from "@/lib/formatting";
import { useCreateSalesAgent } from "@/lib/api/sales-agents";

export interface AgentFormModalProps {
  isOpen: boolean;
  onClose: () => void;
  /** Fired after a successful create, with the new agent's id. */
  onCreated: (id: string) => void;
}

/**
 * "Add agent" modal for the /sales-agents list page — create only (contact
 * fields are edited inline on the detail page's Contact card instead). Name
 * is required; email/phone/notes and an optional first default rate (with
 * its own effective-from, defaulting today) are all optional. `POST
 * /sales-agents` creates the agent and, when a rate is given, its first
 * SalesAgentRate row in the same call (sales-agents.service.ts `create`).
 */
export function AgentFormModal({ isOpen, onClose, onCreated }: AgentFormModalProps) {
  const { toast } = useToast();
  const createAgent = useCreateSalesAgent();

  const [name, setName] = React.useState("");
  const [email, setEmail] = React.useState("");
  const [phone, setPhone] = React.useState("");
  const [notes, setNotes] = React.useState("");
  const [defaultRatePct, setDefaultRatePct] = React.useState<number | null>(null);
  const [rateEffectiveFrom, setRateEffectiveFrom] = React.useState(todayIso());
  const [error, setError] = React.useState("");

  // Fresh form every time the modal opens.
  React.useEffect(() => {
    if (!isOpen) return;
    setName("");
    setEmail("");
    setPhone("");
    setNotes("");
    setDefaultRatePct(null);
    setRateEffectiveFrom(todayIso());
    setError("");
  }, [isOpen]);

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!name.trim()) {
      setError("Name is required.");
      return;
    }
    setError("");
    createAgent.mutate(
      {
        name: name.trim(),
        email: email.trim() || undefined,
        phone: phone.trim() || undefined,
        notes: notes.trim() || undefined,
        ...(defaultRatePct != null
          ? { defaultRatePct, rateEffectiveFrom: rateEffectiveFrom || undefined }
          : {}),
      },
      {
        onSuccess: (agent) => {
          toast({ title: "Agent created", variant: "success" });
          onClose();
          onCreated(agent.id);
        },
        onError: (err) => {
          const msg = (err as { response?: { data?: { message?: string | string[] } } })?.response
            ?.data?.message;
          setError((Array.isArray(msg) ? msg[0] : msg) || "Could not create the agent.");
        },
      },
    );
  };

  return (
    <Modal
      open={isOpen}
      onClose={onClose}
      title="Add Sales Agent"
      description="Create an agent to attribute customers and commissions to."
      footer={
        <>
          <Button
            variant="secondary"
            type="button"
            onClick={onClose}
            disabled={createAgent.isPending}
          >
            Cancel
          </Button>
          <Button type="submit" form="agent-form" loading={createAgent.isPending}>
            Create
          </Button>
        </>
      }
    >
      <form id="agent-form" onSubmit={handleSubmit} noValidate className="space-y-4">
        <Input
          label="Name"
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="Jane Doe"
        />
        <div className="grid grid-cols-2 gap-3">
          <Input
            label="Email (optional)"
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
          />
          <Input
            label="Phone (optional)"
            value={phone}
            onChange={(e) => setPhone(e.target.value)}
          />
        </div>
        <Textarea
          label="Notes (optional)"
          value={notes}
          onChange={(e) => setNotes(e.target.value)}
          rows={3}
        />
        <div className="grid grid-cols-2 gap-3 rounded-lg border border-dashed border-surface-border p-3">
          <div>
            <label className="mb-1 block text-xs font-medium text-navy/70">
              Default rate % (optional)
            </label>
            <DecimalInput
              value={defaultRatePct}
              onChange={setDefaultRatePct}
              decimals={2}
              min={0}
              max={100}
              className="h-9 w-full rounded border border-surface-border bg-white px-2 text-sm text-navy focus:outline-none focus:ring-2 focus:ring-brand-500"
            />
          </div>
          <div>
            <label className="mb-1 block text-xs font-medium text-navy/70">Effective from</label>
            <input
              type="date"
              value={rateEffectiveFrom}
              onChange={(e) => setRateEffectiveFrom(e.target.value)}
              disabled={defaultRatePct == null}
              className="h-9 w-full rounded border border-surface-border bg-white px-2 text-sm text-navy focus:outline-none focus:ring-2 focus:ring-brand-500 disabled:opacity-50"
            />
          </div>
        </div>
        {error && <p className="text-xs text-danger">{error}</p>}
      </form>
    </Modal>
  );
}
