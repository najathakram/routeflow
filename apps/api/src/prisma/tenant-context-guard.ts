import { Logger } from "@nestjs/common";
import type { TenantContextKind } from "../tenant/tenant-context.service";
import { lacksTenant } from "./tenant-nested-walker";

/**
 * SA-1105 (F05 slice 1, DARK): what happens when a tenant-owned write carries no tenant, or `forTenant()` /
 * `tenantTransaction()` runs with no tenant scope. ONE home, called by the `forTenant()` extension and by both
 * transaction proxies, so the two layers cannot disagree.
 *
 * Dark: every hit bumps a counter (no sampling, so the 72-hour zero rule counts true zeros), one stack-carrying log
 * line per call site per second, and a summary line every 10 minutes. Nothing throws unless `TENANT_CONTEXT_ENFORCEMENT`
 * is exactly "on", read ONCE at boot; the flag is set nowhere in slice 1. The log never carries args, data or ids.
 *
 * Capture gate (B1285): keyed `kind|model|op|where`, where `where` is the call place: a route's `Controller.handler`
 * (`tenantCtx.label()`), else the name of the scheduled job or queue processor (`common/call-place.ts`, set by
 * `@LeaderCron` and by the two queue processors). So a hot route or job no longer takes the capture slot of another;
 * at most 20 captures per second across all keys. The counter stays keyed `kind|model|op`. Residual: two sites inside the
 * SAME route or the SAME job with the same kind, model and op share one gate; a background entry point that is neither a
 * route, a `@LeaderCron` job nor one of those two processors (a gateway timer, the route-hits flush) is unlabelled and
 * shares one gate per kind, model and op.
 *
 * Detection depth (SA-1110, B929): the one-level detection of SA-1105 A-1 is SUPERSEDED. A nested create is read at EVERY
 * depth and under every write payload (`create`, `upsert.create`, `upsert.update`, `update`, `updateMany`) by the DMMF walker
 * (`tenant-nested-walker.ts`), which also STAMPS the context's tenant under TENANT before the guard looks, so a TENANT gap
 * that reaches the guard is a walker miss. The guard receives the gaps (relation paths, `Model.relation[.relation]`) and
 * counts each as op `nested-create`.
 */
export const TENANT_CONTEXT_ENFORCEMENT_ENV = "TENANT_CONTEXT_ENFORCEMENT";

/** Only the exact string "on" enforces. Unset, "off", "ON " and anything else stay dark (K-9). */
export function readEnforcementFlag(env: NodeJS.ProcessEnv = process.env): boolean {
  return env[TENANT_CONTEXT_ENFORCEMENT_ENV] === "on";
}

export type TenantWriteOp = "create" | "createMany" | "createManyAndReturn" | "upsert";
/** What a check reports on: a write op, a nested create (any depth) under a parent write, or a tenantless access. */
export type TenantCheckOp = TenantWriteOp | "nested-create" | "read";
export type TenantCheck = { ok: true } | { ok: false; reason: string; ops: TenantCheckOp[] };

export class TenantContextMissingError extends Error {
  readonly code = "TENANT_CONTEXT_MISSING";
  constructor(detail: string) {
    super(
      `${detail}. Run the work inside a tenant context, or use the forSystem door with a literal reason for deliberate cross-tenant work.`,
    );
    this.name = "TenantContextMissingError";
  }
}

const asList = (d: unknown): unknown[] => (Array.isArray(d) ? d : [d]);

const CAPTURE_GAP_MS = 1_000;
const SUMMARY_MS = 10 * 60_000;
const STACK_FRAMES = 5;
/** B1285: stack captures across ALL keys per second. Bounds the `new Error().stack` cost now that the gate has more keys. */
const CAPTURES_PER_SECOND = 20;
/** The gate map is bounded by labels (controller handlers and job names); this is the backstop, not the design. */
const GATE_MAP_CAP = 5_000;

/**
 * B1285: the call place is a `Controller.handler` or a job name, never a raw path (no ids in keys or logs). Anything
 * that is not that shape (a `/orders/123` URL, a space, a query string) is dropped to undefined, not redacted: there
 * is one redactor (`redacted-route`), and this guard does not build a second.
 */
const PLACE = /^[A-Za-z0-9_.:-]{1,120}$/;
const safePlace = (where: string | undefined): string | undefined =>
  where !== undefined && PLACE.test(where) ? where : undefined;

export interface GuardOptions {
  enforce: boolean;
  log?: { warn(message: string): void };
  now?: () => number;
  /** The frames of the current call, innermost first. Injected by specs; the default reads `new Error().stack`. */
  frames?: () => string[];
  /** Summary cadence; 0 turns the timer off (specs call `summary()` themselves). */
  summaryMs?: number;
}

function captureFrames(): string[] {
  const prev = Error.stackTraceLimit;
  Error.stackTraceLimit = 40;
  const stack = new Error().stack ?? "";
  Error.stackTraceLimit = prev;
  return stack
    .split("\n")
    .filter((l) => /^\s+at /.test(l))
    .map((l) => l.trim())
    .filter(
      (l) =>
        !l.includes("node_modules") &&
        !l.includes("node:internal") &&
        !l.includes("tenant-context-guard") &&
        !l.includes("prisma.service"),
    );
}

export function createTenantContextGuard(opts: GuardOptions) {
  const log = opts.log ?? new Logger("TenantContext");
  const now = opts.now ?? Date.now;
  const frames = opts.frames ?? captureFrames;
  const counts = new Map<string, number>();
  const lastCapture = new Map<string, number>();
  const lastLog = new Map<string, number>();
  let timer: NodeJS.Timeout | undefined;
  let budgetStart = 0;
  let budgetUsed = 0;

  const summary = (): string | null =>
    counts.size === 0
      ? null
      : `TENANT_CONTEXT_MISSING_SUMMARY ${JSON.stringify(Object.fromEntries(counts))}`;

  function startSummary(): void {
    const every = opts.summaryMs ?? SUMMARY_MS;
    if (timer || every <= 0) return;
    timer = setInterval(() => {
      const line = summary();
      if (line) log.warn(line);
    }, every);
    timer.unref();
  }

  /** Counter on EVERY hit; a stack only when the per-key gate lets one through, then one line per site per second. */
  function record(
    kind: TenantContextKind,
    model: string,
    op: TenantCheckOp,
    where: string | undefined,
  ): void {
    const key = `${kind}|${model}|${op}`;
    counts.set(key, (counts.get(key) ?? 0) + 1);
    if (opts.enforce) {
      throw new TenantContextMissingError(`No tenant on ${kind} ${op} of ${model}`);
    }
    startSummary();
    const t = now();
    const place = safePlace(where);
    const gate = `${key}|${place ?? ""}`;
    const last = lastCapture.get(gate);
    if (last !== undefined && t - last < CAPTURE_GAP_MS) return;
    if (t - budgetStart >= CAPTURE_GAP_MS) {
      budgetStart = t;
      budgetUsed = 0;
    }
    // Over budget: the counter above already counted; this key stays un-gated so its next hit captures.
    if (budgetUsed >= CAPTURES_PER_SECOND) return;
    budgetUsed += 1;
    if (lastCapture.size >= GATE_MAP_CAP) lastCapture.clear();
    lastCapture.set(gate, t);
    const stack = frames();
    const site = `${kind}|${op}|${place ?? ""}|${stack[0] ?? "unknown"}`;
    const logged = lastLog.get(site);
    if (logged !== undefined && t - logged < CAPTURE_GAP_MS) return;
    lastLog.set(site, t);
    log.warn(
      `TENANT_CONTEXT_MISSING kind=${kind} model=${model} op=${op}${place ? ` at=${place}` : ""}\n${stack
        .slice(0, STACK_FRAMES)
        .join("\n")}`,
    );
  }

  /**
   * A tenant-owned write. `data` is the payload the op writes (`args.data`, or `args.create` for an upsert); `gaps` are
   * the nested-create gaps the walker found in it (`findNestedTenantGaps`, relation paths). SYSTEM never reports. Every
   * element of a createMany is read.
   */
  function checkWrite(
    kind: TenantContextKind,
    model: string,
    op: TenantWriteOp,
    data: unknown,
    gaps: readonly string[] = [],
    where?: string,
  ): TenantCheck {
    if (kind === "SYSTEM") return { ok: true };
    const ops: TenantCheckOp[] = [];
    if (asList(data).some(lacksTenant)) ops.push(op);
    if (gaps.length > 0) ops.push("nested-create");
    if (ops.length === 0) return { ok: true };
    if (ops.includes(op)) record(kind, model, op, where);
    for (const gap of gaps) record(kind, gap, "nested-create", where);
    return { ok: false, reason: "TENANT_CONTEXT_MISSING", ops };
  }

  /** Nested-create gaps of a write that has no top-level tenant to check (an update's data). SYSTEM never reports. */
  function checkNested(
    kind: TenantContextKind,
    gaps: readonly string[],
    where?: string,
  ): TenantCheck {
    if (kind === "SYSTEM" || gaps.length === 0) return { ok: true };
    for (const gap of gaps) record(kind, gap, "nested-create", where);
    return { ok: false, reason: "TENANT_CONTEXT_MISSING", ops: ["nested-create"] };
  }

  /**
   * A tenant-owned access with no tenant scope. A SUPER_ADMIN reads unscoped BY DESIGN and SYSTEM is deliberate; the
   * unplanned ones are a request with no tenant (ANONYMOUS) and a job that never entered a context (NONE).
   */
  function checkRead(kind: TenantContextKind, model: string, where?: string): TenantCheck {
    if (kind !== "NONE" && kind !== "ANONYMOUS") return { ok: true };
    record(kind, model, "read", where);
    return { ok: false, reason: "TENANT_CONTEXT_MISSING", ops: ["read"] };
  }

  return {
    checkWrite,
    checkNested,
    checkRead,
    counts: () => Object.fromEntries(counts),
    summary,
    stop: () => {
      if (timer) clearInterval(timer);
      timer = undefined;
    },
  };
}

/** The process guard. Read ONCE at boot (K-9); no environment sets it in slice 1. */
export const TENANT_CONTEXT_ENFORCING = readEnforcementFlag();
const processGuard = createTenantContextGuard({ enforce: TENANT_CONTEXT_ENFORCING });

export const checkTenantWrite = processGuard.checkWrite;
export const checkTenantRead = processGuard.checkRead;
export const checkTenantNested = processGuard.checkNested;
export const tenantContextCounts = processGuard.counts;
