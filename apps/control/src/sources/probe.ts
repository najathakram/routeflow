/**
 * Write-access probe. The dashboard reads two private repos with one read-only token and must
 * refuse to run with a token that can write. `GET <repo>.git/info/refs?service=git-receive-pack`
 * is the smart-HTTP push advertisement: GitHub answers 200 only to a credential that may push,
 * and 403 (or 401/404) otherwise. It is a plain GET: no push, no side effect.
 *
 * Fail closed: anything that is not a clear 200 or a clear 401/403/404 is `unknown`, and the
 * caller refuses to boot on `unknown` after its retries. The token never appears in a return
 * value, a log line or a thrown message (details are status codes or fixed reasons).
 */

export type ProbeResult = "write" | "none" | "unknown";
export interface ProbeOutcome {
  result: ProbeResult;
  /** An HTTP status ("403") or a fixed reason ("timeout", "network error"); never a header. */
  detail: string;
}

export interface ProbeArgs {
  token: string;
  /** `owner/name`. */
  repo: string;
  base?: string;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}

const REPO_RE = /^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/;
const BAD_REPO: ProbeOutcome = { result: "unknown", detail: "bad repository name" };

/** Like `probeWriteAccess`, with the status or reason the boot log prints. */
export async function probeWriteAccessDetailed(args: ProbeArgs): Promise<ProbeOutcome> {
  const { token, repo, timeoutMs = 10_000, fetchImpl = fetch } = args;
  const base = (args.base ?? "https://github.com").replace(/\/+$/, "");
  if (!REPO_RE.test(repo) || repo.split("/").some((p) => p === "." || p === "..")) return BAD_REPO;
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const res = await fetchImpl(`${base}/${repo}.git/info/refs?service=git-receive-pack`, {
      method: "GET",
      headers: {
        authorization: `Basic ${Buffer.from(`x-access-token:${token}`).toString("base64")}`,
      },
      redirect: "manual",
      signal: ctl.signal,
    });
    const status = res.status;
    try {
      await res.body?.cancel();
    } catch {
      /* the status is all we need */
    }
    const detail = String(status);
    if (status === 200) return { result: "write", detail };
    if (status === 401 || status === 403 || status === 404) return { result: "none", detail };
    return { result: "unknown", detail };
  } catch {
    return { result: "unknown", detail: ctl.signal.aborted ? "timeout" : "network error" };
  } finally {
    clearTimeout(timer);
  }
}

/** `write` (HTTP 200), `none` (401, 403, 404) or `unknown` (anything else, an error, a timeout). */
export async function probeWriteAccess(args: ProbeArgs): Promise<ProbeResult> {
  return (await probeWriteAccessDetailed(args)).result;
}

export interface EnforceArgs {
  token: string;
  productRepo: string;
  stateRepo: string;
  /** Test seam; defaults to the real probe. */
  probe?: (a: { token: string; repo: string }) => Promise<ProbeOutcome>;
  sleep?: (ms: number) => Promise<void>;
  /** Called with each `control: probe ...` line. */
  log?: (line: string) => void;
  /** Attempts per repo while the answer is `unknown` (default 3). */
  maxTries?: number;
  /** Wait before attempt 2, 3, ... (default 1 s, 2 s). */
  backoffMs?: number[];
  /** Forwarded to the real probe. */
  base?: string;
  timeoutMs?: number;
}

export type EnforceResult = { ok: true } | { ok: false; message: string };

const realSleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/**
 * Probe the product repo, then the state repo. Refuses (ok:false, message for `die`) when either
 * answers `write`, or stays `unknown` through every try. `none` on both means read-only: go on.
 */
export async function enforceReadOnly(a: EnforceArgs): Promise<EnforceResult> {
  const maxTries = a.maxTries ?? 3;
  const backoff = a.backoffMs ?? [1000, 2000];
  const sleep = a.sleep ?? realSleep;
  const log = a.log ?? ((): void => undefined);
  const probe =
    a.probe ??
    ((x: { token: string; repo: string }): Promise<ProbeOutcome> =>
      probeWriteAccessDetailed({ ...x, base: a.base, timeoutMs: a.timeoutMs }));

  for (const repo of [a.productRepo, a.stateRepo]) {
    let last: ProbeOutcome = { result: "unknown", detail: "not probed" };
    for (let i = 0; i < maxTries; i++) {
      if (i > 0) await sleep(backoff[Math.min(i - 1, backoff.length - 1)] ?? 0);
      try {
        last = await probe({ token: a.token, repo });
      } catch {
        last = { result: "unknown", detail: "probe failed" };
      }
      if (last.result !== "unknown") break;
    }
    if (last.result === "write") {
      log(`control: probe ${repo} -> WRITE access (${last.detail})`);
      return {
        ok: false,
        message: `the token has write access to ${repo}; refusing to start. Use a read-only token (contents:read).`,
      };
    }
    if (last.result === "unknown") {
      log(`control: probe ${repo} -> unknown (${last.detail})`);
      return {
        ok: false,
        message: `could not verify the token is read-only on ${repo} (${last.detail}); refusing to start`,
      };
    }
    log(`control: probe ${repo} -> read-only (${last.detail})`);
  }
  return { ok: true };
}
