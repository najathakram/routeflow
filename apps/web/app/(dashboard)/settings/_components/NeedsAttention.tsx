"use client";

import * as React from "react";
import Link from "next/link";
import { ChevronRight } from "lucide-react";
import { useRemittanceConfig } from "@/lib/api/remittance";
import { useStripeConnectStatus } from "@/lib/api/stripe-connect";
import { useUnknownStateBuckets } from "@/lib/api/unknown-state";
import { useBusinessStatus } from "./BusinessCard";
import { attentionItems } from "./settings-values";

/**
 * The 1440 hub's short "what to do next" list: customers without a state (admins and operators), then payment due,
 * no "how to pay" yet, Stripe not connected (admins only). Renders nothing at all (no heading) when there is nothing
 * to do or a read has not answered.
 */
export function NeedsAttention({ isAdmin }: { isAdmin: boolean }) {
  // The billing/payment reads are admin-only: an operator never mounts them (no fetch, nothing discarded).
  return isAdmin ? <AdminAttention /> : <OperatorAttention />;
}

/** Operators fix customer states too (owner ruling), so they get that one row and only its read. */
function OperatorAttention() {
  const unknown = useUnknownStateBuckets();
  return (
    <AttentionList
      items={attentionItems({ isAdmin: false, status: null, unknownState: unknown.data })}
    />
  );
}

function AdminAttention() {
  const status = useBusinessStatus();
  const remittance = useRemittanceConfig();
  const stripe = useStripeConnectStatus();
  const unknown = useUnknownStateBuckets();
  const items = attentionItems({
    isAdmin: true,
    status,
    remittance: remittance.data,
    stripe: stripe.data,
    unknownState: unknown.data,
  });
  return <AttentionList items={items} />;
}

function AttentionList({ items }: { items: ReturnType<typeof attentionItems> }) {
  if (items.length === 0) return null;
  return (
    <section>
      <h3 className="px-3 pb-1.5 text-xs font-semibold uppercase tracking-[0.06em] text-[var(--ink-500)]">
        Needs attention
      </h3>
      <ul
        aria-label="Needs attention"
        className="overflow-hidden rounded-[var(--r-card)] border border-[var(--line)] bg-[var(--paper)] shadow-[var(--sh-card)]"
      >
        {items.map((i) => (
          <li key={i.id} className="border-b border-[var(--line)] last:border-b-0">
            <Link
              href={i.href}
              className="flex min-h-[52px] items-center justify-between gap-3 px-4 py-2 text-[15px] font-medium text-[var(--ink-900)] transition-colors [transition-duration:120ms] hover:bg-[var(--sunken)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-primary motion-reduce:transition-none"
            >
              {i.label}
              <ChevronRight
                aria-hidden="true"
                className="h-4 w-4 flex-none text-[var(--ink-400)]"
              />
            </Link>
          </li>
        ))}
      </ul>
    </section>
  );
}
