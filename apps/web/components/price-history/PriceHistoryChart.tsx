"use client";

import * as React from "react";
import { cn } from "@routeflow/ui/web";
import { fmt } from "@/lib/formatting";
import {
  monthLabel,
  NOTE_COPY,
  NOTE_IDS,
  type ChartModel,
  type LineId,
  type RefPoint,
} from "./chart-model";

/**
 * The price-history plot and its three legend toggles (SA-954, mm-ux spec 2026-10-25). Line 1 is this customer's own
 * price (dominant: solid, thick, brand colour, a dot on every sale). Lines 2 and 3 are context: thin, dashed and
 * dotted, one muted colour, so shape tells them apart. Every number is the server's; nothing here converts.
 *
 * One price scale and one time axis cover every non-empty line, whether it is switched on or off, so turning a line
 * off never makes the others jump. A reference line joins only consecutive months (a month under the floor is a gap,
 * never bridged), and a lone month is a marker.
 */
const PAD_X = 4;
const PAD_Y = 6;
const INITIAL_WIDTH = 496;
const PRICE_TYPE_TAG: Record<string, string> = {
  SPECIAL: "Special",
  DISCOUNTED: "Discount",
  MANUAL: "Override",
};

function useChartSize(ref: React.RefObject<HTMLElement | null>) {
  const [w, setW] = React.useState(INITIAL_WIDTH);
  const [tall, setTall] = React.useState(true);
  React.useEffect(() => {
    const el = ref.current;
    if (el && typeof ResizeObserver !== "undefined") {
      const ro = new ResizeObserver((entries) => {
        const cw = entries[0]?.contentRect.width;
        if (cw && cw > 0) setW(Math.round(cw));
      });
      ro.observe(el);
      return () => ro.disconnect();
    }
    return undefined;
  }, [ref]);
  React.useEffect(() => {
    if (typeof window === "undefined" || typeof window.matchMedia !== "function") return undefined;
    const mq = window.matchMedia("(min-width: 640px)");
    const apply = () => setTall(mq.matches);
    apply();
    mq.addEventListener?.("change", apply);
    return () => mq.removeEventListener?.("change", apply);
  }, []);
  return { w, h: tall ? 96 : 80 };
}

const monthIndex = (m: string) => {
  const [y, mo] = m.split("-").map(Number);
  return y! * 12 + (mo ?? 1) - 1;
};

/** Runs of consecutive months: a gap (a month the server withheld) starts a new run. */
function runsOf<P extends { month: string }>(pts: P[]): P[][] {
  const runs: P[][] = [];
  for (const p of pts) {
    const last = runs[runs.length - 1];
    if (last && monthIndex(p.month) - monthIndex(last[last.length - 1]!.month) === 1) last.push(p);
    else runs.push([p]);
  }
  return runs;
}

const visibility = (on: boolean): React.CSSProperties =>
  on
    ? { opacity: 1, visibility: "visible", transition: "opacity 150ms ease-out, visibility 0s" }
    : {
        opacity: 0,
        visibility: "hidden",
        transition: "opacity 150ms ease-in, visibility 0s linear 150ms",
      };

const STROKE = {
  own: { width: 2 },
  like: { width: 1.25, dash: "5 3" },
  conv: { width: 1.25, dash: "0.01 3.5" },
} as const;

function Swatch({ line, className }: { line: LineId; className?: string }) {
  const color = line === "own" ? "text-brand-500" : "text-navy/60";
  return (
    <svg aria-hidden viewBox="0 0 16 8" className={cn("h-2 w-4 shrink-0", color, className)}>
      <line
        x1="1"
        y1="4"
        x2="15"
        y2="4"
        stroke="currentColor"
        strokeWidth={STROKE[line].width}
        strokeLinecap={line === "own" ? "round" : line === "conv" ? "round" : "butt"}
        strokeDasharray={line === "own" ? undefined : STROKE[line].dash}
      />
      {line === "own" && <circle cx="8" cy="4" r="2.2" fill="currentColor" />}
    </svg>
  );
}

function Plot({
  model,
  on,
  anyOn,
}: {
  model: ChartModel;
  on: Record<LineId, boolean>;
  anyOn: boolean;
}) {
  const box = React.useRef<HTMLDivElement>(null);
  const { w, h } = useChartSize(box);
  const drawn = (id: LineId) => model.canDraw[id];
  const all: Array<{ t: number; price: number }> = [
    ...(drawn("own") ? model.own : []),
    ...(drawn("like") ? model.like : []),
    ...(drawn("conv") ? model.conv : []),
  ];
  const ts = all.map((p) => p.t);
  const t0 = Math.min(...ts);
  const t1 = Math.max(...ts);
  const prices = all.map((p) => p.price);
  const lo = Math.min(...prices);
  const hi = Math.max(...prices);
  const range = hi - lo;
  const dlo = lo - range * 0.08;
  const dhi = hi + range * 0.08;
  const x = (t: number) => (t1 === t0 ? w / 2 : PAD_X + ((t - t0) / (t1 - t0)) * (w - 2 * PAD_X));
  const y = (price: number) =>
    range === 0 ? h / 2 : PAD_Y + (1 - (price - dlo) / (dhi - dlo)) * (h - 2 * PAD_Y);
  const pt = (p: { t: number; price: number }) => ({ x: x(p.t), y: y(p.price) });
  const poly = (pts: Array<{ t: number; price: number }>) =>
    pts
      .map(pt)
      .map((p) => `${p.x.toFixed(1)},${p.y.toFixed(1)}`)
      .join(" ");

  const label = [
    on.own && drawn("own") && `this customer, ${model.own.length} sales`,
    on.like && drawn("like") && "other customers' monthly average",
    on.conv && drawn("conv") && "all customers, all units, monthly average",
  ]
    .filter(Boolean)
    .join("; ");

  const refGroup = (id: "like" | "conv", pts: RefPoint[]) => {
    const runs = runsOf(pts);
    const shown = on[id] && drawn(id);
    return (
      <g
        data-testid={id === "like" ? "line-like" : "line-conv"}
        data-on={shown ? "true" : "false"}
        aria-hidden
        className="text-navy/60 motion-reduce:!transition-none"
        style={visibility(shown)}
      >
        {runs.map((run, i) =>
          run.length > 1 ? (
            <polyline
              key={i}
              points={poly(run)}
              fill="none"
              stroke="currentColor"
              strokeWidth={STROKE[id].width}
              strokeDasharray={STROKE[id].dash}
              strokeLinecap={id === "conv" ? "round" : "butt"}
              strokeLinejoin="round"
            />
          ) : id === "like" ? (
            <rect
              key={i}
              data-testid="lone-like"
              x={pt(run[0]!).x - 2.5}
              y={pt(run[0]!).y - 2.5}
              width="5"
              height="5"
              fill="white"
              stroke="currentColor"
              strokeWidth={STROKE.like.width}
            />
          ) : (
            <circle
              key={i}
              data-testid="lone-conv"
              cx={pt(run[0]!).x}
              cy={pt(run[0]!).y}
              r="2.5"
              fill="white"
              stroke="currentColor"
              strokeWidth={STROKE.conv.width}
            />
          ),
        )}
      </g>
    );
  };

  const ownShown = on.own && drawn("own");
  return (
    <div ref={box} className="relative" style={{ height: h }}>
      <svg
        role="img"
        aria-label={anyOn ? `Price over time: ${label}` : "Price over time: every line is off"}
        width={w}
        height={h}
        viewBox={`0 0 ${w} ${h}`}
        className="block max-w-full"
      >
        {drawn("conv") && refGroup("conv", model.conv)}
        {drawn("like") && refGroup("like", model.like)}
        {drawn("own") && (
          <g
            data-testid="line-own"
            data-on={ownShown ? "true" : "false"}
            aria-hidden
            className="text-brand-500 motion-reduce:!transition-none"
            style={visibility(ownShown)}
          >
            {model.own.length > 1 && (
              <polyline
                points={poly(model.own)}
                fill="none"
                stroke="currentColor"
                strokeWidth={STROKE.own.width}
                strokeLinejoin="round"
                strokeLinecap="round"
              />
            )}
            {model.own.map((p, i) => (
              <circle
                key={`d${i}`}
                data-testid="own-dot"
                cx={pt(p).x}
                cy={pt(p).y}
                r="2.5"
                fill="currentColor"
              />
            ))}
            {model.own.map(
              (p, i) =>
                p.type &&
                PRICE_TYPE_TAG[p.type] && (
                  <circle
                    key={`m${i}`}
                    data-testid="price-marker"
                    cx={pt(p).x}
                    cy={pt(p).y}
                    r="3.5"
                    fill="none"
                    stroke={p.type === "SPECIAL" ? "#059669" : "#d97706"}
                    strokeWidth="1.5"
                  />
                ),
            )}
          </g>
        )}
      </svg>
      {!anyOn && (
        <p className="absolute inset-0 flex items-center justify-center text-[11px] text-navy/70">
          {NOTE_COPY.turnOn}
        </p>
      )}
    </div>
  );
}

interface ChipSpec {
  id: LineId;
  text: string;
  name: string;
  value: string | null;
  title?: string;
}

function chipSpecs(model: ChartModel): ChipSpec[] {
  const unit = model.unitPhrase;
  const last = (pts: RefPoint[]) => pts[pts.length - 1];
  const likeLast = model.canDraw.like ? last(model.like) : undefined;
  const convLast = model.canDraw.conv ? last(model.conv) : undefined;
  const likeName = likeLast
    ? `Other customers' average, ${unit}, latest ${monthLabel(likeLast.month)}: ${fmt(likeLast.price)}`
    : `Other customers' average, ${unit}`;
  const convName = convLast
    ? `All customers, all units, average per ${unit}, latest ${monthLabel(convLast.month)}: ${fmt(convLast.price)}`
    : `All customers, all units, average per ${unit}`;
  return [
    { id: "own", text: "This customer", name: `This customer's prices, ${unit}`, value: null },
    {
      id: "like",
      text: "Other customers",
      name: likeName,
      value: likeLast ? fmt(likeLast.price) : null,
      title: likeLast ? likeName : undefined,
    },
    {
      id: "conv",
      text: "All units",
      name: convName,
      value: convLast ? fmt(convLast.price) : null,
      title: convLast ? convName : undefined,
    },
  ];
}

export function PriceHistoryChart({
  model,
  on,
  onToggle,
  onRetry,
  neverSold,
}: {
  model: ChartModel;
  /** The viewer's choice per line (all start on); applies once a line can draw. */
  on: Record<LineId, boolean>;
  onToggle: (id: LineId) => void;
  onRetry: () => void;
  neverSold: boolean;
}) {
  const anyDrawable = model.canDraw.own || model.canDraw.like || model.canDraw.conv;
  const anyOn = (["own", "like", "conv"] as const).some((id) => on[id] && model.canDraw[id]);
  const noteFor = (id: LineId) => model.notes.find((n) => n.lines.includes(id))?.id;
  const describedBy = (id: LineId): string | undefined => {
    if (model.canDraw[id]) return undefined;
    if (id === "own") return neverSold ? NOTE_IDS.neverSold : noteFor("own");
    return model.coveredByPanel ? NOTE_IDS.compareMessage : noteFor(id);
  };

  return (
    <div className="space-y-1.5">
      {anyDrawable && <Plot model={model} on={on} anyOn={anyOn} />}
      <div role="group" aria-label="Lines on the chart" className="flex flex-wrap gap-1.5">
        {chipSpecs(model).map((c) => {
          const can = model.canDraw[c.id];
          const pressed = can && on[c.id];
          return (
            <button
              key={c.id}
              type="button"
              data-testid={`chip-${c.id}`}
              aria-label={c.name}
              aria-pressed={pressed}
              aria-disabled={can ? undefined : true}
              aria-describedby={describedBy(c.id)}
              title={c.title}
              onClick={() => {
                if (can) onToggle(c.id);
              }}
              className={cn(
                "relative flex min-h-11 items-center gap-1.5 rounded-full px-2 text-[11px] transition-transform duration-100 ease-out active:scale-[0.97] motion-reduce:transition-none sm:h-7 sm:min-h-0",
                "before:absolute before:inset-x-0 before:-inset-y-2 before:content-[''] sm:before:block",
                pressed
                  ? "bg-white text-navy ring-1 ring-surface-border"
                  : "bg-sunken text-navy/50",
                !can && "cursor-default",
              )}
            >
              <Swatch
                line={c.id}
                className={pressed ? undefined : can ? "opacity-35" : "opacity-20"}
              />
              <span>{c.text}</span>
              {c.value && can && <span className="ml-1 font-mono">{c.value}</span>}
            </button>
          );
        })}
      </div>
      {model.notes.map((n) => (
        <p
          key={n.id}
          id={n.id}
          role={n.role}
          className="text-[11px] text-navy/70"
          data-testid="line-note"
        >
          {n.text}
          {n.retry && (
            <>
              {" "}
              <button
                type="button"
                onClick={onRetry}
                className="font-medium text-brand-600 underline"
              >
                Retry
              </button>
            </>
          )}
        </p>
      ))}
    </div>
  );
}
