import { Logger } from "@nestjs/common";
import type { TenantContextKind } from "../tenant/tenant-context.service";

/**
 * SA-1105 (F05 slice 1, DARK): what happens when a tenant-owned write carries no tenant, or `forTenant()` /
 * `tenantTransaction()` runs with no tenant scope. ONE home, called by the `forTenant()` extension and by both
 * transaction proxies, so the two layers cannot disagree.
 *
 * Dark: every hit bumps a counter (no sampling, so the 72-hour zero rule counts true zeros), one stack-carrying log
 * line per call site per second, and a summary line every 10 minutes. Nothing throws unless `TENANT_CONTEXT_ENFORCEMENT`
 * is exactly "on", read ONCE at boot; the flag is set nowhere in slice 1. The log never carries args, data or ids.
 *
 * Detection depth (SA-1105 A-1): slice 1 detects one level of nested create under `create` and `upsert.create`. A nested
 * create under `update` or `upsert.update` is reported as a read under NONE and ANONYMOUS and is not seen under SUPER_ADMIN or
 * TENANT: it belongs to SA-620's DMMF walker, which checks the child's tenant at every depth.
 */
export const TENANT_CONTEXT_ENFORCEMENT_ENV = "TENANT_CONTEXT_ENFORCEMENT";

/** Only the exact string "on" enforces. Unset, "off", "ON " and anything else stay dark (K-9). */
export function readEnforcementFlag(env: NodeJS.ProcessEnv = process.env): boolean {
  return env[TENANT_CONTEXT_ENFORCEMENT_ENV] === "on";
}

export type TenantWriteOp = "create" | "createMany" | "createManyAndReturn" | "upsert";
/** What a check reports on: a write op, a one-level nested create under a parent write, or a tenantless access. */
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

/** Names the child model of a relation key when it is tenant-owned, else undefined (the DMMF lives with the caller). */
export type RelationTarget = (parentModel: string, relationKey: string) => string | undefined;

/**
 * A row names its tenant by a non-empty `tenantId` or by a `tenant` relation. An absent key, `undefined`, `null` and
 * "" all write NULL (the L-124 class), so they are all "missing". Deliberate platform rows are listed for PR-2 from
 * these warns (SA-1105 Q4), not guessed here.
 */
const lacksTenant = (d: unknown): boolean => {
  if (!d || typeof d !== "object") return true;
  const row = d as { tenantId?: unknown; tenant?: unknown };
  if (row.tenant !== undefined && row.tenant !== null) return false;
  return row.tenantId === undefined || row.tenantId === null || row.tenantId === "";
};

const asList = (d: unknown): unknown[] => (Array.isArray(d) ? d : [d]);

/** One level only: a relation key holding `create` / `createMany` whose child is tenant-owned and names no tenant. */
function nestedCreateGap(parent: string, row: unknown, target: RelationTarget): string | null {
  if (!row || typeof row !== "object") return null;
  for (const [key, value] of Object.entries(row as Record<string, unknown>)) {
    if (!value || typeof value !== "object" || Array.isArray(value)) continue;
    const rel = value as { create?: unknown; createMany?: { data?: unknown } };
    if (rel.create === undefined && rel.createMany === undefined) continue;
    if (!target(parent, key)) continue;
    const children = [
      ...(rel.create === undefined ? [] : asList(rel.create)),
      ...(rel.createMany?.data === undefined ? [] : asList(rel.createMany.data)),
    ];
    if (children.some(lacksTenant)) return key;
  }
  return null;
}

const CAPTURE_GAP_MS = 1_000;
const SUMMARY_MS = 10 * 60_000;
const STACK_FRAMES = 5;

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
    const last = lastCapture.get(key);
    if (last !== undefined && t - last < CAPTURE_GAP_MS) return;
    lastCapture.set(key, t);
    const stack = frames();
    const site = `${kind}|${op}|${stack[0] ?? "unknown"}`;
    const logged = lastLog.get(site);
    if (logged !== undefined && t - logged < CAPTURE_GAP_MS) return;
    lastLog.set(site, t);
    log.warn(
      `TENANT_CONTEXT_MISSING kind=${kind} model=${model} op=${op}${where ? ` at=${where}` : ""}\n${stack
        .slice(0, STACK_FRAMES)
        .join("\n")}`,
    );
  }

  /**
   * A tenant-owned write. `data` is the payload the op writes (`args.data`, or `args.create` for an upsert). SYSTEM
   * never reports. Every element of a createMany is read; a nested create is read one level down.
   */
  function checkWrite(
    kind: TenantContextKind,
    model: string,
    op: TenantWriteOp,
    data: unknown,
    target: RelationTarget = () => undefined,
    where?: string,
  ): TenantCheck {
    if (kind === "SYSTEM") return { ok: true };
    const rows = asList(data);
    const ops: TenantCheckOp[] = [];
    if (rows.some(lacksTenant)) ops.push(op);
    const nested = rows.map((r) => nestedCreateGap(model, r, target)).find((k) => k !== null);
    if (nested) ops.push("nested-create");
    if (ops.length === 0) return { ok: true };
    for (const o of ops)
      record(kind, o === "nested-create" ? `${model}.${nested}` : model, o, where);
    return { ok: false, reason: "TENANT_CONTEXT_MISSING", ops };
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
export const tenantContextCounts = processGuard.counts;
