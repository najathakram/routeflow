"use client";

import * as React from "react";
import Link from "next/link";
import { ChevronRight, Search as SearchIcon } from "lucide-react";
import { Button, Card, Input, cn } from "@routeflow/ui/web";
import { BusinessCard } from "./BusinessCard";
import { CHIPS, GROUP_META, GROUP_TITLES, ROW_ICONS, type GroupMeta } from "./settings-groups";
import {
  listGroup,
  normalize,
  searchSettings,
  splitHighlight,
  type IndexEntry,
} from "./settings-index";
import type { SettingsNav } from "./use-settings-nav";

const HEADING =
  "px-3 pb-1.5 text-xs font-semibold uppercase tracking-[0.06em] text-[var(--ink-500)]";
const INSET =
  "overflow-hidden rounded-[var(--r-card)] border border-[var(--line)] bg-[var(--paper)] shadow-[var(--sh-card)]";
const PRESS =
  "transition-colors [transition-duration:120ms] motion-reduce:transition-none hover:bg-[var(--sunken)] active:bg-[var(--sunken)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-primary";

/** `/` jumps to search unless the user is typing somewhere. */
function useSlashFocus(ref: React.RefObject<HTMLInputElement | null>) {
  React.useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      const typing = t && (/^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName) || t.isContentEditable);
      if (e.key !== "/" || typing || e.metaKey || e.ctrlKey || e.altKey) return;
      e.preventDefault();
      ref.current?.focus();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [ref]);
}

function Row({ entry, group, value }: { entry: IndexEntry; group: GroupMeta; value?: string }) {
  const Icon = ROW_ICONS[entry.id] ?? group.icon;
  return (
    <li className="relative after:absolute after:bottom-0 after:left-[3.25rem] after:right-0 after:h-px after:bg-[var(--line)] last:after:hidden">
      <Link
        href={entry.href!}
        data-testid={`settings-row-${entry.id}`}
        className={cn("flex min-h-[52px] items-center gap-3 px-3.5 py-2", PRESS)}
      >
        <span
          aria-hidden="true"
          className="flex h-7 w-7 flex-none items-center justify-center rounded-[7px] bg-[var(--accent-soft)] text-[var(--accent)]"
        >
          <Icon className="h-4 w-4" />
        </span>
        <span className="min-w-0 flex-1">
          <span className="block truncate text-[15px] font-medium leading-5 text-[var(--ink-900)]">
            {entry.label}
          </span>
          <span className="block truncate text-[13px] leading-[18px] text-[var(--ink-500)]">
            {entry.desc}
          </span>
        </span>
        {value && (
          <span
            data-testid="row-value"
            className="max-w-[40%] flex-none truncate text-sm tabular-nums text-[var(--ink-500)]"
          >
            {value}
          </span>
        )}
        <ChevronRight aria-hidden="true" className="h-4 w-4 flex-none text-[var(--ink-400)]" />
      </Link>
    </li>
  );
}

function ResultRow({
  entry,
  query,
  linkRef,
}: {
  entry: IndexEntry;
  query: string;
  linkRef?: React.ComponentProps<typeof Link>["ref"];
}) {
  const body = (
    <span className="min-w-0 flex-1">
      <span className="block text-[15px] font-medium leading-5 text-[var(--ink-900)]">
        {splitHighlight(entry.label, query).map((p, i) =>
          p.hit ? (
            <strong
              key={i}
              className="rounded-sm bg-[var(--accent-soft)] font-semibold text-[var(--accent-strong)]"
            >
              {p.text}
            </strong>
          ) : (
            <React.Fragment key={i}>{p.text}</React.Fragment>
          ),
        )}
      </span>
      {entry.kind === "info" && (
        <span className="block text-[13px] leading-[18px] text-[var(--ink-700)]">
          {entry.answer}
        </span>
      )}
      <span className="block text-[13px] leading-[18px] text-[var(--ink-500)]">
        {`${GROUP_TITLES[entry.groupKey]} › ${entry.page ?? entry.label}`}
      </span>
    </span>
  );
  const cls = "flex min-h-[52px] items-center gap-3 px-3.5 py-2";
  return (
    <li className="border-b border-[var(--line)] last:border-b-0">
      {entry.href ? (
        <Link ref={linkRef} href={entry.href} className={cn(cls, PRESS)}>
          {body}
          <ChevronRight aria-hidden="true" className="h-4 w-4 flex-none text-[var(--ink-400)]" />
        </Link>
      ) : (
        <div className={cls}>{body}</div>
      )}
    </li>
  );
}

/**
 * Search, your business, what needs attention, frequent links and the groups. Typing swaps the groups for
 * one flat result list; Enter opens the first link.
 */
export function SettingsFinder({
  nav,
  query,
  onQuery,
  afterCard,
}: {
  nav: SettingsNav;
  query: string;
  onQuery: (q: string) => void;
  /** Shown under the Business card while not searching (the "Needs attention" list). */
  afterCard?: React.ReactNode;
}) {
  const inputRef = React.useRef<HTMLInputElement>(null);
  const firstRef = React.useRef<HTMLAnchorElement>(null);
  useSlashFocus(inputRef);
  const searching = normalize(query) !== "";
  const results = React.useMemo(
    () => (searching ? searchSettings(query, nav.entries) : []),
    [searching, query, nav.entries],
  );
  const firstLinked = results.find((r) => r.href);
  const groups = GROUP_META.map((g) => ({
    g,
    rows: listGroup(nav.entries, g.key, { fleet: nav.fleet, counter: nav.counter }),
  })).filter((x) => x.rows.length > 0);

  return (
    <div className="space-y-4">
      <div className="sticky top-0 z-10 -mx-1 bg-[var(--canvas)] px-1 pb-1 pt-1">
        <div className="relative">
          <SearchIcon className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-[var(--ink-400)]" />
          <Input
            ref={inputRef}
            value={query}
            onChange={(e) => onQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                firstRef.current?.click();
              }
            }}
            placeholder="Search settings…"
            className="pl-9"
            aria-label="Search settings"
          />
        </div>
      </div>

      {searching && results.length === 0 && (
        <Card className="space-y-3 text-sm text-[var(--ink-500)]">
          <p>No settings match “{query.trim()}”.</p>
          <p>Try another word, or browse all settings.</p>
          <p>Try: counter, carrier, backorder, time zone</p>
          <Button
            variant="secondary"
            size="sm"
            onClick={() => {
              onQuery("");
              inputRef.current?.focus();
            }}
          >
            Clear Search
          </Button>
        </Card>
      )}

      {searching && results.length > 0 && (
        <ul aria-label="Search results" className={INSET}>
          {results.map((r) => (
            <ResultRow
              key={r.id}
              entry={r}
              query={query}
              linkRef={r === firstLinked ? firstRef : undefined}
            />
          ))}
        </ul>
      )}

      {!searching && (
        <>
          <BusinessCard />
          {afterCard}
          <div className="flex flex-wrap items-center gap-2 text-xs text-[var(--ink-500)]">
            <span>Frequently used:</span>
            {CHIPS.map((c) => (
              <Link
                key={c.href + c.label}
                href={c.href}
                className={cn(
                  "rounded-full border border-[var(--line)] bg-[var(--paper)] px-3 py-1 font-medium text-[var(--accent-strong)]",
                  PRESS,
                )}
              >
                {c.label}
              </Link>
            ))}
          </div>
          {groups.map(({ g, rows }) => (
            <section key={g.key} data-testid={`settings-group-${g.key}`}>
              <h3 className={HEADING}>{g.title}</h3>
              <ul className={INSET}>
                {rows.map((e) => (
                  <Row key={e.id} entry={e} group={g} value={nav.trailing[e.id]} />
                ))}
              </ul>
            </section>
          ))}
        </>
      )}
    </div>
  );
}
