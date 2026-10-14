"use client";

import * as React from "react";
import type { RuleDetailDto } from "@routeflow/types";
import { fmtDate } from "@/lib/formatting";

interface Entry {
  key: string;
  at: string;
  text: string;
  detail: string | null;
}

/** Who did what, newest first: the rule's settings revisions and its product add / remove events. */
export function RuleHistory({
  revisions,
  events,
}: {
  revisions: RuleDetailDto["revisions"];
  events: RuleDetailDto["targetEvents"];
}) {
  const entries: Entry[] = [
    ...revisions.map((r) => ({
      key: `rev-${r.revision}`,
      at: r.editedAt,
      text: `${r.revision === 1 ? "Rule created" : "Settings changed"}${r.editedByName ? ` by ${r.editedByName}` : ""}`,
      detail: r.revision === 1 ? null : r.note,
    })),
    ...events.map((e, i) => ({
      key: `evt-${i}-${e.at}`,
      at: e.at,
      text: `${e.count} ${e.kind === "ADDED" ? "added" : "removed"}${e.byName ? ` by ${e.byName}` : ""}`,
      detail: e.kind === "REMOVED" ? e.reason : null,
    })),
  ].sort((a, b) => new Date(b.at).getTime() - new Date(a.at).getTime());

  if (entries.length === 0) return null;
  return (
    <section className="space-y-2">
      <h2 className="text-sm font-semibold text-navy">History</h2>
      <ul aria-label="History" className="space-y-2">
        {entries.map((e) => (
          <li key={e.key} className="text-sm text-navy/80">
            <p>
              {e.text} <span className="text-navy/60">· {fmtDate(e.at)}</span>
            </p>
            {e.detail && <p className="break-words text-navy/60">{e.detail}</p>}
          </li>
        ))}
      </ul>
    </section>
  );
}
