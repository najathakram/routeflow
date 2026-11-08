/**
 * The live-target guard for owner-run READ-ONLY census scripts: a loopback target needs no flag; any other host is
 * refused BEFORE connecting unless `--target-host=<host>` names exactly the host the URL resolves to (exit 64 when the
 * flag is missing, 65 on a mismatch). Pure. Same two-step flow as report-sa1091-order-bound-census.mjs.
 */
export const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "::1", "[::1]"]);

/** Host of a postgres URL. Never the credentials. */
export function hostOf(url) {
  return new URL(url).hostname;
}

/** Pull `--target-host=<host>` out of argv: `{ targetHost, rest }`, or `{ error }` when given twice or empty. */
export function takeTargetHost(argv) {
  const flags = argv.filter((a) => a.startsWith("--target-host="));
  if (flags.length > 1) return { error: "--target-host given more than once" };
  const targetHost = flags.length ? flags[0].slice("--target-host=".length) : null;
  if (flags.length && !targetHost) return { error: "--target-host needs a host" };
  return { targetHost, rest: argv.filter((a) => !a.startsWith("--target-host=")) };
}

export function guardTargetHost(targetHost, host) {
  if (!targetHost && LOOPBACK_HOSTS.has(host)) return { ok: true };
  if (!targetHost)
    return {
      ok: false,
      code: 64,
      message: "refusing: --target-host=<host> is required (run once without it to see the host)",
    };
  if (targetHost !== host)
    return {
      ok: false,
      code: 65,
      message: `refusing: --target-host=${targetHost} does not match the resolved host ${host}`,
    };
  return { ok: true };
}
