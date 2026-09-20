/**
 * Guards for the SMTP integration lane (`*.smtp.spec.ts`, run by `npm run local:test:smtp` /
 * `npm run local:validate:features`) — the sibling of `db-spec.ts`. These specs talk to the compose
 * `mailpit` container for real, so:
 *  - a run that cannot reach it FAILS (it never self-skips — a skipped lane reports green with zero
 *    executed tests, the failure mode the lane exists to close);
 *  - a target that is not a local throwaway is refused, so a stray env var can never aim a test
 *    send at a real mailbox.
 */
import { existsSync } from "fs";

const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "::1", "mailpit"]);

export interface SmtpTestTarget {
  host: string;
  port: number;
  user: string;
  pass: string;
  /** Mailpit's HTTP API base, e.g. http://127.0.0.1:8025 */
  apiUrl: string;
}

export function requireLocalSmtp(env: NodeJS.ProcessEnv = process.env): SmtpTestTarget {
  const need = (name: string): string => {
    const v = env[name];
    if (!v) {
      throw new Error(`SMTP specs need ${name} — run them through \`npm run local:test:smtp\``);
    }
    return v;
  };
  const host = need("SMTP_TEST_HOST").replace(/^\[|\]$/g, "");
  const apiUrl = need("MAILPIT_API_URL").replace(/\/+$/, "");
  const apiHost = new URL(apiUrl).hostname.replace(/^\[|\]$/g, "");
  for (const h of [host, apiHost]) {
    if (!LOCAL_HOSTS.has(h)) {
      throw new Error(
        `Refusing to run SMTP specs against non-local host ${h} (allowed: ${[...LOCAL_HOSTS].join(", ")})`,
      );
    }
  }
  const port = Number(need("SMTP_TEST_PORT"));
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`SMTP_TEST_PORT must be a TCP port, got "${env.SMTP_TEST_PORT}"`);
  }
  // Node silently ignores a missing extra-CA file, which would surface as a misleading
  // "self-signed certificate" send failure — so check the file is really there.
  if (!env.NODE_EXTRA_CA_CERTS || !existsSync(env.NODE_EXTRA_CA_CERTS)) {
    // Mailpit serves a throwaway self-signed cert; the spec must TRUST it (verification stays on),
    // never disable verification — see docker/mailpit-tls/README.md.
    throw new Error(
      "SMTP specs need NODE_EXTRA_CA_CERTS pointing at an existing docker/mailpit-tls/cert.pem",
    );
  }
  return {
    host,
    port,
    user: need("SMTP_TEST_USER"),
    pass: need("SMTP_TEST_PASS"),
    apiUrl,
  };
}

export function describeSmtp(name: string, fn: () => void): void {
  if (!process.env.RUN_SMTP_SPECS) {
    throw new Error(
      "SMTP specs invoked without RUN_SMTP_SPECS — run them through npm run local:test:smtp",
    );
  }
  describe(name, fn);
}
