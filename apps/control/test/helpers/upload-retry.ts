/**
 * B941. Classifier + retrying client for the "200 concurrent half-sent uploads" memory test.
 *
 * Under machine load some client connects fail for reasons that have nothing to do with the server
 * (no free fd, no ephemeral port, a connect that timed out). Those are retried so `sent === 200`
 * still means "every upload really reached the server". A SERVER refusal is exactly what that test
 * guards, so it is never retried and counts as a failure.
 */
import * as net from "net";

/**
 * Where the upload was when it failed. `connect` = before the TCP connect finished; `pre-write` =
 * connected but no byte accepted by the kernel yet; `mid-upload` = at least one byte was written.
 */
export type UploadPhase = "connect" | "pre-write" | "mid-upload";
export type FailureClass = "retried-client-transient" | "server-refusal" | "other";

const CLIENT_ONLY_CODES = new Set(["EMFILE", "ENFILE", "EADDRINUSE"]);

export function classifyUploadFailure(code: string, phase: UploadPhase): FailureClass {
  if (code === "HTTP_4XX_5XX" || code === "ECONNREFUSED") return "server-refusal";
  if (phase === "mid-upload") return "server-refusal"; // any reset/epipe after bytes were written
  if (CLIENT_ONLY_CODES.has(code)) return "retried-client-transient";
  if (code === "ETIMEDOUT" && phase === "connect") return "retried-client-transient";
  if (code === "ECONNRESET") return "retried-client-transient"; // phase is connect/pre-write here
  return "other";
}

export interface UploadHistogram {
  "retried-client-transient": Record<string, number>;
  "server-refusal": Record<string, number>;
  other: Record<string, number>;
}
export const emptyHistogram = (): UploadHistogram => ({
  "retried-client-transient": {},
  "server-refusal": {},
  other: {},
});

type Attempt = { ok: true; sock: net.Socket } | { ok: false; code: string; phase: UploadPhase };

const attemptOnce = (
  port: number,
  head: string,
  part: Buffer,
  deadlineMs: number,
): Promise<Attempt> =>
  new Promise((resolve) => {
    const s = net.connect(port, "127.0.0.1");
    let phase: UploadPhase = "connect";
    let done = false;
    const end = (r: Attempt): void => {
      if (done) return;
      done = true;
      clearTimeout(t);
      if (!r.ok) s.destroy();
      resolve(r);
    };
    const t = setTimeout(
      () => end({ ok: false, code: phase === "connect" ? "ETIMEDOUT" : "TIMEOUT", phase }),
      deadlineMs,
    );
    s.on("error", (e: NodeJS.ErrnoException) =>
      end({ ok: false, code: e.code ?? "UNKNOWN", phase }),
    );
    // a response while we are still uploading is the server answering: only a 4xx/5xx is a refusal
    s.on("data", (d) => {
      if (/^HTTP\/1\.[01] [45]\d\d/.test(d.toString("latin1", 0, 16)))
        end({ ok: false, code: "HTTP_4XX_5XX", phase });
    });
    s.on("connect", () => {
      phase = "pre-write";
      s.write(head, () => {
        phase = "mid-upload";
      });
      s.write(part, () => end({ ok: true, sock: s }));
    });
  });

/**
 * Connect + half-send one upload. Retries CLIENT-side transient failures up to `retries` times with
 * a short backoff inside a per-socket deadline; everything else is returned as a failure at once.
 * Every failed attempt is recorded in `hist`.
 */
export async function uploadWithRetry(
  port: number,
  head: string,
  part: Buffer,
  hist: UploadHistogram,
  o: { retries?: number; deadlineMs?: number; attemptMs?: number } = {},
): Promise<net.Socket | undefined> {
  const retries = o.retries ?? 3;
  const deadline = Date.now() + (o.deadlineMs ?? 30_000);
  for (let n = 0; n <= retries; n++) {
    const r = await attemptOnce(port, head, part, o.attemptMs ?? 10_000);
    if (r.ok) return r.sock;
    const cls = classifyUploadFailure(r.code, r.phase);
    hist[cls][r.code] = (hist[cls][r.code] ?? 0) + 1;
    if (cls !== "retried-client-transient" || n === retries || Date.now() >= deadline)
      return undefined;
    await new Promise((res) => setTimeout(res, 50 * (n + 1) + Math.floor(Math.random() * 50)));
  }
  return undefined;
}
